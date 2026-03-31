// No-op service worker. Exists only to replace any previously installed SW.
// Immediately activates and unregisters itself. Does not cache or intercept anything.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => {
  caches.keys().then((n) => n.forEach((k) => caches.delete(k)));
  self.registration.unregister();
});
