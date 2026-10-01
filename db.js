// Datenbank-Anbindung (Supabase) – gemeinsam mit dem crestra-Kundenboard, gleiche Anmeldung.
// Stellt dieselbe kleine Schnittstelle bereit wie das alte claude.ai-Board
// (db.doc("sites/x").update(...), db.collection("chat").orderBy(...).onSnapshot(...)),
// damit der Board-Code unverändert bleiben kann. Dazu die Anmeldung per E-Mail + Passwort.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, LOGIN_EMAIL } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

/* ---------- Dokumentenspeicher ---------- */

const cache = new Map(); // Sammlung -> Map(id -> data)
const listeners = new Set(); // () => void, bei jeder Änderung aufgerufen
const loading = new Map(); // Sammlung -> Promise (erstes Laden)
let channel = null;

const notify = () => listeners.forEach((fn) => fn());
const split = (path) => {
  const i = path.lastIndexOf("/");
  return [path.slice(0, i), path.slice(i + 1)];
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

function load(col) {
  if (!loading.has(col)) {
    loading.set(
      col,
      sb.from("docs").select("id,data").eq("collection", col).then(({ data, error }) => {
        if (error) {
          loading.delete(col);
          throw error;
        }
        cache.set(col, new Map(data.map((r) => [r.id, r.data])));
      })
    );
  }
  return loading.get(col);
}

function live() {
  if (channel) return;
  channel = sb
    .channel("docs")
    .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
      const row = p.eventType === "DELETE" ? p.old : p.new;
      if (!row || !cache.has(row.collection)) return;
      if (p.eventType === "DELETE") cache.get(row.collection).delete(row.id);
      else cache.get(row.collection).set(row.id, row.data);
      notify();
    })
    .subscribe((status) => {
      // nach einem Verbindungsabbruch alles frisch laden, damit nichts verpasst wird
      if (status === "SUBSCRIBED" && cache.size) {
        [...cache.keys()].forEach((c) => loading.delete(c));
        Promise.all([...cache.keys()].map(load)).then(notify, () => {});
      }
    });
}

function watch(col, compute, next, error) {
  let last;
  const run = () => {
    const out = compute(cache.get(col) || new Map());
    const key = JSON.stringify(out.key);
    if (key !== last) {
      last = key;
      next(out.snap);
    }
  };
  load(col).then(() => {
    listeners.add(run);
    live();
    run();
  }, (e) => error && error(e));
  return () => listeners.delete(run);
}

function docRef(path) {
  const [col, id] = split(path);
  const local = (fn) => {
    if (!cache.has(col)) cache.set(col, new Map());
    fn(cache.get(col));
    notify();
  };
  return {
    id,
    async set(data) {
      local((m) => m.set(id, data));
      const { error } = await sb.from("docs").upsert({ collection: col, id, data }, { onConflict: "owner,collection,id" });
      if (error) throw error;
    },
    async update(patch) {
      local((m) => m.set(id, Object.assign({}, m.get(id), patch)));
      const { error } = await sb.rpc("doc_merge", { p_collection: col, p_id: id, p_patch: patch });
      if (error) throw error;
    },
    async delete() {
      local((m) => m.delete(id));
      const { error } = await sb.from("docs").delete().eq("collection", col).eq("id", id);
      if (error) throw error;
    },
    onSnapshot(next, error) {
      return watch(col, (m) => {
        const data = m.get(id);
        return { key: data ?? null, snap: { id, exists: data !== undefined, data: () => data } };
      }, next, error);
    },
  };
}

function query(col, order = null, dir = "asc", lim = null) {
  return {
    orderBy: (field, d = "asc") => query(col, field, d, lim),
    limit: (n) => query(col, order, dir, n),
    doc: (id) => docRef(col + "/" + (id || newId())),
    onSnapshot(next, error) {
      return watch(col, (m) => {
        let rows = [...m.entries()].map(([id, data]) => ({ id, data }));
        rows.sort((a, b) => (order ? String(a.data[order] ?? "￿").localeCompare(String(b.data[order] ?? "￿")) : a.id.localeCompare(b.id)) * (dir === "desc" ? -1 : 1));
        if (lim) rows = rows.slice(0, lim);
        return { key: rows, snap: { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) } };
      }, next, error);
    },
  };
}

const db = { doc: docRef, collection: (c) => query(c) };

/* ---------- Anmeldung ---------- */

// Kommt man über den Link aus der „Passwort festlegen“-E-Mail, meldet Supabase PASSWORD_RECOVERY.
let recovery = /type=recovery/.test(location.hash);
sb.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") recovery = true; });

const $ = (id) => document.getElementById(id);
const REDIRECT = location.origin + location.pathname;

function showForm(mode) {
  const f = $("loginForm");
  f.dataset.mode = mode;
  $("loginMsg").textContent = "";
  $("loginPass").value = "";
  $("loginPass").autocomplete = mode === "new" ? "new-password" : "current-password";
  $("loginPass").placeholder = mode === "new" ? "Neues Passwort (mind. 8 Zeichen)" : "Passwort";
  $("loginSubmit").textContent = mode === "new" ? "Passwort speichern" : "Anmelden";
  $("loginIntro").textContent = mode === "new" ? "Leg dein Passwort fest. Danach bist du angemeldet." : "Melde dich mit deiner E-Mail und deinem Passwort an.";
  $("loginEmail").hidden = mode === "new";
  $("loginReset").hidden = mode === "new";
}

// Wartet, bis jemand angemeldet ist (zeigt sonst das Anmeldefenster), und gibt dann die Datenbank zurück.
window.crestraDB = async function () {
  const { data } = await sb.auth.getSession();
  if (data.session && !recovery) return db;
  const box = $("login"), form = $("loginForm"), msg = $("loginMsg"), email = $("loginEmail"), pass = $("loginPass");
  box.hidden = false;
  email.value = LOGIN_EMAIL || "";
  showForm(data.session && recovery ? "new" : "login");

  $("loginShow").onclick = () => { pass.type = pass.type === "password" ? "text" : "password"; };
  email.addEventListener("input", () => { email.value = email.value.replace(/\s/g, "").toLowerCase(); });

  $("loginReset").onclick = async () => {
    const mail = email.value.trim();
    if (!mail) { msg.textContent = "Bitte zuerst die E-Mail eintragen."; email.focus(); return; }
    const { error } = await sb.auth.resetPasswordForEmail(mail, { redirectTo: REDIRECT });
    msg.textContent = error
      ? (/rate|seconds|limit/i.test(error.message) ? "Bitte etwas warten und dann nochmal versuchen." : "Das hat nicht geklappt – bitte nochmal versuchen.")
      : "E-Mail ist unterwegs. Tipp auf den Link darin, dann legst du dein Passwort fest.";
  };

  return new Promise((resolve) => {
    const done = () => {
      box.hidden = true;
      if (location.hash) history.replaceState(null, "", location.pathname);
      resolve(db);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("loginSubmit");
      btn.disabled = true;
      msg.textContent = "";
      if (form.dataset.mode === "new") {
        if (pass.value.length < 8) { msg.textContent = "Bitte mindestens 8 Zeichen."; btn.disabled = false; return; }
        const { error } = await sb.auth.updateUser({ password: pass.value });
        btn.disabled = false;
        if (error) { msg.textContent = "Das Passwort konnte nicht gespeichert werden – bitte nochmal."; return; }
        recovery = false;
        done();
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim().toLowerCase(), password: pass.value.trim() });
        btn.disabled = false;
        if (error) {
          msg.textContent = (/invalid login/i.test(error.message) ? "E-Mail oder Passwort stimmt nicht." : "Anmeldung fehlgeschlagen.")
            + " (Fehler: " + (error.status || "") + " " + error.message + ")";
          return;
        }
        try { localStorage.setItem("kb_email", email.value.trim()); } catch (e) {}
        done();
      }
    };
    // Recovery-Link: Sitzung kommt evtl. erst kurz nach dem Laden an
    sb.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") showForm("new"); });
  });
};

window.crestraLogout = async () => {
  await sb.auth.signOut();
  location.reload();
};

/* ---------- Zusätzlich für die Buchhaltung: Dateispeicher (Belege) und Server-Funktion (Bank) ---------- */
window.crestraSB = sb;
