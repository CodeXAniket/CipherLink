// System notifications (Windows, macOS, Android) for chat requests and new messages while
// CipherLink is in the background.
//   - Messages: shown by the page itself, so only while the tab is open and awake. Messages
//     never pass through the server, so it has nothing to push.
//   - Chat requests: also sent by the server as Web Push, which reaches a phone even when
//     it has frozen the tab. The push is encrypted for this browser, so the push service
//     (Google, Mozilla, Apple) can't read it.
const SETTING_KEY = 'cipherlink-notify';

let enabled = readSetting();

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
// uses one (sw.js). It caches nothing.
export function isSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator && window.isSecureContext;
}

export async function init() {
  if (!isSupported()) return;
  try {
    await navigator.serviceWorker.register('sw.js');
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
    // `ready` waits for an active service worker: showing through one that is still
    // installing fails.
    const worker = await navigator.serviceWorker.ready;
    await worker.showNotification(title, { body, tag, renotify: true, icon: 'icon-192.png', badge: 'badge-96.png' });
  } catch (error) {
    console.error('Notification failed:', error);
  }
}

// Removes notifications that are no longer relevant: one tag, or all of them.
export async function clear(tag) {
  if (!isSupported()) return;
  try {
    const worker = await navigator.serviceWorker.ready;
    const shown = await worker.getNotifications(tag ? { tag } : undefined);
    shown.forEach((notification) => notification.close());
  } catch {
    // Nothing to clear.
  }
}

// ---------- Web Push ----------

// Returns this browser's push subscription (for the server's key), creating it if needed.
export async function subscribePush(serverKey) {
  if (!isEnabled() || !serverKey || !('PushManager' in window)) return null;
  try {
    const worker = await navigator.serviceWorker.ready;
    let subscription = await worker.pushManager.getSubscription();
    // A subscription made for a different server key can't receive our pushes: replace it.
    if (subscription && toBase64Url(subscription.options.applicationServerKey) !== serverKey) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(serverKey) });
    return subscription.toJSON();
  } catch (error) {
    console.error('Push unavailable:', error);
    return null;
  }
}

export async function unsubscribePush() {
  if (!isSupported() || !('PushManager' in window)) return;
  try {
    const worker = await navigator.serviceWorker.ready;
    await (await worker.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // Already gone.
  }
}

function toBase64Url(buffer) {
  if (!buffer) return '';
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}
