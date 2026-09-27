// Service worker, used only for notifications (see notify.js). It caches nothing and
// doesn't handle network requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A push from the server (a chat request, or an answer to one). Skipped when the app is on
// screen: the page shows the request itself.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    // Not JSON: show the generic text below.
  }
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (tabs.some((tab) => tab.focused && tab.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'CipherLink', {
      body: data.body || 'You have a new chat request.',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: 'icon-192.png',
      badge: 'badge-96.png',
    });
  })());
});

// Clicking a notification brings the open CipherLink tab to the front, or opens the site.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (tabs.length > 0) return tabs[0].focus();
    return self.clients.openWindow('./');
  })());
});
