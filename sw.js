// Service Worker for OpenClaw Chat PWA
// ── BUMP THIS ON EVERY DEPLOY to bust PWA cache ──
const CACHE_VERSION = "v16";
const CACHE_NAME = `openclaw-chat-${CACHE_VERSION}`;

const urlsToCache = [
  "/",
  "/index.html",
  "/app.js",
  "/theme.css",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

// Install event - cache essential files
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache).catch((err) => {
        console.error("Cache addAll failed:", err);
      });
    })
  );
  // Activate immediately (don't wait for old tabs to close)
  self.skipWaiting();
});

// Activate event - delete ALL old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control of all clients immediately
  self.clients.claim();
});

// Fetch event - network-first for HTML/JS/CSS, cache-first for assets
self.addEventListener("fetch", (event) => {
  // Skip WebSocket requests
  if (event.request.url.startsWith("ws://") || event.request.url.startsWith("wss://")) {
    return;
  }

  const url = new URL(event.request.url);
  const isAppFile = url.pathname === "/" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css");

  if (isAppFile) {
    // Network-first for app files (ensures fresh code on deploy)
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200 && event.request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first for static assets (icons, images)
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          if (event.request.method === "GET" && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  }
});
