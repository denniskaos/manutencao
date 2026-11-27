// Service worker: permite instalar a aplicação e receber notificações.
const CACHE = "manutencao-v154";
const SHELL = ["./", "./index.html", "./app.js?v=154", "./config.js?v=154", "./manifest.webmanifest", "./icone2-192.png", "./icone2-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(x => new Request(x, { cache: "reload" })))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Ficheiros da aplicação: abre logo com a cópia guardada no telemóvel (rápido mesmo com rede fraca)
// e vai buscar a versão nova por trás — fica pronta para a próxima vez que a app abrir.
// A biblioteca de ligação ao servidor (cdn.jsdelivr.net) também fica guardada.
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if(e.request.method !== "GET") return;
  const cdn = u.hostname === "cdn.jsdelivr.net";
  if(u.origin !== location.origin && !cdn) return;
  const nav = e.request.mode === "navigate";
  const chave = nav ? new URL("./", self.registration.scope).href : e.request;
  const rede = fetch(e.request, cdn ? {} : { cache: "no-cache" }).then(r => {
    if(r && (r.ok || r.type === "opaque")){ const copy = r.clone(); caches.open(CACHE).then(c => c.put(chave, copy)); }
    return r;
  });
  e.respondWith(caches.match(chave).then(guardada => {
    if(guardada){ e.waitUntil(rede.catch(() => {})); return guardada; }
    return rede.catch(() => caches.match(nav ? "./index.html" : chave).then(r => r || caches.match("./index.html")));
  }));
});

self.addEventListener("push", e => {
  let d = {};
  try{ d = e.data.json(); }catch(_){ d = { title: "Manutenção", body: e.data ? e.data.text() : "" }; }
  try{ if(typeof d.badge === "number" && self.navigator.setAppBadge) self.navigator.setAppBadge(d.badge); }catch(_){}
  e.waitUntil(self.registration.showNotification(d.title || "Manutenção", {
    body: d.body || "",
    tag: d.tag,
    renotify: true,
    icon: "icone2-192.png",
    badge: "icone2-badge.png",
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
