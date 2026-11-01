/* Keeps the app on the iPad so it opens without internet. Change VERSION whenever any file
   changes, so the iPad picks up the new files the next time it is online. */
const VERSION = "zion-reports-1.0";
const FILES = ["./", "index.html", "app.js", "reports.js", "pdf.js", "logo.png", "manifest.webmanifest",
  "vendor/jspdf.umd.min.js", "vendor/jspdf.plugin.autotable.min.js",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
