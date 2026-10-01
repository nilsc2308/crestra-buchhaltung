// crestra Buchhaltung – Bankanbindung über Enable Banking (EU-Kontoschnittstelle PSD2, nur Lesezugriff).
// Läuft als Supabase Edge Function. Der private Schlüssel liegt nur hier als Secret (EB_PRIVATE_KEY), nie im Browser.
// Aktionen (POST, JSON): banken | start | abschluss | abruf | trennen
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.enablebanking.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- Anmeldung bei Enable Banking: JWT mit RS256 ----------
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function ebToken(): Promise<string> {
  const appId = Deno.env.get("EB_APP_ID")!;
  const pem = Deno.env.get("EB_PRIVATE_KEY")!.replace(/\\n/g, "\n");
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = `${enc({ typ: "JWT", alg: "RS256", kid: appId })}.${enc({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}
async function eb(path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${await ebToken()}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  let body: any; try { body = JSON.parse(t); } catch { body = { text: t }; }
  if (!r.ok) throw new Error(`Enable Banking ${r.status}: ${body.message || body.detail || t.slice(0, 200)}`);
  return body;
}

// ---------- Umsätze in das Buchungsformat der App bringen ----------
function buchung(t: any, konto: any) {
  const betrag = Math.round(parseFloat(t.transaction_amount?.amount || "0") * 100) * (t.credit_debit_indicator === "DBIT" ? -1 : 1);
  const gegen = (t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name) || t.creditor?.name || t.debtor?.name || "";
  const zweck = [].concat(t.remittance_information || []).join(" ").trim();
  const datum = t.booking_date || t.value_date || t.transaction_date || "";
  const ref = t.entry_reference || t.transaction_id || `${datum}|${betrag}|${gegen}|${zweck}`.slice(0, 180);
  return {
    id: "eb-" + ref.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
    data: { datum, betrag, gegenpartei: gegen, zweck, quelle: "bank", konto: konto.iban || konto.uid, status: t.status === "PDNG" ? "vorgemerkt" : "gebucht" },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ fehler: "Nicht angemeldet" }, 401);
    if (!Deno.env.get("EB_APP_ID") || !Deno.env.get("EB_PRIVATE_KEY")) {
      return json({ eingerichtet: false, hinweis: "Der Bankzugang ist noch nicht eingerichtet (Enable-Banking-App fehlt)." });
    }
    const body = await req.json().catch(() => ({}));
    const bankDoc = async () => (await sb.from("docs").select("data").eq("collection", "buchhaltung").eq("id", "bank").maybeSingle()).data?.data || {};
    const saveBank = (patch: unknown) => sb.rpc("doc_merge", { p_collection: "buchhaltung", p_id: "bank", p_patch: patch });

    switch (body.action) {
      case "banken": {
        const r = await eb(`/aspsps?country=${body.land || "DE"}&psu_type=business`);
        return json({ eingerichtet: true, banken: (r.aspsps || []).map((a: any) => ({ name: a.name, land: a.country, logo: a.logo })) });
      }
      case "start": {
        const bis = new Date(Date.now() + 89 * 864e5).toISOString();
        const r = await eb("/auth", { method: "POST", body: JSON.stringify({
          access: { valid_until: bis }, aspsp: { name: body.bank, country: body.land || "DE" },
          state: crypto.randomUUID(), redirect_url: body.zurueck, psu_type: "business",
        }) });
        return json({ url: r.url });
      }
      case "abschluss": {
        const s = await eb("/sessions", { method: "POST", body: JSON.stringify({ code: body.code }) });
        const konten = (s.accounts || []).map((a: any) => ({ uid: a.uid, iban: a.account_id?.iban || "", name: a.name || a.product || "", waehrung: a.currency }));
        await saveBank({ session: s.session_id, bank: s.aspsp?.name || body.bank || "", konten, gueltigBis: s.access?.valid_until || null, verbunden: new Date().toISOString() });
        return json({ ok: true, konten });
      }
      case "abruf": {
        const b = await bankDoc();
        if (!b.konten?.length) return json({ fehler: "Kein Konto verbunden" }, 400);
        const von = body.von || b.letzterAbruf?.slice(0, 10) || new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
        const vonMinus = new Date(new Date(von).getTime() - 10 * 864e5).toISOString().slice(0, 10);
        let neu = 0, gesamt = 0; const salden: Record<string, number> = {};
        for (const k of b.konten) {
          let cont: string | undefined;
          do {
            const q = new URLSearchParams({ date_from: vonMinus, ...(cont ? { continuation_key: cont } : {}) });
            const r = await eb(`/accounts/${k.uid}/transactions?${q}`);
            for (const t of r.transactions || []) {
              const x = buchung(t, k); gesamt++;
              const { data: alt } = await sb.from("docs").select("id").eq("collection", "buchungen").eq("id", x.id).maybeSingle();
              if (!alt) neu++;
              // nur die Bankfelder setzen – Kategorie, Beleg, Notiz der App bleiben erhalten
              await sb.rpc("doc_merge", { p_collection: "buchungen", p_id: x.id, p_patch: alt ? x.data : { ...x.data, erfasst: new Date().toISOString() } });
            }
            cont = r.continuation_key || undefined;
          } while (cont);
          try {
            const bal = await eb(`/accounts/${k.uid}/balances`);
            const best = (bal.balances || []).find((x: any) => /CLBD|ITBD|XPCD|ITAV|CLAV/.test(x.balance_type)) || (bal.balances || [])[0];
            if (best) salden[k.iban || k.uid] = Math.round(parseFloat(best.balance_amount.amount) * 100);
          } catch { /* Saldo optional */ }
        }
        await saveBank({ letzterAbruf: new Date().toISOString(), salden });
        return json({ ok: true, neu, gesamt, salden });
      }
      case "trennen": {
        const b = await bankDoc();
        if (b.session) { try { await eb(`/sessions/${b.session}`, { method: "DELETE" }); } catch { /* schon abgelaufen */ } }
        await saveBank({ session: null, konten: [], gueltigBis: null });
        return json({ ok: true });
      }
      default:
        return json({ eingerichtet: true });
    }
  } catch (e) {
    return json({ fehler: String((e as Error).message || e) }, 500);
  }
});
