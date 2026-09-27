// Signaling server.
// Its job is to introduce two browsers to each other. It never sees or stores chat
// messages: once peers are connected, messages travel directly between them.
//
// Users are identified by a random friend code generated in their browser. Each code is
// tied to that browser's device key: joining needs a signature from the key first used with
// the code, so nobody else can sign in as you. There is no public list of who's online: a
// client only learns the status of codes it already knows (its contacts), by "watching" them.
//
// What is written to disk (data/store.json), and nothing more: each code's public key,
// chat requests waiting for someone who is offline, the answers to them, and where to send
// push notifications. Never messages, photos or videos.
import express from 'express';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import webpush from 'web-push';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const PUSH_KEYS_FILE = path.join(DATA_DIR, 'push-keys.json');
const CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const NAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const MAX_WATCHED_CODES = 500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 7 * DAY_MS;   // waiting requests and answers expire after a week
const KEY_TTL_MS = 180 * DAY_MS;     // a code unused this long is released
const MAX_WAITING_FOR_PERSON = 20;   // requests waiting for one person
const MAX_WAITING_FROM_PERSON = 10;  // requests one person has waiting for others
const SAVE_DELAY_MS = 1000;
// Push subscriptions must point at a real browser push service, so the server can't be
// tricked into sending requests anywhere else.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

// Message types a client may ask the server to pass on to another user.
const RELAY_TYPES = new Set(['chat-request', 'chat-response', 'signal', 'end']);

// STUN lets a browser discover its public IP address so peers can reach each other.
// TURN is optional: set these env vars to relay traffic for networks that block direct connections.
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL,
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
}

// ---------- Saved state ----------

// Only the server's own user can read its data (the push keys include a private key).
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const store = readJson(STORE_FILE) ?? {};
store.keys ??= {};     // code -> { x, y, lastSeen }: public key of the device that owns the code
store.requests ??= {}; // code -> { fromCode -> { name, time } }: requests waiting for that person
store.answers ??= {};  // code -> { fromCode -> { name, accepted, time } }: replies to their requests
store.push ??= {};     // code -> push subscription of that person's browser
prune();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Written a moment after a change (several changes share one write), via a temporary file
// so a crash mid-write can't leave a half-written store.
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStoreNow, SAVE_DELAY_MS);
}

function saveStoreNow() {
  clearTimeout(saveTimer);
  prune();
  try {
    fs.writeFileSync(`${STORE_FILE}.tmp`, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(`${STORE_FILE}.tmp`, STORE_FILE);
  } catch (error) {
    console.error('Saving store failed:', error);
  }
}

function prune() {
  const now = Date.now();
  for (const [code, entry] of Object.entries(store.keys)) {
    if (now - entry.lastSeen > KEY_TTL_MS) {
      delete store.keys[code];
      delete store.push[code];
    }
  }
  for (const table of [store.requests, store.answers]) {
    for (const [code, inbox] of Object.entries(table)) {
      for (const [from, item] of Object.entries(inbox)) {
        if (now - item.time > REQUEST_TTL_MS) delete inbox[from];
      }
      if (Object.keys(inbox).length === 0) delete table[code];
    }
  }
}

// ---------- Web Push ----------
// Lets the server wake a phone for a chat request even when the browser has frozen the tab.
// The server's push keys (VAPID) are created on first start and kept in data/.

let pushKeys = readJson(PUSH_KEYS_FILE);
if (!pushKeys) {
  pushKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(PUSH_KEYS_FILE, JSON.stringify(pushKeys), { mode: 0o600 });
}
webpush.setVapidDetails(process.env.PUSH_CONTACT || 'https://github.com/CodeXAniket/CipherLink', pushKeys.publicKey, pushKeys.privateKey);

// The payload is encrypted for that browser, so the push service can't read it.
function push(code, payload) {
  const subscription = store.push[code];
  if (!subscription) return;
  webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: DAY_MS / 1000 }).catch((error) => {
    // 404/410: the browser dropped this subscription (notifications turned off, data cleared).
    if (error.statusCode === 404 || error.statusCode === 410) {
      delete store.push[code];
      saveStore();
    }
  });
}

function requestPush(ws) {
  return { title: 'Chat request', body: `${ws.name} wants to chat with you.`, tag: `request-${ws.code}` };
}

// ---------- Connections ----------

const app = express();
app.use(express.static(path.join(import.meta.dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const users = new Map();    // friend code -> WebSocket of that user, while online
const watchers = new Map(); // friend code -> Set of sockets that want to know when it comes online or leaves

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function notifyPresence(code, online) {
  for (const ws of watchers.get(code) ?? []) send(ws, { type: 'presence-update', code, online });
}

function isValidKey(key) {
  return Boolean(key) && key.kty === 'EC' && key.crv === 'P-256'
    && typeof key.x === 'string' && typeof key.y === 'string' && key.x.length === 43 && key.y.length === 43;
}

// The browser signs "cipherlink-join:<nonce>:<code>" with its device key. The nonce is new
// for every connection, so a captured signature can't be replayed.
function verifyJoin(ws, code, key, signature) {
  if (!isValidKey(key) || typeof signature !== 'string') return false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
    return verify('sha256', Buffer.from(`cipherlink-join:${ws.nonce}:${code}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

function handleJoin(ws, { code, name, key, signature }) {
  if (ws.code) return;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code) || typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    send(ws, { type: 'join-error', reason: 'invalid', message: 'Use 3 to 20 characters: lowercase letters, numbers or underscore.' });
    return;
  }
  if (!verifyJoin(ws, code, key, signature)) {
    send(ws, { type: 'join-error', reason: 'invalid', message: 'Reload the page to update CipherLink.' });
    return;
  }
  // The first key used with a code owns it.
  const owner = store.keys[code];
  if (owner && (owner.x !== key.x || owner.y !== key.y)) {
    send(ws, { type: 'join-error', reason: 'code-taken', message: 'This friend code belongs to another device.' });
    return;
  }
  if (users.has(code)) {
    send(ws, { type: 'join-error', reason: 'code-in-use', message: 'This friend code is already online.' });
    return;
  }
  ws.code = code;
  ws.name = name;
  users.set(code, ws);
  store.keys[code] = { x: key.x, y: key.y, lastSeen: Date.now() };
  saveStore();
  send(ws, { type: 'welcome', code, name, iceServers, pushKey: pushKeys.publicKey });
  notifyPresence(code, true);
}

// The client sends the codes of its contacts; it gets their current status now and
// updates whenever one of them joins or leaves.
function handleWatch(ws, codes) {
  if (!Array.isArray(codes)) return;
  unwatchAll(ws);
  ws.watching = new Set(codes.filter((code) => typeof code === 'string' && CODE_PATTERN.test(code)).slice(0, MAX_WATCHED_CODES));
  for (const code of ws.watching) {
    if (!watchers.has(code)) watchers.set(code, new Set());
    watchers.get(code).add(ws);
  }
  send(ws, { type: 'presence', online: [...ws.watching].filter((code) => users.has(code)) });
  deliverWaiting(ws);
}

function unwatchAll(ws) {
  for (const code of ws.watching) {
    const set = watchers.get(code);
    set?.delete(ws);
    if (set?.size === 0) watchers.delete(code);
  }
  ws.watching = new Set();
}

// Requests and answers that arrived while this person was offline. Sent after their first
// "watch", when the app has loaded their contacts. Requests stay until answered.
function deliverWaiting(ws) {
  if (ws.delivered) return;
  ws.delivered = true;
  for (const [from, item] of Object.entries(store.requests[ws.code] ?? {})) {
    send(ws, { type: 'chat-request', from, fromName: item.name, data: { waiting: true, time: item.time } });
  }
  const answers = store.answers[ws.code];
  if (!answers) return;
  for (const [from, item] of Object.entries(answers)) {
    send(ws, { type: 'request-answer', from, fromName: item.name, data: { accepted: item.accepted, time: item.time } });
  }
  delete store.answers[ws.code];
  saveStore();
}

function relay(ws, message) {
  if (typeof message.to !== 'string' || !CODE_PATTERN.test(message.to) || message.to === ws.code) return;
  const target = users.get(message.to);
  // A new request (not an automatic reconnect) to someone offline waits for them.
  const isNewRequest = message.type === 'chat-request' && !message.data?.resume;
  if (!target) {
    if (isNewRequest && store.keys[message.to]) keepRequest(ws, message.to);
    else send(ws, { type: 'peer-offline', code: message.to });
    return;
  }
  // `from` is filled in by the server, so nobody can send messages as another code.
  send(target, { type: message.type, from: ws.code, fromName: ws.name, data: message.data });
  // Their phone may have frozen the tab in the background: a push can still reach it.
  if (isNewRequest) push(message.to, requestPush(ws));
}

function keepRequest(ws, to) {
  const inbox = store.requests[to] ?? {};
  const sentByThem = Object.values(store.requests).filter((box) => box[ws.code]).length;
  if (!inbox[ws.code] && (Object.keys(inbox).length >= MAX_WAITING_FOR_PERSON || sentByThem >= MAX_WAITING_FROM_PERSON)) {
    send(ws, { type: 'request-error', code: to, message: 'Too many requests are waiting. Try again later.' });
    return;
  }
  inbox[ws.code] = { name: ws.name, time: Date.now() };
  store.requests[to] = inbox;
  saveStore();
  send(ws, { type: 'request-waiting', code: to });
  push(to, requestPush(ws));
}

// The answer to a request that waited: passed on now, or kept until the requester is back.
function handleAnswer(ws, { to, data }) {
  if (typeof to !== 'string' || !store.requests[ws.code]?.[to]) return;
  delete store.requests[ws.code][to];
  const accepted = data?.accepted === true;
  const requester = users.get(to);
  if (requester) {
    send(requester, { type: 'request-answer', from: ws.code, fromName: ws.name, data: { accepted, time: Date.now() } });
  } else {
    store.answers[to] = { ...store.answers[to], [ws.code]: { name: ws.name, accepted, time: Date.now() } };
  }
  if (accepted) push(to, { title: ws.name, body: 'Accepted your chat request.', tag: `answer-${ws.code}` });
  saveStore();
}

function handlePushSubscribe(ws, subscription) {
  const { endpoint, keys } = subscription ?? {};
  let host = '';
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return;
  }
  const valid = endpoint.startsWith('https://') && endpoint.length < 1000
    && PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    && typeof keys?.p256dh === 'string' && keys.p256dh.length < 200 && typeof keys?.auth === 'string' && keys.auth.length < 100;
  if (!valid) return;
  store.push[ws.code] = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  saveStore();
}

wss.on('connection', (ws) => {
  ws.code = null;
  ws.watching = new Set();
  ws.isAlive = true;
  ws.nonce = randomBytes(16).toString('base64url');
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { type: 'hello', nonce: ws.nonce });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'join') return handleJoin(ws, message);
    if (!ws.code) return;
    if (message.type === 'watch') return handleWatch(ws, message.codes);
    if (message.type === 'request-answer') return handleAnswer(ws, message);
    if (message.type === 'push-subscribe') return handlePushSubscribe(ws, message.subscription);
    if (message.type === 'push-unsubscribe') {
      if (store.push[ws.code]) {
        delete store.push[ws.code];
        saveStore();
      }
      return;
    }
    if (RELAY_TYPES.has(message.type)) relay(ws, message);
  });

  ws.on('close', () => {
    unwatchAll(ws);
    if (ws.code && users.get(ws.code) === ws) {
      users.delete(ws.code);
      notifyPresence(ws.code, false);
    }
  });
});

// Drop connections that stopped answering (closed laptop, lost Wi-Fi) so presence stays accurate.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on('close', () => clearInterval(heartbeat));

// Save before a restart (deploys, systemd) so nothing waiting is lost.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    saveStoreNow();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`CipherLink running at http://localhost:${PORT}`);
});
