// Signaling server.
// Its only job is to introduce two browsers to each other. It never sees or stores
// chat messages: once peers are connected, messages travel directly between them.
//
// Users are identified by a random friend code generated in their browser. There is
// no public list of who's online: a client only learns the status of codes it already
// knows (its contacts), by "watching" them.
import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const NAME_PATTERN = /^[a-z0-9_]{3,20}$/;
const MAX_WATCHED_CODES = 500;
const HEARTBEAT_INTERVAL_MS = 30_000;

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

const app = express();
app.use(express.static(path.join(import.meta.dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Kept in memory only: nothing is written to disk.
const users = new Map();    // friend code -> WebSocket of that user, while online
const watchers = new Map(); // friend code -> Set of sockets that want to know when it comes online or leaves

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function notifyPresence(code, online) {
  for (const ws of watchers.get(code) ?? []) send(ws, { type: 'presence-update', code, online });
}

function handleJoin(ws, { code, name }) {
  if (ws.code) return;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code) || typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    send(ws, { type: 'join-error', reason: 'invalid', message: 'Use 3 to 20 characters: lowercase letters, numbers or underscore.' });
    return;
  }
  if (users.has(code)) {
    send(ws, { type: 'join-error', reason: 'code-in-use', message: 'This friend code is already online.' });
    return;
  }
  ws.code = code;
  ws.name = name;
  users.set(code, ws);
  send(ws, { type: 'welcome', code, name, iceServers });
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
}

function unwatchAll(ws) {
  for (const code of ws.watching) {
    const set = watchers.get(code);
    set?.delete(ws);
    if (set?.size === 0) watchers.delete(code);
  }
  ws.watching = new Set();
}

function relay(ws, message) {
  const target = users.get(message.to);
  if (!target || target === ws) {
    send(ws, { type: 'peer-offline', code: message.to });
    return;
  }
  // `from` is filled in by the server, so nobody can send messages as another code.
  send(target, { type: message.type, from: ws.code, fromName: ws.name, data: message.data });
}

wss.on('connection', (ws) => {
  ws.code = null;
  ws.watching = new Set();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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

server.listen(PORT, () => {
  console.log(`CipherLink running at http://localhost:${PORT}`);
});
