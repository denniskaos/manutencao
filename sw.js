// Service worker: permite instalar a aplicação e receber notificações.
const CACHE = "manutencao-v13";
const SHELL = ["./", "./index.html", "./app.js?v=13", "./config.js?v=13", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./logo.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Ficheiros da aplicação: tenta a rede primeiro (para receber atualizações), usa a cópia se estiver sem internet.
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if(e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

self.addEventListener("push", e => {
  let d = {};
  try{ d = e.data.json(); }catch(_){ d = { title: "Manutenção", body: e.data ? e.data.text() : "" }; }
  try{ if(typeof d.badge === "number" && self.navigator.setAppBadge) self.navigator.setAppBadge(d.badge); }catch(_){}
  e.waitUntil(self.registration.showNotification(d.title || "Manutenção", {
    body: d.body || "",
    tag: d.tag,
    renotify: true,
    icon: "icon-192.png",
    badge: "icon-badge.png",
    data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for(const c of list){ if("focus" in c){ c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
