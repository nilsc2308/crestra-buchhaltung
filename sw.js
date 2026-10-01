// Offline-Speicher für die App-Hülle. Daten (Supabase) und Belege werden nie zwischengespeichert.
const CACHE = "buchhaltung-v3";
const HUELLE = ["./", "index.html", "styles.css?v=2", "app.js?v=3", "db.js", "config.js", "manifest.webmanifest", "icons/icon.svg",
  "fonts/bricolage-grotesque-latin-wght-normal.woff2", "fonts/hanken-grotesk-latin-wght-normal.woff2", "fonts/jetbrains-mono-latin-wght-normal.woff2"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(HUELLE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== CACHE).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // Supabase, Bank, CDN: immer direkt
  // Netz zuerst (immer aktuelle Fassung), bei Funkloch aus dem Speicher
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
