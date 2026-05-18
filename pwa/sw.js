// Minimaler Service Worker — nur fuer PWA-Installierbarkeit.
// Caching ist hier bewusst nicht aktiviert, da die Analyse immer frisch
// auf dem Server laufen muss (HLZF-Daten koennen sich aendern).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through; kein offline caching in Phase 1.
});
