// ReturnShield AI — PWA service worker.
//
// Everything the app needs lives in the single built index.html (app.js is
// inlined into it by dashboard/build.py), so the "app shell" here is just
// that file plus the manifest/icons. Network-first: a running dev server's
// freshly-rebuilt index.html always wins over the cache, and the cache is
// only a fallback for opening the installed app offline. Never touches
// /api/* or any cross-origin request (the FastAPI backend on :8000) — those
// must hit the real server or fail visibly, never serve stale cached fraud
// data while pretending it's live.
const CACHE_NAME = "returnshield-shell-v1";
const APP_SHELL = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never intercept the backend API
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
