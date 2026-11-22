/* Offline helper for SEREN Counter: keeps the counter's own files on this PC so it opens without internet.
   Bills and prices are never cached here (the app keeps those itself); the order system is always asked first. */
const CACHE = "seren-pos-v2";
// pages use their short addresses ("./", "display"): the server redirects "x.html" to "x", and a redirect can't be replayed offline
const SHELL = ["./", "display", "pos.css", "receipt.js", "core.js", "print.js", "ui.js", "pay.js", "app.js", "display.js",
  "vendor/qrcode.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Counter files: use the newest from the internet, fall back to the saved copy when offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith("/pos/")) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("./") : undefined))),
  );
});
