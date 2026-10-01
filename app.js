// crestra Buchhaltung – Einnahmen/Ausgaben, Rechnungen (Kleinunternehmer § 19 UStG), Belege, EÜR.
// Daten: Supabase-Tabelle „docs“ (über db.js), Belege im privaten Speicher „belege“, Bank über die Edge Function „bank“.
// Geldbeträge sind immer ganze Cent (Ganzzahlen), Datumswerte „JJJJ-MM-TT“.

/* ================= Hilfen ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const eur = (c) => EUR.format((c || 0) / 100);
const eurPlain = (c) => ((c || 0) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, "0");
const iso = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const heute = () => iso();
const fmtD = (s) => (s && /^\d{4}-\d\d-\d\d/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : "");
const plusTage = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const monatName = (ym) => `${MONATE[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const letzterTag = (ym) => iso(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9äöüß]/g, "");

// „1.234,56“, „-12,5“, „1234.56“, „1,234.56“, „12 €“ → Cent
function parseEuro(v) {
  let s = String(v ?? "").trim().replace(/[€\s ]|EUR/g, "");
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? NaN : Math.round(n * 100) * (neg ? -1 : 1);
}
// „31.12.2025“, „31.12.25“, „2025-12-31“, „2025-12-31T…“, „31/12/2025“ → „2025-12-31“
function parseDatum(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  // „1. Okt. 2026 11:21“, „24. Sept. 2026“, „3 Jul 2026“ (z. B. Tide)
  m = s.match(/^(\d{1,2})\.?\s*([A-Za-zäÄ]+)\.?\s+(\d{4})/);
  if (m) { const mon = MON_KURZ.findIndex((x) => x.test(m[2].toLowerCase())); if (mon >= 0) return `${m[3]}-${pad(mon + 1)}-${pad(m[1])}`; }
  return "";
}
const MON_KURZ = [/^jan/, /^feb/, /^(mär|mar|mrz)/, /^apr/, /^(mai|may)/, /^jun/, /^jul/, /^aug/, /^sep/, /^(okt|oct)/, /^nov/, /^(dez|dec)/];
function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

/* ================= Kategorien (EÜR für Kleinunternehmer) ================= */
// t: e = Betriebseinnahme, a = Betriebsausgabe, n = neutral (zählt nicht zum Gewinn)
const KAT = [
  { id: "umsatz", name: "Umsatzerlöse", t: "e" },
  { id: "sonstigeE", name: "Sonstige Einnahmen", t: "e" },
  { id: "fremd", name: "Fremdleistungen & Provisionen", t: "a" },
  { id: "software", name: "Software, Hosting & Domains", t: "a" },
  { id: "werbung", name: "Werbung & Marketing", t: "a" },
  { id: "telefon", name: "Telefon & Internet", t: "a" },
  { id: "buero", name: "Bürobedarf & Porto", t: "a" },
  { id: "gwg", name: "Geräte bis 800 € (GWG)", t: "a" },
  { id: "fahrt", name: "Fahrtkosten", t: "a" },
  { id: "reise", name: "Reisekosten", t: "a" },
  { id: "bewirtung", name: "Bewirtung (70 % absetzbar)", t: "a", faktor: 0.7 },
  { id: "fortbildung", name: "Fortbildung & Fachliteratur", t: "a" },
  { id: "versicherung", name: "Versicherungen & Beiträge", t: "a" },
  { id: "raum", name: "Raumkosten", t: "a" },
  { id: "gebuehren", name: "Kontoführung & Gebühren", t: "a" },
  { id: "sonstigeA", name: "Sonstige Ausgaben", t: "a" },
  { id: "privatein", name: "Privateinlage", t: "n" },
  { id: "privatent", name: "Privatentnahme", t: "n" },
  { id: "steuer", name: "Steuerzahlung (privat)", t: "n" },
  { id: "umbuchung", name: "Umbuchung zwischen Konten", t: "n" },
];
const KATM = Object.fromEntries(KAT.map((k) => [k.id, k]));
const passt = (k, betrag) => k && (k.t === "n" || (k.t === "e" ? betrag > 0 : betrag < 0));
// Vorschläge nach Stichwort – müssen bestätigt werden
const RATEN = [
  [/github|netlify|supabase|vercel|hetzner|ionos|strato|all-inkl|namecheap|godaddy|cloudflare|openai|anthropic|claude|google ?workspace|google ?cloud|adobe|figma|notion|canva|microsoft|apple\.com|icloud|dropbox|lovable|framer|webflow|squarespace|wix/i, "software"],
  [/telekom|vodafone|o2 |telefonica|1&1|congstar|fraenk|freenet/i, "telefon"],
  [/deutsche bahn|db vertrieb|db fernverkehr|aral|shell|esso|jet tankstelle|total ?energies|tankstelle|flixbus|uber|bolt|parken|parkhaus|apcoa/i, "fahrt"],
  [/meta platforms|facebook|google ads|linkedin|instagram|vistaprint|flyeralarm/i, "werbung"],
  [/deutsche post|dhl|amazon|staples|viking|otto office/i, "buero"],
  [/kontoführung|kontofuehrung|entgelt|gebühr|gebuehr|monthly fee|subscription fee|qonto|kontist|holvi|n26/i, "gebuehren"],
  [/finanzamt|steuerverwaltung/i, "steuer"],
  [/ihk|handwerkskammer|berufsgenossenschaft|versicherung|haftpflicht|allianz|hiscox|exali/i, "versicherung"],
  [/restaurant|ristorante|pizzeria|café|cafe |bistro|gastro/i, "bewirtung"],
];

/* ================= Zustand ================= */
const S = { buchungen: [], rechnungen: [], belege: [], sites: [], vertriebler: [], provisionen: [], einst: {}, bank: {}, geladen: new Set() };
let db, SB, UID;
const F = { suche: "", filter: "alle", jahr: new Date().getFullYear(), rFilter: "alle", bFilter: "offen" };

const einst = () => S.einst || {};
const firmaKomplett = () => { const e = einst(); return !!(e.firma && e.strasse && e.plzOrt && e.steuernummer && e.iban); };
const sichtbar = () => S.buchungen.filter((b) => !b.ignoriert);
function regel(b) {
  const txt = `${b.gegenpartei || ""} ${b.zweck || ""}`.toLowerCase();
  for (const r of einst().regeln || []) if (r.muster && txt.includes(r.muster.toLowerCase()) && passt(KATM[r.kategorie], b.betrag)) return r.kategorie;
  return "";
}
const katVon = (b) => b.kategorie || regel(b) || "";
function raten(b) {
  if (b.betrag > 0) {
    if (rechnungZu(b)) return "umsatz";
    const txt = norm(`${b.gegenpartei} ${b.zweck}`), ich = norm(einst().inhaber || "Nils Cremerius");
    if (ich.length > 4 && norm(b.gegenpartei).includes(ich)) return "privatein";
    if (S.sites.some((s) => { const w = norm(String(s.name || "").split(/\s+/)[0]); return w.length >= 4 && txt.includes(w); })) return "umsatz";
    return "";
  }
  const txt = `${b.gegenpartei || ""} ${b.zweck || ""}`;
  if (S.vertriebler.some((v) => { const n = norm(v.name); return n.length > 4 && norm(txt).includes(n); })) return "fremd";
  for (const [re, k] of RATEN) if (re.test(txt)) return k;
  return "";
}
const belegeZu = (id) => S.belege.filter((x) => x.buchung === id);
const brauchtBeleg = (b) => { const k = KATM[katVon(b)]; return b.betrag < 0 && !b.ohneBeleg && !(k && k.t === "n") && !belegeZu(b.id).length; };
const summe = (r) => (r.positionen || []).reduce((s, p) => s + Math.round((+p.menge || 0) * (p.preis || 0)), 0);
const faelligAm = (r) => plusTage(r.datum || heute(), +(r.zahlungsziel ?? einst().zahlungsziel ?? 14));
const ueberfaellig = (r) => r.status === "offen" && faelligAm(r) < heute();
function rechnungZu(b) {
  if (b.rechnung) return S.rechnungen.find((r) => r.id === b.rechnung);
  if (!(b.betrag > 0)) return null;
  const txt = norm(`${b.zweck} ${b.gegenpartei}`);
  const offen = S.rechnungen.filter((r) => r.status === "offen" && summe(r) === b.betrag);
  return offen.find((r) => r.nummer && txt.includes(norm(r.nummer))) || offen.find((r) => { const n = norm(r.kunde?.name).slice(0, 8); return n.length > 3 && txt.includes(n); }) || null;
}
function naechsteNummer(jahr) {
  const re = new RegExp(`^RE-${jahr}-(\\d+)$`);
  const max = S.rechnungen.reduce((m, r) => { const x = (r.nummer || "").match(re); return x ? Math.max(m, +x[1]) : m; }, 0);
  return `RE-${jahr}-${String(max + 1).padStart(4, "0")}`;
}
function kontostand() {
  const sal = S.bank.salden && Object.values(S.bank.salden);
  if (sal && sal.length && S.bank.konten?.length) return { wert: sal.reduce((a, b) => a + b, 0), quelle: "Bank, " + (S.bank.letzterAbruf ? "Stand " + new Date(S.bank.letzterAbruf).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "") };
  const e = einst(); const ab = e.anfangsdatum || "0000";
  const w = (e.anfangssaldo || 0) + sichtbar().filter((b) => b.datum >= ab && b.konto !== "bar" && b.konto !== "privat").reduce((s, b) => s + b.betrag, 0);
  return { wert: w, quelle: e.anfangsdatum ? `berechnet ab ${fmtD(e.anfangsdatum)}` : "berechnet aus allen Umsätzen" };
}
function jahresZahlen(jahr) {
  const out = { e: 0, a: 0, umsatz: 0, kat: {}, monate: Array.from({ length: 12 }, () => ({ e: 0, a: 0 })) };
  for (const b of sichtbar()) {
    if (!(b.datum || "").startsWith(String(jahr))) continue;
    const k = KATM[katVon(b)];
    if (!k || k.t === "n" || !passt(k, b.betrag)) continue;
    const wert = Math.abs(b.betrag), abz = Math.round(wert * (k.faktor || 1));
    out.kat[k.id] = out.kat[k.id] || { brutto: 0, wert: 0, n: 0 };
    out.kat[k.id].brutto += wert; out.kat[k.id].wert += abz; out.kat[k.id].n++;
    const m = +b.datum.slice(5, 7) - 1;
    if (k.t === "e") { out.e += abz; out.monate[m].e += abz; if (k.id === "umsatz") out.umsatz += wert; } else { out.a += abz; out.monate[m].a += abz; }
  }
  return out;
}

/* ================= Oberfläche: Blatt, Meldung ================= */
function toast(t, ms = 2600) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms); }
let sheetClose = null;
function sheet(html, mount) {
  $("#sheetBody").innerHTML = html; $("#sheet").hidden = false; document.body.style.overflow = "hidden";
  sheetClose = mount ? mount($("#sheetBody")) : null;
  const f = $("#sheetBody [autofocus]"); if (f && matchMedia("(pointer:fine)").matches) f.focus();
}
function closeSheet() { $("#sheet").hidden = true; document.body.style.overflow = ""; $("#sheetBody").innerHTML = ""; if (typeof sheetClose === "function") sheetClose(); sheetClose = null; render(); }
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });
const katOptions = (sel, betrag, leer = "– Kategorie –") =>
  `<option value="">${leer}</option>` + ["e", "a", "n"].map((t) => `<optgroup label="${{ e: "Einnahmen", a: "Ausgaben", n: "Neutral (kein Gewinn)" }[t]}">` +
    KAT.filter((k) => k.t === t && (betrag === undefined || passt(k, betrag))).map((k) => `<option value="${k.id}"${k.id === sel ? " selected" : ""}>${esc(k.name)}</option>`).join("") + "</optgroup>").join("");
async function speichern(pfad, patch, meldung) {
  try { await db.doc(pfad).update(patch); if (meldung) toast(meldung); } catch (e) { console.error(e); toast("Speichern fehlgeschlagen – bitte nochmal versuchen."); }
}

/* ================= Router ================= */
const TITEL = { uebersicht: "Überblick", umsaetze: "Umsätze", rechnungen: "Rechnungen", rechnung: "Rechnung", belege: "Belege", auswertung: "Auswertung", einstellungen: "Einstellungen", mehr: "Mehr", vertrieb: "Vertrieb", gutschrift: "Gutschrift" };
const teil = () => { const [n, a] = (location.hash.slice(1) || "uebersicht").split("/"); return [TITEL[n] ? n : "uebersicht", a ? decodeURIComponent(a) : ""]; };
let renderWartet = false;
function render() {
  const view = $("#view"); if (!view || !db) return;
  const a = document.activeElement;
  if (a && view.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== "file" && a.type !== "checkbox") { renderWartet = true; return; }
  renderWartet = false;
  const [name, arg] = teil();
  $$("[data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === name || (name === "rechnung" && x.dataset.tab === "rechnungen") || (name === "gutschrift" && x.dataset.tab === "vertrieb") || (["auswertung", "einstellungen", "vertrieb", "gutschrift"].includes(name) && x.dataset.tab === "mehr")));
  document.title = `${TITEL[name]} · crestra Buchhaltung`;
  if (name === "rechnung") return renderRechnung(arg);
  if (name === "gutschrift") { ED = null; return renderGutschrift(arg); }
  ED = null;
  view.innerHTML = VIEWS[name]();
  VIEWS[name + "Mount"]?.(view);
}
document.addEventListener("focusout", () => setTimeout(() => { if (renderWartet) render(); }, 30));
addEventListener("hashchange", () => { ED = null; render(); scrollTo(0, 0); });

/* ================= Überblick ================= */
function aufgaben() {
  const v = sichtbar(), out = [];
  const ohneKat = v.filter((b) => !katVon(b)).length;
  const ohneBeleg = v.filter(brauchtBeleg).length;
  const ueber = S.rechnungen.filter(ueberfaellig).length;
  const prov = S.provisionen.filter((x) => x.status !== "bezahlt").length;
  const offeneBelege = S.belege.filter((x) => !x.buchung).length;
  if (!firmaKomplett()) out.push(["#einstellungen", "Firmendaten für Rechnungen ergänzen", "!"]);
  if (prov) out.push(["#vertrieb", "Provisionen noch nicht ausgezahlt", prov]);
  if (ueber) out.push(["#rechnungen/ueberfaellig", "Rechnungen überfällig", ueber]);
  if (ohneKat) out.push(["#umsaetze/ohne-kategorie", "Umsätze ohne Kategorie", ohneKat]);
  if (ohneBeleg) out.push(["#umsaetze/ohne-beleg", "Ausgaben ohne Beleg", ohneBeleg]);
  if (offeneBelege) out.push(["#belege", "Belege noch keinem Umsatz zugeordnet", offeneBelege]);
  if (!S.bank.konten?.length) {
    const letzter = S.buchungen.filter((x) => x.quelle === "csv").map((x) => x.erfasst || "").sort().pop();
    const tage = letzter ? Math.floor((Date.now() - new Date(letzter)) / 864e5) : null;
    if (tage === null || tage >= 7) out.unshift(["#einstellungen", tage === null ? "Tide-Umsätze zum ersten Mal importieren" : `Tide-Umsätze importieren (letzter Import vor ${tage} Tagen)`, "↓"]);
  }
  if (S.bank.gueltigBis) { const t = Math.round((new Date(S.bank.gueltigBis) - Date.now()) / 864e5); if (t < 10) out.push(["#einstellungen", t < 0 ? "Bankfreigabe abgelaufen – neu verbinden" : `Bankfreigabe läuft in ${t} Tagen ab`, "!"]); }
  return out;
}
const VIEWS = {};
VIEWS.uebersicht = () => {
  const j = new Date().getFullYear(), z = jahresZahlen(j), vj = jahresZahlen(j - 1), ks = kontostand();
  const offen = S.rechnungen.filter((r) => r.status === "offen"), offenSumme = offen.reduce((s, r) => s + summe(r), 0);
  const max = Math.max(1, ...z.monate.map((m) => Math.max(m.e, m.a)));
  const meter = (wert, grenze) => { const p = Math.min(100, (wert / grenze) * 100); return `<div class="meter ${p >= 100 ? "over" : p >= 80 ? "warn" : ""}"><i style="width:${p.toFixed(1)}%"></i></div>`; };
  const todo = aufgaben();
  const neueste = sichtbar().sort((a, b) => (b.datum || "").localeCompare(a.datum || "")).slice(0, 6);
  return `
  <div class="hero">
    <div><div class="lbl">Kontostand</div><div class="big">${eur(ks.wert)}</div><div class="sub">${esc(ks.quelle)}</div></div>
    <div class="kpis">
      <div><span class="lbl">Einnahmen ${j}</span><b>${eur(z.e)}</b></div>
      <div><span class="lbl">Ausgaben ${j}</span><b>${eur(z.a)}</b></div>
      <div><span class="lbl">Gewinn ${j}</span><b>${eur(z.e - z.a)}</b></div>
    </div>
  </div>
  <div class="grid g2">
    <section class="card">
      <h2>Zu erledigen</h2>
      ${todo.length ? `<div class="todo">${todo.map(([h, t, n]) => `<a href="${h}"><span>${esc(t)}</span><b>${n}</b></a>`).join("")}</div>` : `<p class="muted">Alles erledigt. Jeder Umsatz hat eine Kategorie und jede Ausgabe einen Beleg.</p>`}
    </section>
    <section class="card">
      <h2>Kleinunternehmer-Grenzen</h2>
      <p class="small muted" style="margin:0 0 10px">Umsatz nach Zahlungseingang. Seit 2025 gilt: Vorjahr höchstens 25.000 €, laufendes Jahr höchstens 100.000 € (§ 19 UStG).</p>
      <div class="stat"><span>${j} bisher</span><strong>${eur(z.umsatz)}</strong></div>
      ${meter(z.umsatz, 2500000)}<div class="small muted">${eur(Math.max(0, 2500000 - z.umsatz))} bis 25.000 € – wird das überschritten, entfällt die Regel ab ${j + 1}.</div>
      ${meter(z.umsatz, 10000000)}<div class="small muted">${eur(Math.max(0, 10000000 - z.umsatz))} bis 100.000 € – darüber endet sie sofort.</div>
      <div class="small muted" style="margin-top:8px">Vorjahr ${j - 1}: ${eur(vj.umsatz)} ${vj.umsatz > 2500000 ? '<span class="badge red">über 25.000 €</span>' : '<span class="badge green">unter 25.000 €</span>'}</div>
    </section>
    <section class="card">
      <div class="head" style="margin:0"><h2 style="margin:0">Offene Rechnungen</h2><a href="#rechnungen" class="small">alle</a></div>
      <div class="stat" style="margin:10px 0"><strong>${eur(offenSumme)}</strong><span>${offen.length} offen${offen.filter(ueberfaellig).length ? `, davon ${offen.filter(ueberfaellig).length} überfällig` : ""}</span></div>
      ${offen.slice(0, 4).map((r) => `<a class="it" href="#rechnung/${r.id}" style="grid-template-columns:minmax(0,1fr) auto;grid-template-areas:none;padding:9px 0;color:inherit;text-decoration:none"><span class="t"><b>${esc(r.kunde?.name || "–")}</b><span>${esc(r.nummer)} · fällig ${fmtD(faelligAm(r))}</span></span><span class="m">${eur(summe(r))}</span></a>`).join("")}
    </section>
    <section class="card">
      <h2>${j} nach Monaten</h2>
      <div class="bars" aria-label="Einnahmen und Ausgaben je Monat">${z.monate.map((m, i) => `<div class="b" title="${MONATE[i]}: Einnahmen ${eur(m.e)}, Ausgaben ${eur(m.a)}"><div><i class="e" style="height:${(m.e / max) * 100}%"></i><i class="a" style="height:${(m.a / max) * 100}%"></i></div><span>${MONATE[i].slice(0, 1)}</span></div>`).join("")}</div>
      <div class="small muted" style="margin-top:8px"><span class="plus">■</span> Einnahmen &nbsp; <span style="color:var(--line-2)">■</span> Ausgaben</div>
    </section>
  </div>
  <section style="margin-top:14px">
    <div class="head"><h2 style="margin:0">Letzte Umsätze</h2><a href="#umsaetze" class="small">alle</a></div>
    <div class="list">${neueste.length ? neueste.map(zeile).join("") : leerUmsaetze()}</div>
  </section>`;
};
const leerUmsaetze = () => `<div class="empty">Noch keine Umsätze. Verbinde dein Konto unter <a href="#einstellungen">Einstellungen</a> oder <button class="linkish" data-act="csv">importiere eine CSV-Datei</button> aus dem Online-Banking.</div>`;

/* ================= Umsätze ================= */
function zeile(b) {
  const k = katVon(b), r = raten(b), bel = belegeZu(b.id).length, re = b.rechnung && S.rechnungen.find((x) => x.id === b.rechnung);
  const wahl = k || "";
  return `<div class="it" data-buchung="${esc(b.id)}">
    <div class="d">${fmtD(b.datum)}</div>
    <div class="t"><b>${esc(b.gegenpartei || "(ohne Namen)")}</b><span><i class="dm">${fmtD(b.datum)}${b.zweck ? " · " : ""}</i>${esc(b.zweck || "")}${re ? ` · ${esc(re.nummer)}` : ""}${b.status === "vorgemerkt" ? " · vorgemerkt" : ""}${b.konto === "bar" ? " · bar" : b.konto === "privat" ? " · privat bezahlt" : ""}</span></div>
    <div class="m ${b.betrag > 0 ? "plus" : "minus"}">${b.betrag > 0 ? "+" : ""}${eur(b.betrag)}</div>
    <div class="x">
      <select class="in" data-kat="${esc(b.id)}" aria-label="Kategorie">${katOptions(wahl, b.betrag, r && !k ? `Vorschlag: ${KATM[r].name}` : "– Kategorie –")}</select>
      ${r && !k ? `<button class="btn btn--small" data-ok="${esc(b.id)}" data-k="${r}" title="Vorschlag übernehmen">✓</button>` : ""}
      <span class="clip ${bel ? "on" : ""}" title="${bel ? bel + " Beleg(e)" : b.betrag < 0 ? "Beleg fehlt" : ""}">${b.betrag < 0 || bel ? "📎" : ""}</span>
    </div>
  </div>`;
}
VIEWS.umsaetze = () => {
  const [, arg] = teil(); if (arg) F.filter = arg;
  const q = F.suche.toLowerCase();
  let rows = sichtbar().filter((b) => !q || `${b.gegenpartei} ${b.zweck} ${eurPlain(b.betrag)} ${b.notiz || ""}`.toLowerCase().includes(q));
  rows = rows.filter((b) => ({ alle: true, ein: b.betrag > 0, aus: b.betrag < 0, "ohne-kategorie": !katVon(b), "ohne-beleg": brauchtBeleg(b) }[F.filter] ?? true));
  rows.sort((a, b) => (b.datum || "").localeCompare(a.datum || "") || (b.erfasst || "").localeCompare(a.erfasst || ""));
  const n = (f) => sichtbar().filter((b) => ({ "ohne-kategorie": !katVon(b), "ohne-beleg": brauchtBeleg(b) }[f])).length;
  let html = "", mon = "";
  for (const b of rows.slice(0, 600)) {
    const m = (b.datum || "").slice(0, 7);
    if (m !== mon) { mon = m; const s = rows.filter((x) => (x.datum || "").startsWith(m)).reduce((a, x) => a + x.betrag, 0); html += `<div class="month"><span>${m ? monatName(m) : "Ohne Datum"}</span><span class="mono">${s > 0 ? "+" : ""}${eur(s)}</span></div>`; }
    html += zeile(b);
  }
  return `
  <div class="head"><h1>Umsätze</h1>
    <div class="btns no-print">
      ${S.bank.konten?.length ? `<button class="btn" data-act="abruf">↻ Bank abrufen</button>` : ""}
      <button class="btn" data-act="csv">CSV importieren</button>
      <button class="btn btn--primary" data-act="neu-buchung">+ Eintragen</button>
    </div></div>
  <div class="toolbar">
    <input class="in" type="search" id="suche" placeholder="Suchen: Name, Zweck, Betrag …" value="${esc(F.suche)}">
    <div class="chips">${[["alle", "Alle"], ["ein", "Einnahmen"], ["aus", "Ausgaben"], ["ohne-kategorie", `Ohne Kategorie (${n("ohne-kategorie")})`], ["ohne-beleg", `Ohne Beleg (${n("ohne-beleg")})`]].map(([k, t]) => `<button class="chip ${F.filter === k ? "on" : ""}" data-filter="${k}">${t}</button>`).join("")}</div>
  </div>
  <div class="list">${rows.length ? html : sichtbar().length ? `<div class="empty">Nichts gefunden.</div>` : leerUmsaetze()}</div>
  ${rows.length > 600 ? `<p class="muted small">Die ersten 600 von ${rows.length} werden angezeigt – Suche oder Filter grenzen ein.</p>` : ""}`;
};
VIEWS.umsaetzeMount = (v) => {
  const s = $("#suche", v);
  s.oninput = () => { F.suche = s.value; clearTimeout(s.t); s.t = setTimeout(() => { const pos = s.selectionStart; s.blur(); render(); const n = $("#suche"); n.focus(); n.setSelectionRange(pos, pos); }, 250); };
};
function buchungSheet(id) {
  const b = S.buchungen.find((x) => x.id === id); if (!b) return;
  const k = katVon(b), r = raten(b), bel = belegeZu(id), re = rechnungZu(b);
  const freieBelege = S.belege.filter((x) => !x.buchung);
  const offeneRe = S.rechnungen.filter((x) => x.status === "offen");
  sheet(`
    <h2>${esc(b.gegenpartei || "Umsatz")}</h2>
    <p class="muted" style="margin-top:-4px">${fmtD(b.datum)} · <b class="mono ${b.betrag > 0 ? "plus" : ""}">${b.betrag > 0 ? "+" : ""}${eur(b.betrag)}</b> · ${{ bank: "aus der Bank", csv: "aus CSV-Import", manuell: "von Hand eingetragen" }[b.quelle] || ""}</p>
    ${b.zweck ? `<p class="small" style="background:var(--surface-2);padding:10px 12px;border-radius:10px">${esc(b.zweck)}</p>` : ""}
    <div class="grid" style="gap:12px">
      <label class="f">Kategorie<select id="bKat">${katOptions(k || r, b.betrag)}</select></label>
      ${!k && r ? `<p class="small muted" style="margin:-6px 0 0">Vorschlag – mit „Speichern“ übernehmen.</p>` : ""}
      <label class="f">Notiz<textarea id="bNotiz" placeholder="z. B. Anlass der Bewirtung, Teilnehmer, Projekt">${esc(b.notiz || "")}</textarea></label>
      <label class="f" style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" id="bRegel"> Für alle Umsätze mit „${esc((b.gegenpartei || "").slice(0, 40))}“ diese Kategorie merken</label>
      ${b.betrag > 0 ? `<label class="f">Zugehörige Rechnung<select id="bRe"><option value="">– keine –</option>${[...(re && !offeneRe.includes(re) ? [re] : []), ...offeneRe].map((x) => `<option value="${x.id}"${re && re.id === x.id ? " selected" : ""}>${esc(x.nummer)} · ${esc(x.kunde?.name)} · ${eur(summe(x))}</option>`).join("")}</select></label>${re && !b.rechnung ? `<p class="small muted" style="margin:-6px 0 0">Passt wahrscheinlich zu ${esc(re.nummer)} – mit „Speichern“ wird sie als bezahlt markiert.</p>` : ""}` : ""}
    </div>
    <hr class="sep">
    <h3>Belege</h3>
    ${bel.length ? `<div class="bgrid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">${bel.map(belegKachel).join("")}</div>` : `<p class="muted small">${b.betrag < 0 ? "Noch kein Beleg. Fotografiere die Quittung oder lade die PDF-Rechnung hoch." : "Kein Beleg nötig – die eigene Rechnung ist der Beleg."}</p>`}
    <div class="btns" style="margin-top:10px">
      <button class="btn" data-act="beleg-hoch" data-buchung-ziel="${esc(id)}">📷 Beleg hinzufügen</button>
      ${freieBelege.length ? `<select class="in" id="bFrei" style="width:auto;flex:1"><option value="">Vorhandenen Beleg zuordnen …</option>${freieBelege.map((x) => `<option value="${x.id}">${esc(x.name || "Beleg")} · ${fmtD(x.datum || x.hochgeladen?.slice(0, 10))}${x.betrag ? " · " + eur(x.betrag) : ""}</option>`).join("")}</select>` : ""}
    </div>
    ${b.betrag < 0 ? `<label class="f" style="display:flex;gap:8px;align-items:center;font-weight:500;margin-top:10px"><input type="checkbox" id="bOhne" ${b.ohneBeleg ? "checked" : ""}> Kein Beleg nötig (z. B. Kontoführungsgebühr – der Kontoauszug genügt)</label>` : ""}
    <hr class="sep">
    <div class="btns" style="justify-content:space-between">
      <button class="btn btn--danger" data-act="${b.quelle === "bank" ? "ignorieren" : "loeschen"}" data-id="${esc(id)}">${b.quelle === "bank" ? "Ausblenden" : "Löschen"}</button>
      <button class="btn btn--primary" id="bSave">Speichern</button>
    </div>`, (box) => {
    $("#bFrei", box)?.addEventListener("change", async (e) => { if (!e.target.value) return; await speichern("belege/" + e.target.value, { buchung: id }, "Beleg zugeordnet"); buchungSheet(id); });
    $("#bSave", box).onclick = async () => {
      const kat = $("#bKat", box).value, patch = { kategorie: kat || null, kategorieAuto: false, kategorieGeprueft: true, notiz: $("#bNotiz", box).value.trim() };
      if ($("#bOhne", box)) patch.ohneBeleg = $("#bOhne", box).checked;
      const reSel = $("#bRe", box)?.value;
      if ($("#bRe", box)) {
        patch.rechnung = reSel || null;
        if (reSel) { patch.kategorie = kat || "umsatz"; const rr = S.rechnungen.find((x) => x.id === reSel); if (rr && rr.status === "offen") await speichern("rechnungen/" + reSel, { status: "bezahlt", bezahltAm: b.datum, buchung: id }); }
        if (b.rechnung && b.rechnung !== reSel) { const alt = S.rechnungen.find((x) => x.id === b.rechnung); if (alt && alt.buchung === id) await speichern("rechnungen/" + alt.id, { status: "offen", bezahltAm: null, buchung: null }); }
      }
      if ($("#bRegel", box).checked && kat && b.gegenpartei) {
        const regeln = (einst().regeln || []).filter((x) => x.muster.toLowerCase() !== b.gegenpartei.toLowerCase());
        regeln.push({ muster: b.gegenpartei, kategorie: kat });
        await speichern("buchhaltung/einstellungen", { regeln });
      }
      await speichern("buchungen/" + id, patch, "Gespeichert");
      closeSheet();
    };
  });
}
function neueBuchungSheet() {
  sheet(`<h2>Umsatz eintragen</h2>
    <p class="muted small">Für Bar-Zahlungen, privat bezahlte Geschäftsausgaben oder wenn die Bank (noch) nicht verbunden ist.</p>
    <div class="chips" style="margin-bottom:12px" id="nArt"><button class="chip on" data-art="aus">Ausgabe</button><button class="chip" data-art="ein">Einnahme</button></div>
    <div class="grid" style="gap:12px">
      <div class="row"><label class="f">Datum<input type="date" id="nDatum" value="${heute()}"></label><label class="f">Betrag (€)<input id="nBetrag" inputmode="decimal" placeholder="0,00" autofocus></label></div>
      <label class="f">Bei / von<input id="nGegen" placeholder="z. B. Bürobedarf Müller"></label>
      <label class="f">Wofür<input id="nZweck" placeholder="z. B. Druckerpapier"></label>
      <div class="row"><label class="f">Kategorie<select id="nKat">${katOptions("", -1)}</select></label>
      <label class="f">Bezahlt über<select id="nKonto"><option value="konto">Geschäftskonto</option><option value="bar">Bar</option><option value="privat">Privat (Karte/Konto)</option></select></label></div>
    </div>
    <div class="btns" style="margin-top:16px;justify-content:flex-end"><button class="btn btn--primary" id="nSave">Speichern</button></div>`, (box) => {
    let art = "aus";
    $("#nArt", box).onclick = (e) => { const c = e.target.closest("[data-art]"); if (!c) return; art = c.dataset.art; $$("#nArt .chip", box).forEach((x) => x.classList.toggle("on", x === c)); $("#nKat", box).innerHTML = katOptions("", art === "ein" ? 1 : -1); };
    $("#nSave", box).onclick = async () => {
      const betrag = Math.abs(parseEuro($("#nBetrag", box).value)), datum = $("#nDatum", box).value;
      if (!betrag || !datum) return toast("Bitte Datum und Betrag angeben.");
      const id = "m-" + newId();
      await db.doc("buchungen/" + id).set({ datum, betrag: art === "ein" ? betrag : -betrag, gegenpartei: $("#nGegen", box).value.trim(), zweck: $("#nZweck", box).value.trim(), kategorie: $("#nKat", box).value || null, quelle: "manuell", konto: $("#nKonto", box).value, status: "gebucht", erfasst: new Date().toISOString() });
      closeSheet(); toast("Eingetragen"); setTimeout(() => buchungSheet(id), 50);
    };
  });
}

/* ================= CSV-Import ================= */
function csvParse(text) {
  const erste = text.split(/\r?\n/).slice(0, 30).join("\n");
  const sep = [";", ",", "\t"].map((d) => [d, (erste.match(new RegExp(d === "\t" ? "\t" : "\\" + d, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const SPALTEN = {
  datum: /^(buchungs?(datum|tag)|booking ?date|settlement date|datum|date|transaction date|wertstellung|valuta(datum)?|value date|payment date|ausführungsdatum|completed date)/i,
  betrag: /^(betrag|amount|umsatz|total amount|amount \(eur\)|betrag \(eur\)|betrag in eur|summe)/i,
  soll: /^(soll|ausgang|ausgänge|auszahlung|paid out|money out|debit|lastschrift|belastung)/i,
  haben: /^(haben|eingang|eingänge|einzahlung|paid in|money in|credit|gutschrift)/i,
  gegenpartei: /^(transaction description|transaktionsbeschreibung|gegenpartei|zahlungspartner|empfänger|auftraggeber|name|partner ?name|counterparty|counterparty name|payee|zahlungsempfänger|beguenstigter|begünstigter|zahlungspflichtiger|gegenkonto ?name|name zahlungsbeteiligter|empfänger\/auftraggeber)/i,
  von: /^(von|from|absender)$/i,
  an: /^(an|to)$/i,
  status: /^(status)$/i,
  beschreibung: /^(beschreibung|description)$/i,
  zweck: /^(verwendungszweck|payment reference|reference|referenz|description|beschreibung|buchungstext|purpose|zweck|details|notiz)/i,
};
function csvZuordnen(kopf) {
  const m = {};
  for (const [feld, re] of Object.entries(SPALTEN)) { const i = kopf.findIndex((h, j) => re.test(h.trim()) && !Object.values(m).includes(j)); if (i >= 0) m[feld] = i; }
  // z. B. Tide: „Beschreibung“ ist der Name, „Referenz“ der Verwendungszweck
  if (m.gegenpartei === undefined && m.zweck !== undefined) {
    const r = kopf.findIndex((h, j) => j !== m.zweck && /^(referenz|reference|verwendungszweck)/i.test(h.trim()));
    if (r >= 0) { m.gegenpartei = m.zweck; m.zweck = r; }
  }
  return m;
}
function csvUmsaetze(rows, kopfZeile, m) {
  const out = [];
  for (const r of rows.slice(kopfZeile + 1)) {
    const datum = parseDatum(r[m.datum]);
    let betrag = m.betrag !== undefined && m.betrag !== "" ? parseEuro(r[m.betrag]) : NaN;
    if (isNaN(betrag) && (m.soll !== undefined || m.haben !== undefined)) { const s = parseEuro(r[m.soll]), h = parseEuro(r[m.haben]); betrag = (isNaN(h) ? 0 : Math.abs(h)) - (isNaN(s) ? 0 : Math.abs(s)); }
    if (!datum || isNaN(betrag) || !betrag) continue;
    if (m.status !== undefined && /abgesagt|abgelehnt|storniert|fehlgeschlagen|declined|failed|cancel/i.test(r[m.status] || "")) continue;
    const gegen = (r[m.gegenpartei] || "").trim() || (betrag > 0 ? r[m.von] : r[m.an]) || r[m.von] || r[m.an] || r[m.beschreibung] || "";
    const zweck = (r[m.zweck] || "").trim() || (r[m.beschreibung] !== gegen ? r[m.beschreibung] : "") || "";
    out.push({ datum, betrag, gegenpartei: gegen.trim(), zweck: zweck.replace(/\s+/g, " ").trim() });
  }
  // Doppelte erkennen: gleiche Tage+Beträge, die es schon gibt (auch aus der Bank)
  const vorhanden = new Map(); for (const b of S.buchungen) { const k = b.datum + "|" + b.betrag; vorhanden.set(k, (vorhanden.get(k) || 0) + 1); }
  const gesehen = new Map();
  return out.map((u) => {
    const k = u.datum + "|" + u.betrag, n = (gesehen.get(k) || 0) + 1; gesehen.set(k, n);
    return { ...u, neu: n > (vorhanden.get(k) || 0), id: "csv-" + fnv(`${u.datum}|${u.betrag}|${norm(u.gegenpartei)}|${norm(u.zweck)}|${n}`) };
  });
}
async function csvLesen(file) {
  const buf = await file.arrayBuffer();
  let t = new TextDecoder("utf-8").decode(buf);
  if (t.includes("�")) t = new TextDecoder("windows-1252").decode(buf);
  return t.replace(/^﻿/, "");
}
function csvSheet(text, name) {
  const rows = csvParse(text);
  if (!rows.length) return toast("Die Datei ist leer oder kein CSV.");
  let kopf = 0, best = -1;
  rows.slice(0, 20).forEach((r, i) => { const n = Object.keys(csvZuordnen(r)).length; if (n > best) { best = n; kopf = i; } });
  let m = csvZuordnen(rows[kopf]);
  const spalten = rows[kopf].map((h, i) => `<option value="${i}">${esc(h.trim() || "Spalte " + (i + 1))}</option>`).join("");
  const sel = (feld, txt) => `<label class="f">${txt}<select data-feld="${feld}"><option value="">– keine –</option>${spalten}</select></label>`;
  sheet(`<h2>CSV importieren</h2><p class="muted small">${esc(name)} · ${rows.length - kopf - 1} Zeilen. Prüfe, ob die Spalten richtig erkannt wurden.</p>
    <div class="grid g2" style="gap:10px">${sel("datum", "Datum")}${sel("betrag", "Betrag (mit Vorzeichen)")}${sel("gegenpartei", "Name / Gegenseite")}${sel("zweck", "Verwendungszweck")}${sel("soll", "oder: Ausgang (Soll)")}${sel("haben", "oder: Eingang (Haben)")}</div>
    <div id="csvVor" style="margin-top:14px"></div>
    <div class="btns" style="margin-top:14px;justify-content:flex-end"><button class="btn btn--primary" id="csvGo">Importieren</button></div>`, (box) => {
    $$("[data-feld]", box).forEach((s) => { s.value = m[s.dataset.feld] ?? ""; });
    let liste = [];
    const vor = () => {
      const auto = csvZuordnen(rows[kopf]); m = {};
      ["von", "an", "status", "beschreibung"].forEach((k) => { if (auto[k] !== undefined) m[k] = auto[k]; });
      $$("[data-feld]", box).forEach((s) => { if (s.value !== "") m[s.dataset.feld] = +s.value; });
      liste = m.datum !== undefined ? csvUmsaetze(rows, kopf, m) : [];
      const neu = liste.filter((u) => u.neu);
      $("#csvVor", box).innerHTML = liste.length
        ? `<div class="info">${liste.length} Umsätze erkannt, <b>${neu.length} neu</b>${liste.length - neu.length ? `, ${liste.length - neu.length} schon vorhanden (werden übersprungen)` : ""}.</div>
           <div class="list" style="margin-top:10px">${liste.slice(0, 5).map((u) => `<div class="it" style="cursor:default"><div class="d">${fmtD(u.datum)}</div><div class="t"><b>${esc(u.gegenpartei || "–")}</b><span>${esc(u.zweck)}</span></div><div class="m ${u.betrag > 0 ? "plus" : ""}">${eur(u.betrag)}</div><div class="x">${u.neu ? "" : '<span class="badge">vorhanden</span>'}</div></div>`).join("")}</div>`
        : `<div class="info warn">Keine Umsätze erkannt – bitte Datum- und Betragsspalte auswählen.</div>`;
      $("#csvGo", box).disabled = !neu.length; $("#csvGo", box).textContent = neu.length ? `${neu.length} Umsätze importieren` : "Importieren";
    };
    box.addEventListener("change", (e) => { if (e.target.matches("[data-feld]")) vor(); });
    vor();
    $("#csvGo", box).onclick = async () => {
      const neu = liste.filter((u) => u.neu); const btn = $("#csvGo", box); btn.disabled = true;
      const jetzt = new Date().toISOString();
      try {
        for (let i = 0; i < neu.length; i += 25) {
          btn.textContent = `Importiere … ${Math.min(i + 25, neu.length)}/${neu.length}`;
          await Promise.all(neu.slice(i, i + 25).map(({ neu: _n, id, ...u }) => db.doc("buchungen/" + id).set({ ...u, quelle: "csv", konto: "konto", status: "gebucht", erfasst: jetzt })));
        }
        closeSheet(); toast(`${neu.length} Umsätze importiert`); location.hash = "#umsaetze";
      } catch (e) { console.error(e); toast("Import abgebrochen – bitte nochmal versuchen."); btn.disabled = false; }
    };
  });
}

/* ================= Belege ================= */
const urlCache = new Map();
async function belegUrls(liste) {
  const fehlt = liste.filter((x) => x.pfad && !(urlCache.get(x.pfad)?.bis > Date.now()));
  if (!fehlt.length) return;
  const { data } = await SB.storage.from("belege").createSignedUrls(fehlt.map((x) => x.pfad), 3600);
  (data || []).forEach((d) => d.signedUrl && urlCache.set(d.path, { url: d.signedUrl, bis: Date.now() + 3500e3 }));
}
const belegUrl = (x) => urlCache.get(x.pfad)?.url || "";
function belegKachel(x) {
  const b = x.buchung && S.buchungen.find((y) => y.id === x.buchung);
  const bild = /^image\//.test(x.typ) && !/heic|heif/.test(x.typ);
  return `<button class="bk" data-beleg="${esc(x.id)}"><div class="im">${bild && belegUrl(x) ? `<img src="${esc(belegUrl(x))}" alt="" loading="lazy">` : bild ? "…" : /pdf/.test(x.typ) ? "PDF" : /xml/.test(x.typ) ? "E-Rechnung" : "Datei"}</div>
    <div class="tx"><b>${esc(b ? b.gegenpartei || "Umsatz" : x.name || "Beleg")}</b><span class="muted">${b ? `${fmtD(b.datum)} · ${eur(b.betrag)}` : fmtD(x.datum || (x.hochgeladen || "").slice(0, 10))}</span></div></button>`;
}
async function verkleinern(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 700e3) return file;
  try {
    const bmp = await createImageBitmap(file), f = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * f); c.height = Math.round(bmp.height * f);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}
async function belegeHochladen(files, buchung) {
  let ok = 0;
  for (const roh of files) {
    if (roh.size > 15e6) { toast(`${roh.name} ist größer als 15 MB.`); continue; }
    const file = await verkleinern(roh);
    const typ = /\.xml$/i.test(file.name) ? "application/xml" : file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : /\.heic$/i.test(file.name) ? "image/heic" : "image/jpeg");
    const ext = { "application/xml": "xml", "application/pdf": "pdf", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" }[typ] || "jpg";
    const id = newId(), pfad = `${UID}/${id}.${ext}`;
    toast(`Lade ${roh.name} hoch …`, 20000);
    const { error } = await SB.storage.from("belege").upload(pfad, file, { contentType: typ, upsert: false });
    if (error) { console.error(error); toast("Hochladen fehlgeschlagen: " + error.message); continue; }
    await db.doc("belege/" + id).set({ pfad, typ, name: roh.name, groesse: file.size, hochgeladen: new Date().toISOString(), datum: heute(), buchung: buchung || null });
    ok++;
  }
  if (ok) toast(ok === 1 ? "Beleg gespeichert" : `${ok} Belege gespeichert`);
  return ok;
}
let belegZiel = null;
$("#fileBeleg").addEventListener("change", async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  if (!files.length) return;
  const ziel = belegZiel; belegZiel = null;
  await belegeHochladen(files, ziel);
  if (ziel && !$("#sheet").hidden) buchungSheet(ziel); else render();
});
VIEWS.belege = () => {
  const alle = [...S.belege].sort((a, b) => (b.hochgeladen || "").localeCompare(a.hochgeladen || ""));
  const offen = alle.filter((x) => !x.buchung), liste = F.bFilter === "offen" && offen.length ? offen : alle;
  if (F.bFilter === "offen" && !offen.length) F.bFilter = "alle";
  belegUrls(liste.slice(0, 120)).then(() => { $$("#view .bk").forEach((el) => { const x = S.belege.find((y) => y.id === el.dataset.beleg); const im = el.querySelector(".im"); if (x && belegUrl(x) && im && !im.querySelector("img") && /^image\//.test(x.typ) && !/heic|heif/.test(x.typ)) im.innerHTML = `<img src="${esc(belegUrl(x))}" alt="" loading="lazy">`; }); }, () => {});
  return `<div class="head"><h1>Belege</h1><div class="btns"><button class="btn btn--primary" data-act="beleg-hoch">📷 Beleg hinzufügen</button></div></div>
    <div class="drop" id="drop">Quittungen fotografieren oder PDF-Rechnungen hierher ziehen. Danach einem Umsatz zuordnen – die App schlägt passende vor.</div>
    <div class="chips" style="margin-bottom:12px"><button class="chip ${F.bFilter === "offen" ? "on" : ""}" data-bfilter="offen">Nicht zugeordnet (${offen.length})</button><button class="chip ${F.bFilter === "alle" ? "on" : ""}" data-bfilter="alle">Alle (${alle.length})</button></div>
    ${liste.length ? `<div class="bgrid">${liste.map(belegKachel).join("")}</div>` : `<div class="empty card">Noch keine Belege.</div>`}`;
};
VIEWS.belegeMount = (v) => {
  const d = $("#drop", v);
  d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
  d.ondragleave = () => d.classList.remove("over");
  d.ondrop = async (e) => { e.preventDefault(); d.classList.remove("over"); await belegeHochladen([...e.dataTransfer.files]); render(); };
};
async function belegSheet(id) {
  const x = S.belege.find((y) => y.id === id); if (!x) return;
  await belegUrls([x]).catch(() => {});
  const url = belegUrl(x), bild = /^image\//.test(x.typ) && !/heic|heif/.test(x.typ);
  const b = x.buchung && S.buchungen.find((y) => y.id === x.buchung);
  const vorschlaege = sichtbar().filter((y) => y.betrag < 0 && !belegeZu(y.id).length)
    .map((y) => ({ y, p: (x.betrag && Math.abs(y.betrag) === Math.abs(x.betrag) ? 0 : 1e6) + Math.abs(new Date(y.datum) - new Date(x.datum || x.hochgeladen)) / 864e5 }))
    .sort((a, c) => a.p - c.p).slice(0, 40);
  sheet(`<h2>${esc(x.name || "Beleg")}</h2>
    <div style="margin:10px 0;border-radius:12px;overflow:hidden;background:var(--surface-2);text-align:center">${bild && url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Beleg" style="max-width:100%;max-height:52vh;display:block;margin:auto"></a>` : `<div class="pad">${/pdf/.test(x.typ) ? "PDF-Dokument" : "Datei"} · <a href="${esc(url)}" target="_blank" rel="noopener">öffnen</a></div>`}</div>
    <div class="row"><label class="f">Datum auf dem Beleg<input type="date" id="xDatum" value="${esc(x.datum || "")}"></label><label class="f">Betrag (€)<input id="xBetrag" inputmode="decimal" value="${x.betrag ? eurPlain(Math.abs(x.betrag)) : ""}" placeholder="hilft beim Zuordnen"></label></div>
    <label class="f" style="margin-top:10px">Gehört zu Umsatz<select id="xBuchung"><option value="">– noch keinem –</option>${b ? `<option value="${b.id}" selected>${fmtD(b.datum)} · ${esc(b.gegenpartei)} · ${eur(b.betrag)}</option>` : ""}${vorschlaege.map(({ y }) => `<option value="${y.id}">${fmtD(y.datum)} · ${esc(y.gegenpartei)} · ${eur(y.betrag)}</option>`).join("")}</select></label>
    <p class="small muted">Passende Ausgaben stehen oben (gleicher Betrag, nahes Datum).</p>
    <div class="btns" style="justify-content:space-between;margin-top:14px"><button class="btn btn--danger" id="xDel">Löschen</button><div class="btns">${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener" download>Herunterladen</a>` : ""}<button class="btn btn--primary" id="xSave">Speichern</button></div></div>`, (box) => {
    $("#xSave", box).onclick = async () => { const bt = parseEuro($("#xBetrag", box).value); await speichern("belege/" + id, { datum: $("#xDatum", box).value, betrag: isNaN(bt) ? null : -Math.abs(bt), buchung: $("#xBuchung", box).value || null }, "Gespeichert"); closeSheet(); };
    $("#xDel", box).onclick = async () => {
      if (!confirm("Beleg endgültig löschen? Belege musst du 10 Jahre aufbewahren – nur löschen, wenn er doppelt oder falsch ist.")) return;
      await SB.storage.from("belege").remove([x.pfad]); await db.doc("belege/" + id).delete(); closeSheet(); toast("Gelöscht");
    };
  });
}

/* ================= Rechnungen ================= */
const STATUS = { entwurf: ["Entwurf", ""], offen: ["Offen", "blue"], bezahlt: ["Bezahlt", "green"], storniert: ["Storniert", "red"], storno: ["Stornorechnung", "red"] };
const statusBadge = (r) => ueberfaellig(r) ? `<span class="badge amber">Überfällig</span>` : `<span class="badge ${STATUS[r.status]?.[1] || ""}">${STATUS[r.status]?.[0] || r.status}</span>`;
function kundeAusSite(s) {
  const adr = String(s.adresse || "").split(/\n|,\s*(?=\d{5})/).map((x) => x.trim()).filter(Boolean);
  return { siteId: s.id, name: s.name || "", zusatz: s.inhaber ? (s.inhaber + "").trim() : "", adresse: adr.join("\n"), email: s.email || "" };
}
async function neueRechnung(site) {
  const id = newId(), e = einst();
  const r = { status: "entwurf", datum: heute(), zahlungsziel: +(e.zahlungsziel ?? 14), kunde: site ? kundeAusSite(site) : { name: "", adresse: "" }, positionen: [{ text: "", menge: 1, preis: 0 }], leistungVon: heute(), erstellt: new Date().toISOString() };
  await db.doc("rechnungen/" + id).set(r);
  return id;
}
VIEWS.rechnungen = () => {
  const [, arg] = teil(); if (arg) F.rFilter = arg;
  let rows = [...S.rechnungen].sort((a, b) => (b.nummer ? 1 : 2) - (a.nummer ? 1 : 2) || (b.datum || "").localeCompare(a.datum || "") || (b.nummer || "").localeCompare(a.nummer || ""));
  rows = rows.filter((r) => ({ alle: true, entwurf: r.status === "entwurf", offen: r.status === "offen", ueberfaellig: ueberfaellig(r), bezahlt: r.status === "bezahlt" }[F.rFilter] ?? true));
  rows.sort((a, b) => (a.status === "entwurf" ? 0 : 1) - (b.status === "entwurf" ? 0 : 1));
  const cnt = (f) => S.rechnungen.filter(f).length;
  return `<div class="head"><h1>Rechnungen</h1><div class="btns"><button class="btn btn--primary" data-act="neu-rechnung">+ Neue Rechnung</button></div></div>
    <div class="chips" style="margin-bottom:12px">${[["alle", "Alle"], ["entwurf", `Entwürfe (${cnt((r) => r.status === "entwurf")})`], ["offen", `Offen (${cnt((r) => r.status === "offen")})`], ["ueberfaellig", `Überfällig (${cnt(ueberfaellig)})`], ["bezahlt", "Bezahlt"]].map(([k, t]) => `<button class="chip ${F.rFilter === k ? "on" : ""}" data-rfilter="${k}">${t}</button>`).join("")}</div>
    <div class="list">${rows.length ? rows.map((r) => `<a class="it" href="#rechnung/${r.id}" style="color:inherit;text-decoration:none"><div class="d">${fmtD(r.datum)}</div><div class="t"><b>${esc(r.kunde?.name || "(ohne Kunde)")}</b><span>${esc(r.nummer || "Entwurf")}${r.status === "offen" ? " · fällig " + fmtD(faelligAm(r)) : r.bezahltAm ? " · bezahlt " + fmtD(r.bezahltAm) : ""}</span></div><div class="m">${eur(summe(r))}</div><div class="x">${statusBadge(r)}</div></a>`).join("") : `<div class="empty">Keine Rechnungen${F.rFilter !== "alle" ? " in dieser Ansicht" : ""}.</div>`}</div>`;
};
// --- Rechnungsblatt (Vorschau = Druck) ---
function papier(r) {
  const a = r.absender || einst(), ges = summe(r), storno = r.status === "storno";
  const zeitraum = r.leistungBis && r.leistungBis !== r.leistungVon ? `${fmtD(r.leistungVon)} – ${fmtD(r.leistungBis)}` : fmtD(r.leistungVon || r.datum);
  const absZeile = [a.firma, a.strasse, a.plzOrt].filter(Boolean).join(" · ");
  const ziel = faelligAm(r);
  const ref = storno && S.rechnungen.find((x) => x.id === r.stornoVon);
  return `<div class="paper" id="paper">
    <div class="kopf"><div style="padding-top:2.6em"><span class="ab">${esc(absZeile || "Absender in den Einstellungen eintragen")}</span><div>${esc(r.kunde?.name || "Kunde")}${r.kunde?.zusatz ? `<br>${esc(r.kunde.zusatz)}` : ""}<br>${esc(r.kunde?.adresse || "").replace(/\n/g, "<br>")}</div></div>
      <div class="meta"><div class="logo">${esc((a.firma || "crestra").split(/\s/)[0])}</div><div style="margin-top:1.4em">${a.inhaber ? `Inhaber ${esc(a.inhaber)}<br>` : ""}${esc(a.strasse || "")}<br>${esc(a.plzOrt || "")}<br>${esc(a.email || "")}${a.telefon ? `<br>${esc(a.telefon)}` : ""}</div></div></div>
    <div class="meta" style="text-align:left;display:grid;grid-template-columns:auto 1fr;gap:.1em 1.4em;margin-bottom:1.6em">
      <span>${storno ? "Stornorechnung" : "Rechnung"} Nr.</span><b>${esc(r.nummer || "wird beim Festschreiben vergeben")}</b>
      <span>Rechnungsdatum</span><span>${fmtD(r.datum)}</span>
      <span>Leistungszeitraum</span><span>${zeitraum}</span>
      ${a.steuernummer ? `<span>Steuernummer</span><span>${esc(a.steuernummer)}</span>` : ""}
    </div>
    <h2>${storno ? "Stornorechnung" : "Rechnung"}</h2>
    <div>${storno && ref ? `Hiermit stornieren wir die Rechnung ${esc(ref.nummer)} vom ${fmtD(ref.datum)} vollständig.` : esc(r.einleitung || "Vielen Dank für Ihren Auftrag. Ich berechne Ihnen folgende Leistungen:")}</div>
    <table><thead><tr><th style="width:2.2em">Pos.</th><th>Beschreibung</th><th class="r">Menge</th><th class="r">Einzelpreis</th><th class="r">Betrag</th></tr></thead><tbody>
      ${(r.positionen || []).map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.text || "").replace(/\n/g, "<br>")}</td><td class="r">${String(+p.menge || 0).replace(".", ",")}</td><td class="r">${eur(p.preis)}</td><td class="r">${eur(Math.round((+p.menge || 0) * (p.preis || 0)))}</td></tr>`).join("")}
      <tr class="sum"><td></td><td>Gesamtbetrag</td><td></td><td></td><td class="r">${eur(ges)}</td></tr></tbody></table>
    <div class="hinweis">Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.</div>
    ${storno ? "" : `<div class="hinweis">Bitte überweisen Sie den Betrag bis zum <b>${fmtD(ziel)}</b> unter Angabe der Rechnungsnummer auf das unten genannte Konto.</div>`}
    ${r.status === "bezahlt" ? `<div class="stempel">Bezahlt am ${fmtD(r.bezahltAm)}</div>` : ""}
    ${r.schluss ? `<div class="hinweis">${esc(r.schluss)}</div>` : `<div class="hinweis">Mit freundlichen Grüßen<br>${esc(a.inhaber || a.firma || "")}</div>`}
    <div class="fuss"><div>${esc(a.firma || "")}${a.inhaber ? `<br>Inh. ${esc(a.inhaber)}` : ""}<br>${esc(a.strasse || "")}<br>${esc(a.plzOrt || "")}</div><div>${esc(a.email || "")}${a.telefon ? `<br>${esc(a.telefon)}` : ""}${a.web ? `<br>${esc(a.web)}` : ""}${a.steuernummer ? `<br>St.-Nr. ${esc(a.steuernummer)}` : ""}</div><div>${esc(a.bankname || "Bankverbindung")}<br>IBAN ${esc(a.iban || "–")}${a.bic ? `<br>BIC ${esc(a.bic)}` : ""}</div></div>
  </div>`;
}
let ED = null, edTimer = null;
function edSpeichern(sofort) {
  clearTimeout(edTimer);
  const go = () => { if (ED && ED.status === "entwurf") { const { id, ...d } = ED; db.doc("rechnungen/" + id).set(d).catch(() => toast("Speichern fehlgeschlagen")); } };
  if (sofort) go(); else edTimer = setTimeout(go, 600);
}
function renderRechnung(id) {
  const view = $("#view"), r = S.rechnungen.find((x) => x.id === id);
  if (!r) { view.innerHTML = S.geladen.has("rechnungen") ? `<p class="pad">Rechnung nicht gefunden. <a href="#rechnungen">Zur Übersicht</a></p>` : `<p class="muted pad">Lädt …</p>`; return; }
  if (r.status !== "entwurf") {
    ED = null;
    const bez = r.buchung && S.buchungen.find((b) => b.id === r.buchung);
    view.innerHTML = `<div class="inv-wrap"><div class="no-print">
      <a href="#rechnungen" class="small">← Rechnungen</a>
      <h1 style="margin-top:8px">${esc(r.nummer)}</h1><p>${statusBadge(r)} <span class="muted">${esc(r.kunde?.name)} · ${eur(summe(r))}</span></p>
      <div class="card grid" style="gap:10px">
        <div class="btns"><button class="btn btn--primary" data-act="drucken">Drucken / als PDF speichern</button>${r.kunde?.email ? `<a class="btn" href="mailto:${encodeURIComponent(r.kunde.email)}?subject=${encodeURIComponent(`Rechnung ${r.nummer}`)}&body=${encodeURIComponent(`Guten Tag,\n\nanbei erhalten Sie die Rechnung ${r.nummer} über ${eur(summe(r))}.\n\nMit freundlichen Grüßen\n${(r.absender || einst()).inhaber || ""}`)}">E-Mail vorbereiten</a>` : ""}</div>
        <p class="small muted" style="margin:0">Tipp: Im Druckfenster „Als PDF sichern“ wählen und die PDF an die E-Mail hängen.</p>
        ${r.status === "offen" ? `<hr class="sep" style="margin:4px 0"><div class="row"><label class="f">Bezahlt am<input type="date" id="rBez" value="${heute()}"></label><button class="btn" data-act="bezahlt" data-id="${r.id}">Als bezahlt markieren</button></div><p class="small muted" style="margin:0">Kommt das Geld über die verbundene Bank, wird die Rechnung automatisch erkannt, wenn die Rechnungsnummer im Verwendungszweck steht.</p>` : ""}
        ${r.status === "bezahlt" ? `<p style="margin:0">Bezahlt am ${fmtD(r.bezahltAm)}${bez ? ` · <button class="linkish" data-buchung="${esc(bez.id)}">Zahlung ansehen</button>` : ""}</p><button class="btn btn--small" data-act="unbezahlt" data-id="${r.id}" style="justify-self:start">Doch nicht bezahlt</button>` : ""}
        ${["offen", "bezahlt"].includes(r.status) ? `<hr class="sep" style="margin:4px 0"><button class="btn btn--danger" data-act="storno" data-id="${r.id}" style="justify-self:start">Stornieren …</button><p class="small muted" style="margin:0">Festgeschriebene Rechnungen bleiben unverändert erhalten. Beim Stornieren entsteht eine Stornorechnung mit eigener Nummer.</p>` : ""}
        ${r.status === "storniert" && r.storniertDurch ? `<p style="margin:0">Storniert durch <a href="#rechnung/${r.storniertDurch}">${esc(S.rechnungen.find((x) => x.id === r.storniertDurch)?.nummer || "Stornorechnung")}</a></p>` : ""}
        <hr class="sep" style="margin:4px 0"><button class="btn" data-act="kopie" data-id="${r.id}" style="justify-self:start">Als Vorlage für neue Rechnung</button>
      </div></div><div class="paper-wrap">${papier(r)}</div></div>`;
    return;
  }
  if (ED && ED.id === id && $("#edForm")) { $("#edPaper").innerHTML = papier(ED); return; }
  ED = JSON.parse(JSON.stringify({ id, ...r }));
  const sites = [...S.sites].sort((a, b) => (a.stage === "gewonnen" ? 0 : 1) - (b.stage === "gewonnen" ? 0 : 1) || (a.name || "").localeCompare(b.name || ""));
  view.innerHTML = `<div class="inv-wrap"><div class="no-print" id="edForm">
    <a href="#rechnungen" class="small">← Rechnungen</a>
    <h1 style="margin-top:8px">Rechnung <span class="badge">Entwurf</span></h1>
    ${firmaKomplett() ? "" : `<div class="info warn" style="margin-bottom:12px">Absender unvollständig. Trag Adresse, Steuernummer und IBAN unter <a href="#einstellungen">Einstellungen</a> ein, vorher kann die Rechnung nicht festgeschrieben werden.</div>`}
    <div class="card grid" style="gap:12px">
      <label class="f">Kunde aus dem Board<select id="edSite"><option value="">– frei eingeben –</option>${sites.map((s) => `<option value="${esc(s.id)}"${ED.kunde?.siteId === s.id ? " selected" : ""}>${esc(s.name)}${s.stage === "gewonnen" ? "" : " (" + esc(s.stage || "") + ")"}</option>`).join("")}</select></label>
      <div class="row"><label class="f">Firma / Name<input data-k="kunde.name" value="${esc(ED.kunde?.name)}"></label><label class="f">z. Hd. / Inhaber<input data-k="kunde.zusatz" value="${esc(ED.kunde?.zusatz)}"></label></div>
      <label class="f">Anschrift<textarea data-k="kunde.adresse" rows="2" placeholder="Straße Nr.&#10;PLZ Ort">${esc(ED.kunde?.adresse)}</textarea></label>
      <label class="f">E-Mail<input type="email" data-k="kunde.email" value="${esc(ED.kunde?.email)}"></label>
      <div class="row"><label class="f">Rechnungsdatum<input type="date" data-k="datum" value="${esc(ED.datum)}"></label><label class="f">Zahlungsziel (Tage)<input type="number" min="0" data-k="zahlungsziel" value="${esc(ED.zahlungsziel)}"></label></div>
      <div class="row"><label class="f">Leistung von<input type="date" data-k="leistungVon" value="${esc(ED.leistungVon)}"></label><label class="f">bis (optional)<input type="date" data-k="leistungBis" value="${esc(ED.leistungBis || "")}"></label></div>
      <div><div class="pos small muted" style="font-weight:600"><span>Beschreibung</span><span>Menge</span><span>Preis (€)</span><span></span></div>
        <div id="edPos">${ED.positionen.map((p, i) => `<div class="pos"><input class="in" data-p="${i}" data-pk="text" value="${esc(p.text)}" placeholder="Leistung"><input class="in" data-p="${i}" data-pk="menge" inputmode="decimal" value="${String(p.menge).replace(".", ",")}"><input class="in" data-p="${i}" data-pk="preis" inputmode="decimal" value="${p.preis ? eurPlain(p.preis) : ""}" placeholder="0,00"><button class="btn btn--small" data-pdel="${i}" aria-label="Position entfernen">×</button></div>`).join("")}</div>
        <button class="btn btn--small" data-act="pos-neu">+ Position</button></div>
      <label class="f">Einleitungssatz (optional)<input data-k="einleitung" value="${esc(ED.einleitung || "")}" placeholder="Vielen Dank für Ihren Auftrag. Ich berechne Ihnen folgende Leistungen:"></label>
      <p class="small muted" style="margin:0">Der Hinweis „Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.“ steht automatisch auf jeder Rechnung.</p>
    </div>
    <div class="btns" style="margin-top:14px;justify-content:space-between"><button class="btn btn--danger" data-act="entwurf-weg" data-id="${id}">Entwurf löschen</button><button class="btn btn--primary" data-act="festschreiben" data-id="${id}">Festschreiben (${esc(naechsteNummer((ED.datum || heute()).slice(0, 4)))})</button></div>
  </div><div class="paper-wrap" id="edPaper">${papier(ED)}</div></div>`;
  const form = $("#edForm");
  form.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.k) { const [a, b] = t.dataset.k.split("."); if (b) ED[a] = { ...(ED[a] || {}), [b]: t.value }; else ED[a] = t.type === "number" ? +t.value : t.value; }
    if (t.dataset.p !== undefined) { const p = ED.positionen[+t.dataset.p]; if (t.dataset.pk === "text") p.text = t.value; else if (t.dataset.pk === "menge") p.menge = parseFloat(t.value.replace(",", ".")) || 0; else { const v = parseEuro(t.value); p.preis = isNaN(v) ? 0 : v; } }
    $("#edPaper").innerHTML = papier(ED); edSpeichern();
  });
  form.addEventListener("focusout", () => edSpeichern(true));
  $("#edSite").onchange = (e) => { const s = S.sites.find((x) => x.id === e.target.value); ED.kunde = s ? kundeAusSite(s) : { name: "", adresse: "" }; edSpeichern(true); const k = ED; ED = null; db.doc("rechnungen/" + id).set((({ id: _, ...d }) => d)(k)).then(() => renderRechnung(id)); };
  form.addEventListener("click", (e) => {
    const del = e.target.closest("[data-pdel]");
    if (del) { ED.positionen.splice(+del.dataset.pdel, 1); edSpeichern(true); const k = ED; ED = null; S.rechnungen = S.rechnungen.map((x) => (x.id === id ? k : x)); renderRechnung(id); }
    if (e.target.closest("[data-act=pos-neu]")) { ED.positionen.push({ text: "", menge: 1, preis: 0 }); edSpeichern(true); const k = ED; ED = null; S.rechnungen = S.rechnungen.map((x) => (x.id === id ? k : x)); renderRechnung(id); $$("#edPos input[data-pk=text]").pop()?.focus(); }
  });
}
async function festschreiben(id) {
  edSpeichern(true);
  const r = ED && ED.id === id ? ED : S.rechnungen.find((x) => x.id === id);
  const fehler = [];
  if (!firmaKomplett()) fehler.push("Absender (Adresse, Steuernummer, IBAN) in den Einstellungen");
  if (!r.kunde?.name || !r.kunde?.adresse) fehler.push("Name und Anschrift des Kunden");
  if (!r.positionen?.length || r.positionen.some((p) => !p.text?.trim())) fehler.push("Beschreibung jeder Position");
  if (!summe(r)) fehler.push("einen Betrag");
  if (!r.leistungVon) fehler.push("das Leistungsdatum");
  if (fehler.length) return alert("Bitte noch ergänzen:\n• " + fehler.join("\n• "));
  const nummer = naechsteNummer((r.datum || heute()).slice(0, 4));
  if (!confirm(`Rechnung als ${nummer} festschreiben?\n\nDanach kann sie nicht mehr geändert werden (Pflicht nach GoBD). Fehler korrigierst du über eine Stornorechnung.`)) return;
  const { id: _, ...d } = r; ED = null;
  const e = einst();
  await db.doc("rechnungen/" + id).set({ ...d, nummer, status: "offen", festgeschrieben: new Date().toISOString(), absender: { firma: e.firma, inhaber: e.inhaber, strasse: e.strasse, plzOrt: e.plzOrt, email: e.email, telefon: e.telefon, web: e.web, steuernummer: e.steuernummer, iban: e.iban, bic: e.bic, bankname: e.bankname } });
  toast(`${nummer} festgeschrieben`);
}
async function stornieren(id) {
  const r = S.rechnungen.find((x) => x.id === id);
  if (!confirm(`${r.nummer} stornieren?\n\nEs wird eine Stornorechnung mit neuer Nummer und negativem Betrag erstellt. Danach kannst du eine korrigierte Rechnung schreiben.`)) return;
  const sid = newId(), nummer = naechsteNummer(heute().slice(0, 4));
  await db.doc("rechnungen/" + sid).set({ ...(({ id: _, buchung, bezahltAm, ...d }) => d)(r), nummer, status: "storno", stornoVon: id, datum: heute(), positionen: r.positionen.map((p) => ({ ...p, preis: -p.preis })), festgeschrieben: new Date().toISOString(), absender: r.absender });
  await speichern("rechnungen/" + id, { status: "storniert", storniertDurch: sid });
  location.hash = "#rechnung/" + sid; toast("Stornorechnung " + nummer + " erstellt");
}
// Zahlungseingänge mit Rechnungsnummer im Verwendungszweck automatisch zuordnen
const zugeordnet = new Set(), autoKat = new Set();
async function abgleichen() {
  // Kategorie-Vorschläge automatisch übernehmen (änderbar wie jede andere Kategorie)
  const auto = sichtbar().filter((b) => !b.kategorie && !b.kategorieGeprueft && !autoKat.has(b.id) && !regel(b) && raten(b));
  auto.forEach((b) => autoKat.add(b.id));
  if (auto.length) await Promise.all(auto.map((b) => db.doc("buchungen/" + b.id).update({ kategorie: raten(b), kategorieAuto: true }).catch(() => autoKat.delete(b.id))));
  // Auszahlungen an Vertriebler der offenen Provision zuordnen
  for (const b of sichtbar()) {
    if (b.betrag >= 0 || b.provision || zugeordnet.has(b.id)) continue;
    const txt = norm(`${b.zweck} ${b.gegenpartei}`);
    const p = S.provisionen.find((x) => x.status !== "bezahlt" && provBrutto(x) === -b.betrag && ((norm(vName(x.vertriebler)).length > 4 && txt.includes(norm(vName(x.vertriebler)))) || (x.nummer && txt.includes(norm(x.nummer)))));
    if (!p) continue;
    zugeordnet.add(b.id);
    await speichern("buchungen/" + b.id, { provision: p.id, kategorie: "fremd" });
    await speichern("provisionen/" + p.id, { status: "bezahlt", bezahltAm: b.datum, buchung: b.id }, `Provision an ${vName(p.vertriebler)} ausgezahlt`);
  }
  for (const b of sichtbar()) {
    if (b.betrag <= 0 || b.rechnung || zugeordnet.has(b.id)) continue;
    const txt = norm(`${b.zweck} ${b.gegenpartei}`);
    const r = S.rechnungen.find((x) => x.status === "offen" && x.nummer && summe(x) === b.betrag && txt.includes(norm(x.nummer)));
    if (!r) continue;
    zugeordnet.add(b.id);
    await speichern("buchungen/" + b.id, { rechnung: r.id, kategorie: b.kategorie || "umsatz" });
    await speichern("rechnungen/" + r.id, { status: "bezahlt", bezahltAm: b.datum, buchung: b.id }, `${r.nummer} ist bezahlt`);
  }
}

/* ================= Vertrieb: freie Vertriebler und Provisionen ================= */
// Provision = netto; ist der Vertriebler kein Kleinunternehmer, kommen 19 % USt dazu.
// crestra ist selbst Kleinunternehmer und kann diese USt nicht zurückholen → Ausgabe = brutto.
const vName = (id) => S.vertriebler.find((v) => v.id === id)?.name || "";
const provUst = (p) => p.ust || 0;
const provBrutto = (p) => (p.netto || 0) + provUst(p);
const STANDARD_PROVISION = 25000;
function naechsteGutschrift(jahr) {
  const re = new RegExp(`^GS-${jahr}-(\\d+)$`);
  const max = S.provisionen.reduce((m, p) => { const x = (p.nummer || "").match(re); return x ? Math.max(m, +x[1]) : m; }, 0);
  return `GS-${jahr}-${String(max + 1).padStart(4, "0")}`;
}
VIEWS.vertrieb = () => {
  const j = new Date().getFullYear();
  const offen = S.provisionen.filter((p) => p.status !== "bezahlt");
  const gezahlt = S.provisionen.filter((p) => p.status === "bezahlt" && (p.bezahltAm || "").startsWith(j));
  const abschl = S.provisionen.filter((p) => (p.datum || "").startsWith(j)).length;
  const prov = [...S.provisionen].sort((a, b) => (a.status === "bezahlt" ? 1 : 0) - (b.status === "bezahlt" ? 1 : 0) || (b.datum || "").localeCompare(a.datum || ""));
  return `<div class="head"><h1>Vertrieb</h1><div class="btns"><button class="btn" data-act="vertriebler-neu">+ Vertriebler</button><button class="btn btn--primary" data-act="provision-neu" ${S.vertriebler.length ? "" : "disabled"}>+ Provision</button></div></div>
  <div class="grid g3 stats" style="margin-bottom:14px">
    <div class="card stat"><span>Offen</span><strong>${eur(offen.reduce((s, p) => s + provBrutto(p), 0))}</strong><span>${offen.length} Provision${offen.length === 1 ? "" : "en"}</span></div>
    <div class="card stat"><span>Ausgezahlt ${j}</span><strong>${eur(gezahlt.reduce((s, p) => s + provBrutto(p), 0))}</strong></div>
    <div class="card stat"><span>Abschlüsse ${j}</span><strong>${abschl}</strong></div>
  </div>
  <div class="grid g2" style="align-items:start">
    <section><h2>Vertriebler</h2><div class="list">${S.vertriebler.length ? [...S.vertriebler].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((v) => {
      const ps = S.provisionen.filter((p) => p.vertriebler === v.id), o = ps.filter((p) => p.status !== "bezahlt").reduce((s, p) => s + provBrutto(p), 0);
      return `<button class="it" data-vertriebler="${esc(v.id)}" style="width:100%;border-left:0;border-right:0;border-bottom:0;background:none;text-align:left;font:inherit;color:inherit;grid-template-columns:minmax(0,1fr) auto"><span class="t"><b>${esc(v.name)}</b><span>${ps.length} Abschluss${ps.length === 1 ? "" : "e"} · ${v.kleinunternehmer === false ? "mit USt" : "Kleinunternehmer"}${v.steuernummer ? "" : " · Steuernummer fehlt"}</span></span><span class="m">${o ? eur(o) + " offen" : ""}</span></button>`;
    }).join("") : `<div class="empty">Noch keine Vertriebler. Leg sie mit Name, Adresse, Steuernummer und IBAN an.</div>`}</div></section>
    <section><h2>Provisionen</h2><div class="list">${prov.length ? prov.map((p) => `<button class="it" data-provision="${esc(p.id)}" style="width:100%;border-left:0;border-right:0;border-bottom:0;background:none;text-align:left;font:inherit;color:inherit"><span class="d">${fmtD(p.datum)}</span><span class="t"><b>${esc(p.kunde?.name || "Kunde")}</b><span>${esc(vName(p.vertriebler))}${p.nummer ? " · " + esc(p.nummer) : ""}</span></span><span class="m">${eur(provBrutto(p))}</span><span class="x">${p.status === "bezahlt" ? `<span class="badge green">ausgezahlt</span>` : `<span class="badge amber">offen</span>`}</span></button>`).join("") : `<div class="empty">Noch keine Provisionen.</div>`}</div></section>
  </div>
  <div class="info" style="margin-top:14px">So läuft es: Der Kunde unterschreibt, du trägst die Provision ein. Entweder schreibt der Vertriebler dir eine Rechnung (als Beleg hochladen) oder du erstellst hier eine <b>Gutschrift</b> und schickst sie ihm. Die Überweisung aus Tide wird beim nächsten Import automatisch erkannt (Name des Vertrieblers + Betrag) und als „Fremdleistungen & Provisionen“ verbucht.</div>`;
};
function vertrieblerSheet(id) {
  const v = (id && S.vertriebler.find((x) => x.id === id)) || { kleinunternehmer: true, provision: STANDARD_PROVISION };
  const anz = id ? S.provisionen.filter((p) => p.vertriebler === id).length : 0;
  const f = (k, t, ph = "", typ = "text") => `<label class="f">${t}<input type="${typ}" id="v_${k}" value="${esc(v[k] ?? "")}" placeholder="${esc(ph)}"></label>`;
  sheet(`<h2>${id ? esc(v.name) : "Neuer Vertriebler"}</h2>
    <div class="grid" style="gap:12px">
      ${f("name", "Name", "Vor- und Nachname")}
      <label class="f">Anschrift<textarea id="v_adresse" rows="2" placeholder="Straße Nr.&#10;PLZ Ort">${esc(v.adresse || "")}</textarea></label>
      <div class="row">${f("email", "E-Mail", "", "email")}${f("telefon", "Telefon", "", "tel")}</div>
      <div class="row">${f("iban", "IBAN")}${f("steuernummer", "Steuernummer", "Pflicht für Gutschriften")}</div>
      <div class="row"><label class="f">Provision je Abschluss (€)<input id="v_provision" inputmode="decimal" value="${eurPlain(v.provision ?? STANDARD_PROVISION)}"></label>
      <label class="f">Umsatzsteuer<select id="v_ku"><option value="1"${v.kleinunternehmer !== false ? " selected" : ""}>Kleinunternehmer (keine USt)</option><option value="0"${v.kleinunternehmer === false ? " selected" : ""}>stellt 19 % USt in Rechnung</option></select></label></div>
      <p class="small muted" style="margin:0">Wichtig: Stellt ein Vertriebler Umsatzsteuer in Rechnung, zahlst du 250 € + 47,50 € USt = 297,50 €. Als Kleinunternehmer bekommst du die USt nicht zurück.</p>
      <label class="f">Notiz<textarea id="v_notiz" placeholder="z. B. Vertrag vom …, Gebiet">${esc(v.notiz || "")}</textarea></label>
    </div>
    <div class="btns" style="margin-top:16px;justify-content:space-between">${id && !anz ? `<button class="btn btn--danger" id="vDel">Löschen</button>` : "<span></span>"}<button class="btn btn--primary" id="vSave">Speichern</button></div>`, (box) => {
    $("#vSave", box).onclick = async () => {
      const name = $("#v_name", box).value.trim(); if (!name) return toast("Bitte einen Namen eintragen.");
      const pr = parseEuro($("#v_provision", box).value);
      const d = { name, adresse: $("#v_adresse", box).value.trim(), email: $("#v_email", box).value.trim(), telefon: $("#v_telefon", box).value.trim(), iban: $("#v_iban", box).value.replace(/\s/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim(), steuernummer: $("#v_steuernummer", box).value.trim(), provision: isNaN(pr) ? STANDARD_PROVISION : pr, kleinunternehmer: $("#v_ku", box).value === "1", notiz: $("#v_notiz", box).value.trim() };
      await speichern("vertriebler/" + (id || newId()), d, "Gespeichert"); closeSheet();
    };
    $("#vDel", box)?.addEventListener("click", async () => { if (confirm(`${v.name} löschen?`)) { await db.doc("vertriebler/" + id).delete(); closeSheet(); } });
  });
}
function provisionSheet(id) {
  const p = (id && S.provisionen.find((x) => x.id === id)) || { datum: heute(), vertriebler: S.vertriebler.length === 1 ? S.vertriebler[0].id : "" };
  const fest = !!p.nummer, bez = p.buchung && S.buchungen.find((b) => b.id === p.buchung);
  const sites = [...S.sites].sort((a, b) => (a.stage === "gewonnen" ? 0 : 1) - (b.stage === "gewonnen" ? 0 : 1) || (a.name || "").localeCompare(b.name || ""));
  sheet(`<h2>${id ? "Provision" : "Neue Provision"}</h2>
    ${fest ? `<div class="info" style="margin-bottom:12px">Gutschrift ${esc(p.nummer)} ist erstellt – Betrag und Vertriebler sind deshalb fest.</div>` : ""}
    <div class="grid" style="gap:12px">
      <label class="f">Vertriebler<select id="pV" ${fest ? "disabled" : ""}><option value="">– wählen –</option>${S.vertriebler.map((v) => `<option value="${esc(v.id)}"${v.id === p.vertriebler ? " selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
      <label class="f">Kunde (aus dem Board)<select id="pK" ${fest ? "disabled" : ""}><option value="">– frei eingeben –</option>${sites.map((x) => `<option value="${esc(x.id)}"${p.kunde?.siteId === x.id ? " selected" : ""}>${esc(x.name)}${x.stage === "gewonnen" ? "" : " (" + esc(x.stage || "") + ")"}</option>`).join("")}</select></label>
      <label class="f">Kundenname<input id="pKN" value="${esc(p.kunde?.name || "")}" ${fest ? "disabled" : ""}></label>
      <div class="row"><label class="f">Vertrag unterschrieben am<input type="date" id="pD" value="${esc(p.datum || "")}" ${fest ? "disabled" : ""}></label><label class="f">Provision netto (€)<input id="pN" inputmode="decimal" value="${p.netto !== undefined ? eurPlain(p.netto) : ""}" ${fest ? "disabled" : ""}></label></div>
      <p class="small muted" id="pInfo" style="margin:0"></p>
      <label class="f">Notiz<input id="pNotiz" value="${esc(p.notiz || "")}"></label>
    </div>
    ${id ? `<hr class="sep"><div class="grid" style="gap:10px">
      ${p.status === "bezahlt" ? `<p style="margin:0"><span class="badge green">ausgezahlt</span> am ${fmtD(p.bezahltAm)}${bez ? ` · <button class="linkish" data-buchung="${esc(bez.id)}">Überweisung ansehen</button>` : ""}</p><button class="btn btn--small" id="pOffen" style="justify-self:start">Doch nicht ausgezahlt</button>`
        : `<div class="row"><label class="f">Ausgezahlt am<input type="date" id="pBez" value="${heute()}"></label><button class="btn" id="pBezahlt">Als ausgezahlt markieren</button></div><p class="small muted" style="margin:0">Passiert automatisch, sobald die Überweisung aus Tide importiert ist.</p>`}
      <div class="btns"><a class="btn" href="#gutschrift/${esc(id)}" data-close>${fest ? "Gutschrift ansehen" : "Gutschrift erstellen …"}</a></div></div>` : ""}
    <div class="btns" style="margin-top:16px;justify-content:space-between">${id && !fest ? `<button class="btn btn--danger" id="pDel">Löschen</button>` : "<span></span>"}<button class="btn btn--primary" id="pSave">Speichern</button></div>`, (box) => {
    const vSel = $("#pV", box), nIn = $("#pN", box);
    const info = () => {
      const v = S.vertriebler.find((x) => x.id === vSel.value);
      if (!fest && v && !nIn.value) nIn.value = eurPlain(v.provision ?? STANDARD_PROVISION);
      const netto = parseEuro(nIn.value), n = netto;
      $("#pInfo", box).textContent = !v ? "" : v.kleinunternehmer === false ? `+ 19 % USt ${eur(Math.round((netto || 0) * 0.19))} = Auszahlung ${eur(Math.round((netto || 0) * 1.19))}` : `Kleinunternehmer – Auszahlung ${eur(isNaN(n) ? 0 : n)}`;
    };
    vSel.onchange = () => { if (!fest) nIn.value = ""; info(); }; nIn.oninput = info; info();
    $("#pK", box).onchange = (e) => { const x = S.sites.find((y) => y.id === e.target.value); if (x) $("#pKN", box).value = x.name || ""; };
    $("#pSave", box).onclick = async () => {
      if (fest) { await speichern("provisionen/" + id, { notiz: $("#pNotiz", box).value.trim() }, "Gespeichert"); return closeSheet(); }
      const v = S.vertriebler.find((x) => x.id === vSel.value), netto = parseEuro(nIn.value);
      if (!v || isNaN(netto) || !netto || !$("#pKN", box).value.trim()) return toast("Bitte Vertriebler, Kunde und Betrag angeben.");
      const d = { vertriebler: v.id, kunde: { siteId: $("#pK", box).value || null, name: $("#pKN", box).value.trim() }, datum: $("#pD", box).value || heute(), netto, ust: v.kleinunternehmer === false ? Math.round(netto * 0.19) : 0, notiz: $("#pNotiz", box).value.trim() };
      if (!id) { d.status = "offen"; d.erstellt = new Date().toISOString(); }
      await speichern("provisionen/" + (id || newId()), d, "Gespeichert"); closeSheet();
    };
    $("#pDel", box)?.addEventListener("click", async () => { if (confirm("Provision löschen?")) { await db.doc("provisionen/" + id).delete(); closeSheet(); } });
    $("#pBezahlt", box)?.addEventListener("click", async () => { await speichern("provisionen/" + id, { status: "bezahlt", bezahltAm: $("#pBez", box).value || heute() }, "Als ausgezahlt markiert"); closeSheet(); });
    $("#pOffen", box)?.addEventListener("click", async () => { if (p.buchung) await speichern("buchungen/" + p.buchung, { provision: null }); await speichern("provisionen/" + id, { status: "offen", bezahltAm: null, buchung: null }); closeSheet(); });
  });
}
function gutschriftPapier(p) {
  const a = p.absender || einst(), v = p.vertriebler_ || S.vertriebler.find((x) => x.id === p.vertriebler) || {};
  return `<div class="paper" id="paper">
    <div class="kopf"><div style="padding-top:2.6em"><span class="ab">${esc([a.firma, a.strasse, a.plzOrt].filter(Boolean).join(" · "))}</span><div>${esc(v.name || "")}<br>${esc(v.adresse || "").replace(/\n/g, "<br>")}</div></div>
      <div class="meta"><div class="logo">${esc((a.firma || "crestra").split(/\s/)[0])}</div><div style="margin-top:1.4em">${a.inhaber ? `Inhaber ${esc(a.inhaber)}<br>` : ""}${esc(a.strasse || "")}<br>${esc(a.plzOrt || "")}<br>${esc(a.email || "")}</div></div></div>
    <div class="meta" style="text-align:left;display:grid;grid-template-columns:auto 1fr;gap:.1em 1.4em;margin-bottom:1.6em">
      <span>Gutschrift Nr.</span><b>${esc(p.nummer || "wird beim Erstellen vergeben")}</b>
      <span>Datum</span><span>${fmtD(p.gutschriftDatum || heute())}</span>
      <span>Leistungsdatum</span><span>${fmtD(p.datum)}</span>
      <span>Steuernummer des Vertrieblers</span><span>${esc(v.steuernummer || "–")}</span>
    </div>
    <h2>Gutschrift</h2>
    <div>Für die erfolgreiche Vermittlung des folgenden Auftrags schreiben wir Ihnen gut:</div>
    <table><thead><tr><th style="width:2.2em">Pos.</th><th>Beschreibung</th><th class="r">Betrag</th></tr></thead><tbody>
      <tr><td>1</td><td>Vermittlungsprovision: Vertragsabschluss mit ${esc(p.kunde?.name || "")} am ${fmtD(p.datum)}</td><td class="r">${eur(p.netto)}</td></tr>
      ${provUst(p) ? `<tr><td></td><td>zzgl. 19 % Umsatzsteuer</td><td class="r">${eur(provUst(p))}</td></tr>` : ""}
      <tr class="sum"><td></td><td>Auszahlungsbetrag</td><td class="r">${eur(provBrutto(p))}</td></tr></tbody></table>
    ${provUst(p) ? "" : `<div class="hinweis">Der leistende Unternehmer ist Kleinunternehmer im Sinne von § 19 UStG; es wird keine Umsatzsteuer berechnet.</div>`}
    <div class="hinweis">Der Betrag wird auf Ihr Konto ${v.iban ? `IBAN ${esc(v.iban)} ` : ""}überwiesen. Bitte prüfen Sie die Gutschrift; widersprechen Sie nicht innerhalb von 14 Tagen, gilt sie als anerkannt.</div>
    <div class="hinweis">Mit freundlichen Grüßen<br>${esc(a.inhaber || a.firma || "")}</div>
    <div class="fuss"><div>${esc(a.firma || "")}${a.inhaber ? `<br>Inh. ${esc(a.inhaber)}` : ""}<br>${esc(a.strasse || "")}<br>${esc(a.plzOrt || "")}</div><div>${esc(a.email || "")}${a.telefon ? `<br>${esc(a.telefon)}` : ""}${a.steuernummer ? `<br>St.-Nr. ${esc(a.steuernummer)}` : ""}</div><div>${esc(a.bankname || "Bankverbindung")}<br>IBAN ${esc(a.iban || "–")}</div></div>
  </div>`;
}
function renderGutschrift(id) {
  const view = $("#view"), p = S.provisionen.find((x) => x.id === id);
  if (!p) { view.innerHTML = S.geladen.has("provisionen") ? `<p class="pad">Nicht gefunden. <a href="#vertrieb">Zum Vertrieb</a></p>` : `<p class="muted pad">Lädt …</p>`; return; }
  const v = S.vertriebler.find((x) => x.id === p.vertriebler) || {};
  const fehlt = [!v.adresse && "Anschrift des Vertrieblers", !v.steuernummer && "Steuernummer des Vertrieblers", !firmaKomplett() && "deine Firmendaten (Einstellungen)"].filter(Boolean);
  view.innerHTML = `<div class="inv-wrap"><div class="no-print">
    <a href="#vertrieb" class="small">← Vertrieb</a>
    <h1 style="margin-top:8px">${p.nummer ? esc(p.nummer) : "Gutschrift"}</h1><p class="muted">${esc(v.name || "")} · ${esc(p.kunde?.name || "")} · ${eur(provBrutto(p))}</p>
    <div class="card grid" style="gap:10px">
      ${p.nummer ? `<div class="btns"><button class="btn btn--primary" data-act="drucken">Drucken / als PDF speichern</button>${v.email ? `<a class="btn" href="mailto:${encodeURIComponent(v.email)}?subject=${encodeURIComponent("Gutschrift " + p.nummer)}&body=${encodeURIComponent(`Hallo ${v.name},\n\nanbei die Gutschrift ${p.nummer} über deine Provision für ${p.kunde?.name || ""} (${eur(provBrutto(p))}).\n\nViele Grüße\n${einst().inhaber || ""}`)}">E-Mail vorbereiten</a>` : ""}</div>
        <p class="small muted" style="margin:0">Gutschriften sind wie Rechnungen festgeschrieben. Stimmt etwas nicht, sprich mit dem Vertriebler und erstelle für die Korrektur eine neue Provision.</p>`
      : `${fehlt.length ? `<div class="info warn">Für die Gutschrift fehlt noch: ${fehlt.join(", ")}. <button class="linkish" data-vertriebler="${esc(v.id || "")}">Vertriebler bearbeiten</button></div>` : ""}
        <p style="margin:0">Mit einer Gutschrift rechnest du die Provision selbst ab, der Vertriebler muss dann keine Rechnung schreiben. Das muss mit ihm vereinbart sein (am besten im Vertriebsvertrag).</p>
        <button class="btn btn--primary" data-act="gutschrift-fest" data-id="${esc(id)}" ${fehlt.length ? "disabled" : ""} style="justify-self:start">Gutschrift erstellen (${naechsteGutschrift(heute().slice(0, 4))})</button>`}
    </div></div><div class="paper-wrap">${gutschriftPapier(p)}</div></div>`;
}
async function gutschriftFest(id) {
  const p = S.provisionen.find((x) => x.id === id), v = S.vertriebler.find((x) => x.id === p.vertriebler) || {}, e = einst();
  const nummer = naechsteGutschrift(heute().slice(0, 4));
  if (!confirm(`Gutschrift ${nummer} erstellen? Danach ist sie festgeschrieben.`)) return;
  await speichern("provisionen/" + id, { nummer, gutschriftDatum: heute(), absender: { firma: e.firma, inhaber: e.inhaber, strasse: e.strasse, plzOrt: e.plzOrt, email: e.email, telefon: e.telefon, steuernummer: e.steuernummer, iban: e.iban, bankname: e.bankname }, vertriebler_: { name: v.name, adresse: v.adresse, steuernummer: v.steuernummer, iban: v.iban } }, `Gutschrift ${nummer} erstellt`);
}

/* ================= Auswertung (EÜR) ================= */
VIEWS.auswertung = () => {
  const jahre = [...new Set([new Date().getFullYear(), ...sichtbar().map((b) => +(b.datum || "").slice(0, 4)).filter(Boolean)])].sort((a, b) => b - a);
  const j = F.jahr, z = jahresZahlen(j);
  const ohne = sichtbar().filter((b) => (b.datum || "").startsWith(j) && !katVon(b)), fehlt = sichtbar().filter((b) => (b.datum || "").startsWith(j) && brauchtBeleg(b));
  const zeilen = (t) => KAT.filter((k) => k.t === t && z.kat[k.id]).map((k) => `<tr><td>${esc(k.name)} <span class="muted small">(${z.kat[k.id].n})</span>${k.faktor ? `<div class="small muted">${eur(z.kat[k.id].brutto)} gezahlt, davon ${k.faktor * 100} % absetzbar</div>` : ""}</td><td class="r">${eur(z.kat[k.id].wert)}</td></tr>`).join("") || `<tr><td class="muted">keine</td><td></td></tr>`;
  return `<div class="head"><h1>Auswertung ${j}</h1><div class="btns no-print"><select class="in" id="jahr" style="width:auto">${jahre.map((y) => `<option${y === j ? " selected" : ""}>${y}</option>`).join("")}</select><button class="btn" data-act="export">CSV für Steuerberater</button><button class="btn" data-act="drucken">Drucken</button></div></div>
    ${ohne.length || fehlt.length ? `<div class="info warn no-print" style="margin-bottom:14px">${ohne.length ? `<a href="#umsaetze/ohne-kategorie">${ohne.length} Umsätze ohne Kategorie</a> fehlen noch in der Rechnung. ` : ""}${fehlt.length ? `<a href="#umsaetze/ohne-beleg">${fehlt.length} Ausgaben ohne Beleg</a>.` : ""}</div>` : ""}
    <div class="grid g3 stats" style="margin-bottom:14px"><div class="card stat"><span>Betriebseinnahmen</span><strong>${eur(z.e)}</strong></div><div class="card stat"><span>Betriebsausgaben</span><strong>${eur(z.a)}</strong></div><div class="card stat"><span>Gewinn</span><strong>${eur(z.e - z.a)}</strong></div></div>
    <div class="card print-euer">
      <h2>Einnahmen-Überschuss-Rechnung ${j}</h2>
      <p class="small muted">${esc(einst().firma || "crestra")}${einst().inhaber ? ", Inhaber " + esc(einst().inhaber) : ""} · Kleinunternehmer nach § 19 UStG: alle Beträge brutto, keine Umsatzsteuer. Nach Zahlungsdatum (Zufluss/Abfluss).</p>
      <table class="tbl"><thead><tr><th>Betriebseinnahmen</th><th class="r">Betrag</th></tr></thead><tbody>${zeilen("e")}<tr class="total"><td>Summe Einnahmen</td><td class="r">${eur(z.e)}</td></tr></tbody></table>
      <table class="tbl" style="margin-top:18px"><thead><tr><th>Betriebsausgaben</th><th class="r">Betrag</th></tr></thead><tbody>${zeilen("a")}<tr class="total"><td>Summe Ausgaben</td><td class="r">${eur(z.a)}</td></tr></tbody></table>
      <table class="tbl" style="margin-top:18px"><tbody><tr class="total"><td>Gewinn ${j}</td><td class="r">${eur(z.e - z.a)}</td></tr></tbody></table>
      <p class="small muted" style="margin-top:14px">Hilfe für die Anlage EÜR in ELSTER, keine Steuerberatung. Geräte über 800 € netto müssen über mehrere Jahre abgeschrieben werden und gehören nicht in „GWG“. Das Arbeitszimmer und die Kilometerpauschale für Fahrten mit dem Privatauto trägst du direkt in ELSTER ein.</p>
    </div>`;
};
VIEWS.auswertungMount = (v) => { $("#jahr", v).onchange = (e) => { F.jahr = +e.target.value; e.target.blur(); render(); }; };
function exportCsv() {
  const j = F.jahr, q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = sichtbar().filter((b) => (b.datum || "").startsWith(j)).sort((a, b) => a.datum.localeCompare(b.datum));
  const out = [["Datum", "Betrag", "Gegenseite", "Verwendungszweck", "Kategorie", "Art", "Absetzbar", "Rechnung", "Belege", "Notiz", "Quelle"].map(q).join(";")];
  for (const b of rows) {
    const k = KATM[katVon(b)];
    out.push([fmtD(b.datum), eurPlain(b.betrag), b.gegenpartei, b.zweck, k?.name || "OHNE KATEGORIE", k ? { e: "Einnahme", a: "Ausgabe", n: "neutral" }[k.t] : "", k && k.t !== "n" ? eurPlain(Math.round(Math.abs(b.betrag) * (k.faktor || 1))) : "", S.rechnungen.find((r) => r.id === b.rechnung)?.nummer || "", belegeZu(b.id).map((x) => x.name).join(" | ") || (b.ohneBeleg ? "nicht nötig" : ""), b.notiz, b.quelle].map(q).join(";"));
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8" })); a.download = `crestra-buchungen-${j}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ================= Einstellungen & Bank ================= */
async function bankAufruf(action, extra = {}) {
  const { data, error } = await SB.functions.invoke("bank", { body: { action, ...extra } });
  if (error) { let msg = error.message; try { const j = await error.context.json(); msg = j.fehler || j.hinweis || msg; } catch {} throw new Error(msg); }
  if (data?.fehler) throw new Error(data.fehler);
  return data;
}
let bankInfo = null; // { eingerichtet, hinweis }
const BANK_ZURUECK = new URL("bank.html", location.href).href;
VIEWS.einstellungen = () => {
  const e = einst(), b = S.bank, verbunden = b.konten?.length;
  const f = (k, t, ph = "", typ = "text") => `<label class="f">${t}<input type="${typ}" data-e="${k}" value="${esc(e[k] ?? "")}" placeholder="${esc(ph)}"></label>`;
  const tage = b.gueltigBis ? Math.round((new Date(b.gueltigBis) - Date.now()) / 864e5) : null;
  return `<h1>Einstellungen</h1>
  <section class="card" style="margin-bottom:14px" id="bank">
    <h2>Geschäftskonto (Tide)</h2>
    ${verbunden ? `<p><span class="badge green">verbunden</span> ${esc(b.bank)} · ${b.konten.map((k) => esc(k.iban || k.name)).join(", ")}</p>
      <p class="small muted">Letzter Abruf: ${b.letzterAbruf ? new Date(b.letzterAbruf).toLocaleString("de-DE") : "noch nie"}${tage !== null ? ` · Freigabe gültig bis ${fmtD(b.gueltigBis.slice(0, 10))} (${tage} Tage)` : ""}. Die Bank verlangt alle 90 Tage eine neue Freigabe.</p>
      <div class="btns"><button class="btn btn--primary" data-act="abruf">↻ Umsätze abrufen</button><button class="btn" data-act="bank-verbinden">Neu verbinden</button><button class="btn btn--danger" data-act="bank-trennen">Trennen</button></div>`
    : `<p>Tide ist bei der automatischen Bankschnittstelle nicht verfügbar. Deshalb kommen die Umsätze per Datei – am besten einmal pro Woche, dauert eine Minute:</p>
      <ol class="steps">
        <li>Tide-App: <b>Zahlungen</b> → unter der Liste <b>Mehr anzeigen</b></li>
        <li>Zeitraum filtern (z. B. seit dem letzten Import – doppelte werden übersprungen)</li>
        <li>Oben rechts <b>Teilen-Symbol</b> → CSV-Art <b>„Standard“</b> → <b>Exportieren</b> → „In Dateien sichern“</li>
        <li>Hier auf <b>CSV importieren</b> tippen und die Datei wählen</li>
      </ol>
      <p class="small muted">Am Mac: Tide im Browser → Konten → Trichter-Symbol neben dem Kontostand → Filter anwenden → Exportieren.</p>
      <div class="btns"><button class="btn btn--primary" data-act="csv">CSV importieren</button></div>
      <details style="margin-top:12px"><summary class="small muted">Andere Bank automatisch verbinden</summary><p class="muted">Die App liest Umsätze und Kontostand direkt von deiner Bank (nur Lesezugriff über die EU-Kontoschnittstelle PSD2). Niemand kann darüber Geld bewegen.</p>
      ${bankInfo && bankInfo.eingerichtet === false ? `<div class="info warn"><b>Noch ein einmaliger Schritt nötig:</b> Der Zugang zur Bankschnittstelle (Enable Banking, kostenlos für das eigene Konto) ist noch nicht eingerichtet. Die Anleitung steht in LIESMICH.md im Projektordner. Bis dahin: Umsätze als CSV aus dem Online-Banking exportieren und <button class="linkish" data-act="csv">hier importieren</button>.</div>` : `<div class="btns"><button class="btn" data-act="bank-verbinden">Konto verbinden</button></div>`}</details>`}
  </section>
  <section class="card" style="margin-bottom:14px">
    <h2>Firmendaten für Rechnungen</h2>
    <p class="small muted" style="margin-top:-4px">Pflichtangaben auf jeder Rechnung. Wird beim Tippen gespeichert.</p>
    <div class="grid g2" style="gap:12px" id="einstForm">
      ${f("firma", "Firma", "crestra")}${f("inhaber", "Inhaber", "Nils Cremerius")}
      ${f("strasse", "Straße und Nr.")}${f("plzOrt", "PLZ und Ort")}
      ${f("email", "E-Mail", "", "email")}${f("telefon", "Telefon", "", "tel")}
      ${f("web", "Website")}${f("steuernummer", "Steuernummer", "vom Finanzamt, z. B. 201/123/45678")}
      ${f("iban", "IBAN")}${f("bic", "BIC")}
      ${f("bankname", "Bank")}${f("zahlungsziel", "Zahlungsziel (Tage)", "14", "number")}
    </div>
  </section>
  <section class="card" style="margin-bottom:14px">
    <h2>Kontostand ohne Bankverbindung</h2>
    <p class="small muted" style="margin-top:-4px">Nur nötig, solange die Bank nicht verbunden ist: Kontostand an einem Stichtag, ab dem alle Umsätze in der App sind.</p>
    <div class="row"><label class="f">Stichtag<input type="date" data-e="anfangsdatum" value="${esc(e.anfangsdatum || "")}"></label><label class="f">Kontostand an diesem Tag (€)<input data-e="anfangssaldo" inputmode="decimal" value="${e.anfangssaldo !== undefined ? eurPlain(e.anfangssaldo) : ""}"></label></div>
  </section>
  <section class="card" style="margin-bottom:14px">
    <h2>Kategorie-Regeln</h2>
    <p class="small muted" style="margin-top:-4px">Entstehen, wenn du bei einem Umsatz „diese Kategorie merken“ ankreuzt. Gilt für alle Umsätze, deren Name oder Zweck den Text enthält.</p>
    ${(e.regeln || []).length ? `<table class="tbl">${e.regeln.map((r, i) => `<tr><td>„${esc(r.muster)}“</td><td>${esc(KATM[r.kategorie]?.name || r.kategorie)}</td><td class="r"><button class="btn btn--small" data-regel-weg="${i}">Entfernen</button></td></tr>`).join("")}</table>` : `<p class="muted">Noch keine Regeln.</p>`}
  </section>
  <section class="card">
    <h2>Daten</h2>
    <div class="btns"><button class="btn" data-act="sicherung">Sicherung herunterladen (JSON)</button><a class="btn" href="../crestra-board/">Zum Kundenboard</a><button class="btn btn--danger" data-act="abmelden">Abmelden</button></div>
    <p class="small muted">Aufbewahrungspflicht: Rechnungen, Belege und Buchungen 8 bis 10 Jahre. Lade einmal im Quartal eine Sicherung herunter und leg sie zu den Belegen.</p>
  </section>`;
};
VIEWS.einstellungenMount = (v) => {
  const t = {};
  v.addEventListener("input", (ev) => {
    const el = ev.target, k = el.dataset.e; if (!k) return;
    clearTimeout(t[k]);
    t[k] = setTimeout(() => {
      let val = el.value.trim();
      if (k === "anfangssaldo") { val = parseEuro(val); if (isNaN(val)) return; }
      if (k === "zahlungsziel") val = +val || 14;
      if (k === "iban") val = val.replace(/\s/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
      speichern("buchhaltung/einstellungen", { [k]: val });
    }, 500);
  });
  v.addEventListener("click", (ev) => { const x = ev.target.closest("[data-regel-weg]"); if (x) { const r = [...(einst().regeln || [])]; r.splice(+x.dataset.regelWeg, 1); speichern("buchhaltung/einstellungen", { regeln: r }, "Regel entfernt"); } });
};
VIEWS.mehr = () => `<h1>Mehr</h1><div class="todo"><a href="#vertrieb"><span>Vertrieb & Provisionen</span><b>›</b></a><a href="#auswertung"><span>Auswertung / EÜR</span><b>›</b></a><a href="#einstellungen"><span>Einstellungen, Bank, Firmendaten</span><b>›</b></a><a href="../crestra-board/"><span>Kundenboard</span><b>↗</b></a></div>`;
async function bankVerbinden() {
  sheet(`<h2>Konto verbinden</h2><p class="muted">Lädt die Liste der Banken …</p>`);
  let d; try { d = await bankAufruf("banken"); } catch (e) { return sheet(`<h2>Konto verbinden</h2><div class="info bad">${esc(e.message)}</div>`); }
  if (d.eingerichtet === false) { bankInfo = d; return sheet(`<h2>Konto verbinden</h2><div class="info warn">${esc(d.hinweis)} Anleitung: LIESMICH.md im Projektordner.</div>`); }
  const banken = d.banken || [];
  const zuerst = /qonto|kontist|n26|holvi|fyrst|finom|vivid|revolut|sparkasse|volksbank|commerzbank|deutsche bank|postbank|ing|dkb|comdirect|gls|tomorrow/i;
  sheet(`<h2>Bank wählen</h2><input class="in" id="bSuche" placeholder="Bank suchen …" autofocus><div class="list" id="bListe" style="margin-top:10px;max-height:55vh;overflow:auto"></div><p class="small muted">Du wirst zu deiner Bank weitergeleitet, meldest dich dort an und gibst den Lesezugriff frei. Danach kommst du automatisch hierher zurück.</p>`, (box) => {
    const zeig = () => {
      const q = $("#bSuche", box).value.toLowerCase();
      const l = banken.filter((x) => !q || x.name.toLowerCase().includes(q)).sort((a, b) => (zuerst.test(b.name) ? 1 : 0) - (zuerst.test(a.name) ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 80);
      $("#bListe", box).innerHTML = l.map((x) => `<button class="it" style="width:100%;border:0;background:none;text-align:left;grid-template-columns:40px 1fr" data-bank="${esc(x.name)}">${x.logo ? `<img src="${esc(x.logo)}" alt="" style="width:32px;height:32px;object-fit:contain">` : "<span></span>"}<span class="t"><b>${esc(x.name)}</b></span></button>`).join("") || `<div class="empty">Keine Bank gefunden.</div>`;
    };
    $("#bSuche", box).oninput = zeig; zeig();
    $("#bListe", box).onclick = async (e) => {
      const x = e.target.closest("[data-bank]"); if (!x) return;
      x.disabled = true; toast("Weiterleitung zur Bank …", 10000);
      try { sessionStorage.setItem("eb_bank", x.dataset.bank); const r = await bankAufruf("start", { bank: x.dataset.bank, zurueck: BANK_ZURUECK }); location.href = r.url; }
      catch (err) { toast(err.message, 6000); x.disabled = false; }
    };
  });
}
let abrufLaeuft = false;
async function bankAbruf(still) {
  if (abrufLaeuft) return; abrufLaeuft = true;
  if (!still) toast("Rufe Umsätze ab …", 30000);
  try { const r = await bankAufruf("abruf"); if (!still || r.neu) toast(r.neu ? `${r.neu} neue Umsätze` : "Alles aktuell"); }
  catch (e) { if (!still) toast("Abruf fehlgeschlagen: " + e.message, 6000); else console.warn(e); }
  finally { abrufLaeuft = false; }
}
async function bankRueckkehr() {
  const code = sessionStorage.getItem("eb_code"), err = sessionStorage.getItem("eb_fehler");
  sessionStorage.removeItem("eb_code"); sessionStorage.removeItem("eb_fehler");
  if (err) { location.hash = "#einstellungen"; return toast("Bank-Freigabe abgebrochen: " + err, 6000); }
  if (!code) return;
  location.hash = "#einstellungen"; toast("Verbinde Konto …", 30000);
  try { const r = await bankAufruf("abschluss", { code, bank: sessionStorage.getItem("eb_bank") || "" }); toast(`${r.konten.length} Konto verbunden. Lade Umsätze …`, 30000); await bankAbruf(); }
  catch (e) { toast("Verbinden fehlgeschlagen: " + e.message, 8000); }
}
async function sicherung() {
  const daten = { erstellt: new Date().toISOString(), buchungen: S.buchungen, rechnungen: S.rechnungen, belege: S.belege, einstellungen: S.einst, bank: { ...S.bank, session: undefined } };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(daten, null, 1)], { type: "application/json" })); a.download = `crestra-buchhaltung-${heute()}.json`; a.click();
  toast("Sicherung gespeichert. Die Beleg-Dateien selbst liegen im Supabase-Speicher.");
}

/* ================= Klicks ================= */
document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.closest("select, input, textarea")) return;
  const act = t.closest("[data-act]");
  const fil = t.closest("[data-filter]"), rf = t.closest("[data-rfilter]"), bf = t.closest("[data-bfilter]"), ok = t.closest("[data-ok]");
  if (fil) { F.filter = fil.dataset.filter; if (location.hash.startsWith("#umsaetze/")) history.replaceState(null, "", "#umsaetze"); return render(); }
  if (rf) { F.rFilter = rf.dataset.rfilter; if (location.hash.startsWith("#rechnungen/")) history.replaceState(null, "", "#rechnungen"); return render(); }
  if (bf) { F.bFilter = bf.dataset.bfilter; return render(); }
  if (ok) { e.stopPropagation(); return speichern("buchungen/" + ok.dataset.ok, { kategorie: ok.dataset.k }); }
  if (!act) {
    const bel = t.closest("[data-beleg]"); if (bel) return belegSheet(bel.dataset.beleg);
    const ve = t.closest("[data-vertriebler]"); if (ve) return vertrieblerSheet(ve.dataset.vertriebler || undefined);
    const pr = t.closest("[data-provision]"); if (pr) return provisionSheet(pr.dataset.provision);
    const bu = t.closest("[data-buchung]"); if (bu) return buchungSheet(bu.dataset.buchung);
    return;
  }
  const id = act.dataset.id;
  switch (act.dataset.act) {
    case "csv": return $("#fileCsv").click();
    case "neu-buchung": return neueBuchungSheet();
    case "abruf": return bankAbruf();
    case "beleg-hoch": belegZiel = act.dataset.buchungZiel || null; return $("#fileBeleg").click();
    case "neu-rechnung": { const nid = await neueRechnung(); location.hash = "#rechnung/" + nid; return; }
    case "vertriebler-neu": return vertrieblerSheet();
    case "provision-neu": return provisionSheet();
    case "gutschrift-fest": return gutschriftFest(id);
    case "festschreiben": return festschreiben(id);
    case "entwurf-weg": if (confirm("Entwurf löschen?")) { ED = null; await db.doc("rechnungen/" + id).delete(); location.hash = "#rechnungen"; } return;
    case "drucken": return print();
    case "bezahlt": return speichern("rechnungen/" + id, { status: "bezahlt", bezahltAm: $("#rBez")?.value || heute() }, "Als bezahlt markiert");
    case "unbezahlt": { const r = S.rechnungen.find((x) => x.id === id); if (r.buchung) await speichern("buchungen/" + r.buchung, { rechnung: null }); return speichern("rechnungen/" + id, { status: "offen", bezahltAm: null, buchung: null }); }
    case "storno": return stornieren(id);
    case "kopie": { const r = S.rechnungen.find((x) => x.id === id); const nid = newId(); await db.doc("rechnungen/" + nid).set({ status: "entwurf", datum: heute(), zahlungsziel: r.zahlungsziel, kunde: r.kunde, positionen: r.positionen.map((p) => ({ ...p, preis: Math.abs(p.preis) })), einleitung: r.einleitung || "", leistungVon: heute(), erstellt: new Date().toISOString() }); location.hash = "#rechnung/" + nid; return; }
    case "export": return exportCsv();
    case "bank-verbinden": return bankVerbinden();
    case "bank-trennen": if (confirm("Bankverbindung trennen? Bereits geladene Umsätze bleiben erhalten.")) { try { await bankAufruf("trennen"); toast("Getrennt"); } catch (er) { toast(er.message); } } return;
    case "sicherung": return sicherung();
    case "abmelden": return window.crestraLogout();
    case "ignorieren": if (confirm("Umsatz ausblenden? Er zählt dann nirgends mehr mit (z. B. bei Doppelungen).")) { await speichern("buchungen/" + id, { ignoriert: true }, "Ausgeblendet"); closeSheet(); } return;
    case "loeschen": if (confirm("Umsatz löschen?")) { await db.doc("buchungen/" + id).delete(); closeSheet(); toast("Gelöscht"); } return;
  }
});
document.addEventListener("change", (e) => {
  const s = e.target.closest("[data-kat]");
  if (s) { speichern("buchungen/" + s.dataset.kat, { kategorie: s.value || null, kategorieAuto: false, kategorieGeprueft: true }); s.blur(); }
});
$("#fileCsv").addEventListener("change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) csvSheet(await csvLesen(f), f.name); });

/* ================= Start ================= */
(async function start() {
  for (let i = 0; !window.crestraDB && i < 100; i++) await new Promise((r) => setTimeout(r, 30));
  db = await window.crestraDB(); SB = window.crestraSB;
  UID = (await SB.auth.getSession()).data.session?.user?.id;
  let erst = true;
  const fertig = (name) => { S.geladen.add(name); if (S.geladen.size >= 7 && erst) { erst = false; nachStart(); } };
  let rt; const neu = () => { clearTimeout(rt); rt = setTimeout(() => { if ($("#sheet").hidden) render(); abgleichen(); }, 40); };
  const liste = (col, key) => db.collection(col).onSnapshot((s) => { S[key] = s.docs.map((d) => ({ id: d.id, ...d.data() })); fertig(col); neu(); }, (e) => { console.error(e); fertig(col); });
  liste("buchungen", "buchungen"); liste("rechnungen", "rechnungen"); liste("belege", "belege"); liste("sites", "sites"); liste("vertriebler", "vertriebler"); liste("provisionen", "provisionen");
  db.collection("buchhaltung").onSnapshot((s) => { const m = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); S.einst = m.einstellungen || {}; S.bank = m.bank || {}; fertig("buchhaltung"); neu(); }, () => fertig("buchhaltung"));
  render();
})();
function nachStart() {
  // Firmendaten einmalig vorbelegen
  if (!S.einst.firma) speichern("buchhaltung/einstellungen", { firma: "crestra", inhaber: "Nils Cremerius", zahlungsziel: 14, ...S.einst });
  bankRueckkehr();
  if (S.bank.konten?.length && (!S.bank.letzterAbruf || Date.now() - new Date(S.bank.letzterAbruf) > 6 * 36e5)) bankAbruf(true);
}
