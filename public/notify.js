// System notifications (Windows, macOS, Android) for chat requests and new messages while
// CipherLink is in the background. The page shows them itself, so they only arrive while the
// tab is open: there is no push server, because that would mean a central service again.
const SETTING_KEY = 'cipherlink-notify';

let enabled = readSetting();
let registration = null;

function readSetting() {
  try {
    return localStorage.getItem(SETTING_KEY) === 'on';
  } catch {
    return false;
  }
}

function saveSetting(value) {
  enabled = value;
  try {
    localStorage.setItem(SETTING_KEY, value ? 'on' : 'off');
  } catch {
    // Storage blocked: the setting lasts for this visit only.
  }
}

// Android Chrome can only show notifications through a service worker, so every browser
// uses one. It caches nothing; it only brings the app to the front when a notification is clicked.
export function isSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator && window.isSecureContext;
}

export async function init() {
  if (!isSupported()) return;
  try {
    registration = await navigator.serviceWorker.register('sw.js');
  } catch (error) {
    console.error('Notifications unavailable:', error);
  }
}

export function isEnabled() {
  return enabled && isSupported() && Notification.permission === 'granted';
}

export function isBlocked() {
  return isSupported() && Notification.permission === 'denied';
}

// Called from a click: browsers only show the permission prompt after a user gesture.
export async function enable() {
  const permission = await Notification.requestPermission();
  saveSetting(permission === 'granted');
  return permission;
}

export function disable() {
  saveSetting(false);
}

// Shown only when the user isn't looking at the app; otherwise the page's own sounds and
// toasts are enough. `tag` replaces an older notification with the same tag.
export async function show(title, { body, tag }) {
  if (!isEnabled() || (document.visibilityState === 'visible' && document.hasFocus())) return;
  try {
    const worker = registration ?? (await navigator.serviceWorker.ready);
    await worker.showNotification(title, { body, tag, renotify: true, icon: 'icon-192.png', badge: 'badge-96.png' });
  } catch (error) {
    console.error('Notification failed:', error);
  }
}

// Removes notifications that are no longer relevant: one tag, or all of them.
export async function clear(tag) {
  if (!registration) return;
  try {
    const shown = await registration.getNotifications(tag ? { tag } : undefined);
    shown.forEach((notification) => notification.close());
  } catch {
    // Nothing to clear.
  }
}
