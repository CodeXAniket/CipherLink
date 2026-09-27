// Service worker, used only for notifications (see notify.js). It caches nothing and
// doesn't handle network requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Clicking a notification brings the open CipherLink tab to the front, or opens the site.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (tabs.length > 0) return tabs[0].focus();
    return self.clients.openWindow('./');
  })());
});
