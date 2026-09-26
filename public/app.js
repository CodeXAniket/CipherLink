// App logic: your identity (friend code + display name), the signaling server connection,
// contacts, the chat-request flow, and the UI. WebRTC lives in peer.js, storage in storage.js.
import { createPeer } from './peer.js';
import * as sounds from './sounds.js';
import * as storage from './storage.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 3_000;
const STATS_INTERVAL_MS = 2_000;
const GROUP_WINDOW_MS = 2 * 60_000;
const MAX_MESSAGE_LENGTH = 2000;
const CHUNK_SIZE = 16 * 1024; // a DataChannel message size every browser handles
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// Only formats that display inside <img> or <video>. No SVG: it can contain scripts.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']);
const NAME_PATTERN = /^[a-z0-9_]{3,20}$/;
// No 0/O or 1/I/L: codes get read aloud and typed by hand.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const IDENTITY_KEY = 'cipherlink-identity';
const NAME_WORDS = [
  ['calm', 'quiet', 'swift', 'bold', 'lucky', 'misty', 'sunny', 'brave', 'fuzzy', 'witty', 'mellow', 'rapid'],
  ['otter', 'heron', 'panda', 'falcon', 'lynx', 'koala', 'badger', 'gecko', 'raven', 'bison', 'mango', 'comet'],
];

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  serverOnline: false,
  me: null,             // { code, name } once the server accepts us
  iceServers: [],
  contacts: new Map(),  // code -> { code, name, addedAt, lastText, time }
  online: new Set(),    // contact codes that are online right now
  names: new Map(),     // code -> display name, for people who aren't contacts yet
  chat: null,           // the one active chat: { peer, status: 'requesting' | 'connecting' | 'connected', connection, ... }
  incoming: null,       // code whose chat request is waiting for my answer
  incomingTimer: null,
  viewing: null,        // code whose conversation is open in the main panel
  transfers: new Map(), // id -> photo/video being sent or received: { id, peer, from, time, file, direction, progress }
};

// Object URLs for displayed photos/videos; released whenever the message list is rebuilt.
const objectUrls = new Set();

// This browser's identity. A second tab gets its own temporary one (see 'code-in-use').
let identity = loadIdentity() ?? { code: generateCode(), name: randomName() };

// ---------- Identity ----------

function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let code = '';
  for (const byte of bytes) {
    // Skip bytes that would make some characters more likely than others (modulo bias).
    if (byte >= CODE_ALPHABET.length * 8) continue;
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    if (code.length === CODE_LENGTH) return code;
  }
  return generateCode();
}

function randomName() {
  const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
  const number = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
  return `${pick(NAME_WORDS[0])}_${pick(NAME_WORDS[1])}_${number}`;
}

function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(input) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && [...code].every((char) => CODE_ALPHABET.includes(char));
}

// sessionStorage first, so a tab using a temporary identity keeps it across reloads.
function loadIdentity() {
  for (const area of ['sessionStorage', 'localStorage']) {
    try {
      const saved = JSON.parse(window[area].getItem(IDENTITY_KEY));
      if (isValidCode(saved?.code) && NAME_PATTERN.test(saved?.name)) return { code: saved.code, name: saved.name };
    } catch {
      // Storage blocked or corrupted: try the next one.
    }
  }
  return null;
}

function saveIdentity({ code, name, tabOnly }) {
  const value = JSON.stringify({ code, name });
  for (const area of tabOnly ? ['sessionStorage'] : ['sessionStorage', 'localStorage']) {
    try {
      window[area].setItem(IDENTITY_KEY, value);
    } catch {
      // Storage blocked (private mode): the identity lasts for this visit only.
    }
  }
}

function nameOf(code) {
  return state.contacts.get(code)?.name ?? state.names.get(code) ?? formatCode(code);
}

// ---------- Signaling server ----------

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}`);
  state.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', code: identity.code, name: identity.name }));
  ws.onmessage = (event) => handleServerMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (state.ws !== ws) return; // we closed it on purpose
    state.ws = null;
    if (!state.me) {
      showLoginError('Could not reach the server.');
      return;
    }
    // The server is gone, but an already-open chat keeps working: it's peer-to-peer.
    if (state.serverOnline) toast('Lost connection to the server. Reconnecting. Open chats keep working.');
    setServerStatus(false);
    if (state.chat && state.chat.status !== 'connected') endChat(null, false);
    if (state.incoming) closeRequestDialog();
    state.online = new Set();
    renderAll();
    setTimeout(() => {
      if (state.me && !state.ws) connect();
    }, RECONNECT_DELAY_MS);
  };
}

function sendToServer(message) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
}

// Ask the server for the online status of my contacts, and only them.
function sendWatch() {
  sendToServer({ type: 'watch', codes: [...state.contacts.keys()] });
}

function handleServerMessage(message) {
  if (message.from && message.fromName) rememberName(message.from, message.fromName);

  switch (message.type) {
    case 'welcome':
      state.me = { code: message.code, name: message.name };
      state.iceServers = message.iceServers;
      saveIdentity(identity);
      setServerStatus(true);
      showApp();
      break;
    case 'join-error': {
      if (state.me) {
        // Reconnecting before the server noticed our old connection dropped: close and retry.
        state.ws.close();
        break;
      }
      const ws = state.ws;
      state.ws = null;
      ws.close();
      if (message.reason === 'code-in-use') {
        // The same browser is already signed in in another tab: this tab gets its own temporary code.
        identity = { code: generateCode(), name: identity.name, tabOnly: true };
        $('login-code').textContent = formatCode(identity.code);
        toast('Your code is open in another tab, so this tab uses a temporary code.');
        connect();
      } else {
        showLoginError(message.message);
      }
      break;
    }
    case 'presence':
      state.online = new Set(message.online);
      renderAll();
      break;
    case 'presence-update':
      if (message.online) {
        state.online.add(message.code);
      } else {
        state.online.delete(message.code);
        onUserGone(message.code);
      }
      renderAll();
      break;
    case 'chat-request':
      onChatRequest(message.from);
      break;
    case 'chat-response':
      onChatResponse(message.from, message.data);
      break;
    case 'signal':
      if (state.chat?.peer === message.from) state.chat.connection?.handleSignal(message.data);
      break;
    case 'end':
      onPeerEnded(message.from);
      break;
    case 'peer-offline':
      onUserGone(message.code);
      break;
  }
}

// Names come from the server alongside every relayed message. Contacts who renamed get updated.
function rememberName(code, name) {
  if (!NAME_PATTERN.test(name)) return;
  state.names.set(code, name);
  const contact = state.contacts.get(code);
  if (contact && contact.name !== name) {
    contact.name = name;
    storage.saveContact({ owner: state.me.code, code, name, addedAt: contact.addedAt });
  }
}

function onUserGone(code) {
  if (state.incoming === code) closeRequestDialog();
  // A connected chat doesn't depend on the server; the P2P connection reports its own drop.
  if (state.chat?.peer === code && state.chat.status !== 'connected') {
    endChat(state.contacts.has(code)
      ? `${nameOf(code)} went offline.`
      : `No one with code ${formatCode(code)} is online right now. You both need to be online.`, false);
  }
}

// ---------- Contacts ----------

async function loadContacts() {
  const owner = state.me.code;
  const [contacts, conversations] = await Promise.all([storage.listContacts(owner), storage.listConversations(owner)]);
  const latest = new Map(conversations.map((conversation) => [conversation.peer, conversation]));
  state.contacts = new Map(contacts.map((contact) => [contact.code, {
    ...contact,
    lastText: previewOf(latest.get(contact.code)?.last),
    time: latest.get(contact.code)?.time ?? contact.addedAt,
  }]));
}

// Called on both sides once a chat request is accepted.
async function addContact(code) {
  const existing = state.contacts.get(code);
  await storage.saveContact({ owner: state.me.code, code, name: nameOf(code), addedAt: existing?.addedAt ?? Date.now() });
  await loadContacts();
  sendWatch();
  renderAll();
}

async function removeContact(code) {
  if (!confirm(`Remove ${nameOf(code)} from your contacts and delete your chat history with them? This can't be undone.`)) return;
  if (state.chat?.peer === code) endChat();
  await Promise.all([storage.deleteConversation(state.me.code, code), storage.deleteContact(state.me.code, code)]);
  state.viewing = null;
  await loadContacts();
  sendWatch();
  renderAll();
}

async function copyCode() {
  const text = formatCode(state.me.code);
  try {
    await navigator.clipboard.writeText(text);
    toast('Code copied. Send it to a friend.');
  } catch {
    // The clipboard API needs HTTPS (or localhost).
    toast(`Copy isn't available here. Your code is ${text}.`);
  }
}

// ---------- Chat request flow ----------
// requester: chat-request ──► receiver: Accept/Decline ──► chat-response ──► WebRTC handshake

function requestChat(code) {
  if (state.chat) return;
  state.chat = {
    peer: code,
    status: 'requesting',
    timer: setTimeout(() => endChat(`${nameOf(code)} didn't respond.`), REQUEST_TIMEOUT_MS),
  };
  sendToServer({ type: 'chat-request', to: code });
  openConversation(code);
}

function onChatRequest(from) {
  if (state.chat || state.incoming) {
    sendToServer({ type: 'chat-response', to: from, data: { accepted: false, reason: 'busy' } });
    return;
  }
  state.incoming = from;
  const known = state.contacts.has(from);
  $('request-from').textContent = nameOf(from);
  $('request-code').textContent = formatCode(from);
  $('request-note').textContent = known
    ? "If you accept, your browsers connect directly and messages won't pass through the server."
    : "Not in your contacts yet. Only accept if you recognise this code. Accepting adds them to your contacts.";
  $('request-dialog').showModal();
  sounds.request();
  // The requester gives up after the same timeout, so don't leave a stale popup open.
  state.incomingTimer = setTimeout(() => {
    if (state.incoming === from) closeRequestDialog();
  }, REQUEST_TIMEOUT_MS);
}

function answerRequest(accepted) {
  const from = state.incoming;
  closeRequestDialog();
  if (!from) return;
  if (accepted) {
    // Get ready for their offer before telling them yes.
    startConnection(from, false);
    openConversation(from);
    addContact(from);
  }
  sendToServer({ type: 'chat-response', to: from, data: { accepted, reason: accepted ? null : 'declined' } });
}

function closeRequestDialog() {
  clearTimeout(state.incomingTimer);
  state.incoming = null;
  $('request-dialog').close();
}

function onChatResponse(from, data) {
  if (state.chat?.peer !== from || state.chat.status !== 'requesting') return;
  if (!data?.accepted) {
    endChat(data?.reason === 'busy' ? `${nameOf(from)} is busy in another chat.` : `${nameOf(from)} declined your request.`, false);
    return;
  }
  addContact(from);
  startConnection(from, true);
}

function onPeerEnded(from) {
  if (state.incoming === from) {
    closeRequestDialog();
    toast(`${nameOf(from)} cancelled the request.`);
  }
  if (state.chat?.peer === from) endChat(`${nameOf(from)} ended the chat.`, false);
}

// ---------- Peer-to-peer connection ----------

function startConnection(peer, initiator) {
  clearTimeout(state.chat?.timer);
  const chat = { peer, status: 'connecting', outgoing: [], sending: false, incomingFile: null };
  state.chat = chat;
  chat.timer = setTimeout(
    () => endChat("Couldn't connect. Your network may be blocking direct peer-to-peer connections."),
    CONNECT_TIMEOUT_MS,
  );

  chat.connection = createPeer({
    initiator,
    iceServers: state.iceServers,
    sendSignal: (data) => sendToServer({ type: 'signal', to: peer, data }),
    onOpen: () => {
      if (state.chat !== chat) return;
      clearTimeout(chat.timer);
      chat.status = 'connected';
      toast(`Connected directly to ${nameOf(peer)}.`);
      pollConnectionInfo(chat);
      chat.statsTimer = setInterval(() => pollConnectionInfo(chat), STATS_INTERVAL_MS);
      renderAll();
      if (state.viewing === peer) {
        loadMessages();
        $('message-input').focus();
      }
    },
    onMessage: (message) => {
      if (state.chat === chat) onPeerMessage(chat, message);
    },
    onBinary: (data) => {
      if (state.chat === chat) onPeerBinary(chat, data);
    },
    onClose: () => {
      if (state.chat === chat) endChat(`Chat with ${nameOf(peer)} ended.`, false);
    },
  });
  renderAll();
}

function endChat(reason = null, notifyPeer = true) {
  const chat = state.chat;
  if (!chat) return;
  state.chat = null;
  clearTimeout(chat.timer);
  clearInterval(chat.statsTimer);
  // Unfinished photo/video transfers can't continue without the connection.
  for (const transfer of [...state.transfers.values()]) {
    if (transfer.peer === chat.peer) failTransfer(transfer);
  }
  if (notifyPeer) sendToServer({ type: 'end', to: chat.peer });
  chat.connection?.close();
  if (reason) toast(reason);
  // A request to a code that never became a contact leaves nothing to show.
  if (state.viewing === chat.peer && !state.contacts.has(chat.peer)) state.viewing = null;
  renderAll();
  if (state.viewing === chat.peer) loadMessages();
}

async function pollConnectionInfo(chat) {
  const info = await chat.connection.getConnectionInfo().catch(() => null);
  if (state.chat !== chat) return;
  chat.info = info;
  renderLinkStrip();
}

// ---------- Messages ----------

async function sendMessage(text) {
  const chat = state.chat;
  if (chat?.status !== 'connected') return;
  if (!chat.connection.send({ type: 'message', text })) {
    toast('Message not sent: the connection was lost.');
    return;
  }
  sounds.sent();
  await addMessage({ peer: chat.peer, from: state.me.code, text });
}

function onPeerMessage(chat, message) {
  if (message.type === 'message' && typeof message.text === 'string') {
    addMessage({ peer: chat.peer, from: chat.peer, text: message.text.slice(0, MAX_MESSAGE_LENGTH) });
  } else if (message.type === 'file-start') {
    startIncomingFile(chat, message);
  } else if (message.type === 'file-end') {
    finishIncomingFile(chat, message.id);
  }
}

function addMessage({ peer, from, text }) {
  return saveRecord({ id: newId(), owner: state.me.code, peer, from, text, time: Date.now() });
}

// Saves a finished message (text, photo or video) and shows it.
async function saveRecord(record) {
  try {
    await storage.saveMessage(record);
  } catch (error) {
    // Storage full or blocked: still show it for this session instead of losing it.
    console.error('Saving message failed:', error);
    toast(`Couldn't save this ${record.file ? mediaKind(record.file.mime).toLowerCase() : 'message'} on this device. It will disappear if you reload.`);
  }
  if (record.from === state.me.code) {
    if (record.file) sounds.sent(); // text plays its sound the moment it's sent
  } else {
    sounds.received();
  }
  const pending = transferBubble(record.id);
  if (pending) fillBubble(pending, record); // the progress bubble becomes the photo/video
  else if (state.viewing === record.peer) appendMessage(record, true);
  else if (record.from !== state.me.code) toast(`New ${record.file ? mediaKind(record.file.mime).toLowerCase() : 'message'} from ${nameOf(record.peer)}`);
  const contact = state.contacts.get(record.peer);
  if (contact) Object.assign(contact, { lastText: previewOf(record), time: record.time });
  renderContacts();
}

// ---------- Photos and videos ----------
// A file travels as: JSON "file-start" (name, type, size) -> 16 KB binary chunks -> JSON
// "file-end". The channel is ordered, so chunks arrive in sequence. Files are sent one at a
// time so chunks from two files never mix.

function sendFiles(files) {
  const chat = state.chat;
  if (chat?.status !== 'connected') return;
  for (const file of files) {
    if (!IMAGE_TYPES.has(file.type) && !VIDEO_TYPES.has(file.type)) toast(`${file.name} isn't a supported photo or video.`);
    else if (file.size > MAX_FILE_BYTES) toast(`${file.name} is over 100 MB.`);
    else if (file.size > 0) chat.outgoing.push(file);
  }
  if (!chat.sending) drainOutgoing(chat);
}

async function drainOutgoing(chat) {
  chat.sending = true;
  while (chat.outgoing.length > 0 && state.chat === chat) {
    const file = chat.outgoing.shift();
    try {
      await sendFile(chat, file);
    } catch (error) {
      console.error('Sending file failed:', error);
      toast(state.chat === chat
        ? `${file.name} couldn't be sent (${error.name}). Try again.`
        : `${file.name} wasn't sent: the connection dropped.`);
    }
  }
  chat.sending = false;
}

async function sendFile(chat, file) {
  const transfer = beginTransfer({
    peer: chat.peer,
    from: state.me.code,
    file: { name: file.name, mime: file.type, size: file.size },
    direction: 'Sending',
  });
  let data;
  try {
    // Read the whole file once, before sending. Phones can fail to read a large gallery
    // file slice by slice during a long transfer, and this in-memory copy is also what we
    // keep afterwards (storing the picked File itself fails on some phones).
    data = await file.arrayBuffer();
    if (!chat.connection.send({ type: 'file-start', id: transfer.id, ...transfer.file })) throw new Error('Channel closed');
    for (let offset = 0; offset < data.byteLength; offset += CHUNK_SIZE) {
      // Backpressure in sendBinary keeps the send queue small.
      await chat.connection.sendBinary(data.slice(offset, offset + CHUNK_SIZE));
      updateTransfer(transfer, Math.min(offset + CHUNK_SIZE, data.byteLength) / data.byteLength);
    }
    if (!chat.connection.send({ type: 'file-end', id: transfer.id })) throw new Error('Channel closed');
  } catch (error) {
    failTransfer(transfer);
    throw error;
  }
  await completeTransfer(transfer, new Blob([data], { type: file.type }));
}

function startIncomingFile(chat, { id, name, mime, size }) {
  if (chat.incomingFile) failTransfer(chat.incomingFile.transfer); // the previous one never finished
  chat.incomingFile = null;
  const valid = typeof id === 'string' && typeof name === 'string'
    && (IMAGE_TYPES.has(mime) || VIDEO_TYPES.has(mime))
    && Number.isInteger(size) && size > 0 && size <= MAX_FILE_BYTES;
  if (!valid) return; // its chunks will be ignored
  const transfer = beginTransfer({ peer: chat.peer, from: chat.peer, file: { name: cleanFileName(name), mime, size }, direction: 'Receiving' });
  // Our own id for storage; the sender's id only matches its "file-end".
  chat.incomingFile = { remoteId: id, transfer, chunks: [], received: 0 };
}

function onPeerBinary(chat, data) {
  const incoming = chat.incomingFile;
  if (!incoming) return;
  incoming.chunks.push(data);
  incoming.received += data.byteLength;
  if (incoming.received > incoming.transfer.file.size) {
    discardIncoming(chat);
    return;
  }
  updateTransfer(incoming.transfer, incoming.received / incoming.transfer.file.size);
}

function finishIncomingFile(chat, id) {
  const incoming = chat.incomingFile;
  if (!incoming || incoming.remoteId !== id) return;
  if (incoming.received !== incoming.transfer.file.size) {
    discardIncoming(chat);
    return;
  }
  chat.incomingFile = null;
  completeTransfer(incoming.transfer, new Blob(incoming.chunks, { type: incoming.transfer.file.mime }));
}

function discardIncoming(chat) {
  failTransfer(chat.incomingFile.transfer);
  chat.incomingFile = null;
  toast('A file arrived incomplete and was discarded.');
}

function beginTransfer({ peer, from, file, direction }) {
  const transfer = { id: newId(), peer, from, file, direction, time: Date.now(), progress: 0 };
  state.transfers.set(transfer.id, transfer);
  if (state.viewing === peer) appendMessage(transfer, true);
  return transfer;
}

function updateTransfer(transfer, fraction) {
  const changed = Math.floor(fraction * 100) !== Math.floor(transfer.progress * 100);
  transfer.progress = fraction;
  if (!changed) return; // repaint at most once per percent
  const bubble = transferBubble(transfer.id);
  if (!bubble) return;
  bubble.querySelector('.progress-fill').style.transform = `scaleX(${fraction})`;
  bubble.querySelector('.progress-label').textContent = transferLabel(transfer);
}

function completeTransfer(transfer, blob) {
  state.transfers.delete(transfer.id);
  return saveRecord({
    id: transfer.id,
    owner: state.me.code,
    peer: transfer.peer,
    from: transfer.from,
    time: transfer.time,
    file: transfer.file,
    blob,
  });
}

function failTransfer(transfer) {
  state.transfers.delete(transfer.id);
  transferBubble(transfer.id)?.remove();
}

function transferBubble(id) {
  return $('messages').querySelector(`[data-transfer="${CSS.escape(id)}"]`);
}

function transferLabel(transfer) {
  return `${transfer.direction} ${Math.floor(transfer.progress * 100)}% of ${formatBytes(transfer.file.size)}`;
}

function cleanFileName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

function openLightbox(url, name) {
  $('media-full').src = url;
  $('media-full').alt = name;
  $('media-dialog').showModal();
}

async function exportChat(code) {
  const messages = await storage.getConversation(state.me.code, code);
  const data = {
    app: 'CipherLink',
    me: { name: state.me.name, code: formatCode(state.me.code) },
    peer: { name: nameOf(code), code: formatCode(code) },
    exportedAt: new Date().toISOString(),
    note: 'Photos and videos are listed by name only; the files themselves are not included.',
    messages: messages.map(({ from, text, file, time }) => ({
      from: from === state.me.code ? state.me.name : nameOf(code),
      ...(file ? { file: `${mediaKind(file.mime)}: ${file.name} (${formatBytes(file.size)})` } : { text }),
      time: new Date(time).toISOString(),
    })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `cipherlink-${nameOf(code)}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function showSafetyNumber() {
  const chat = state.chat;
  if (chat?.status !== 'connected') return;
  const number = await chat.connection.getSafetyNumber();
  $('safety-peer').textContent = nameOf(chat.peer);
  $('safety-number').textContent = number ?? 'Unavailable: safety numbers need HTTPS or localhost.';
  $('safety-dialog').showModal();
}

// ---------- Rendering ----------

function renderAll() {
  renderContacts();
  renderHeader();
}

function renderContacts() {
  const list = $('contact-list');
  const contacts = [...state.contacts.values()].sort((a, b) => b.time - a.time);
  $('contact-count').textContent = contacts.length;
  list.replaceChildren();
  if (contacts.length === 0) {
    list.append(el('li', 'list-empty', 'No contacts yet. Share your code with a friend, or enter theirs above.'));
    return;
  }
  for (const contact of contacts) {
    const online = state.online.has(contact.code);
    const item = contactItem(contact.code, online, contactSubtitle(contact, online));
    if (online && state.chat?.peer !== contact.code) {
      const chat = button('Chat', () => requestChat(contact.code), 'btn-chip');
      chat.disabled = Boolean(state.chat);
      item.append(chat);
    }
    list.append(item);
  }
}

function contactSubtitle(contact, online) {
  if (state.chat?.peer === contact.code) {
    return { requesting: 'Waiting for reply', connecting: 'Connecting', connected: 'In chat' }[state.chat.status];
  }
  return contact.lastText ?? (online ? 'Online' : 'Offline');
}

function renderHeader() {
  const peer = state.viewing;
  $('empty-state').classList.toggle('hidden', Boolean(peer));
  $('conversation').classList.toggle('hidden', !peer);
  document.body.classList.toggle('show-chat', Boolean(peer));
  if (!peer) return;

  const status = state.chat?.peer === peer ? state.chat.status : null;
  const online = state.online.has(peer);
  const isContact = state.contacts.has(peer);

  $('chat-avatar').textContent = initial(nameOf(peer));
  $('chat-name').textContent = nameOf(peer);
  $('chat-code').textContent = formatCode(peer);
  $('conversation').dataset.status = status ?? '';
  $('chat-status').textContent = {
    connected: 'Connected directly',
    requesting: 'Waiting for them to accept',
    connecting: 'Connecting',
  }[status] ?? (online ? 'Online' : 'Offline. Saved history');

  // Secondary tools sit together in one segmented pill; the main action (end, cancel or
  // request) stands on its own next to it.
  const actions = $('chat-actions');
  actions.replaceChildren();
  const tools = [];
  if (status === 'connected') tools.push(button('Safety number', showSafetyNumber, 'seg'));
  if (isContact) {
    tools.push(button('Export', () => exportChat(peer), 'seg'), button('Remove', () => removeContact(peer), 'seg seg-danger'));
  }
  if (tools.length > 0) {
    const group = el('div', 'action-group');
    group.append(...tools);
    actions.append(group);
  }
  if (status === 'connected') {
    actions.append(button('End chat', () => endChat(), 'btn-small btn-outline'));
  } else if (status) {
    actions.append(button('Cancel', () => endChat(), 'btn-small btn-outline'));
  } else if (online) {
    const request = button('Request chat', () => requestChat(peer), 'btn-small btn-primary');
    request.disabled = Boolean(state.chat);
    actions.append(request);
  }

  const canType = status === 'connected';
  $('message-input').disabled = !canType;
  $('send-btn').disabled = !canType;
  $('attach-btn').disabled = !canType;
  $('message-input').placeholder = canType ? 'Type a message' : 'Connect to send messages';
  $('composer-note').textContent = canType ? `Goes straight to ${nameOf(peer)}. Not stored on any server.` : 'Not connected';
  renderLinkStrip();
}

// The black strip under the chat header: live facts about the direct connection.
function renderLinkStrip() {
  const chat = state.chat;
  const visible = chat?.status === 'connected' && state.viewing === chat.peer;
  const strip = $('link-strip');
  strip.classList.toggle('hidden', !visible);
  if (!visible) return;
  const info = chat.info;
  const cells = [
    ['Route', describeRoute(info)],
    ['Latency', info?.rttMs != null ? `${info.rttMs} ms` : 'Measuring'],
    ['Encryption', describeEncryption(info)],
    ['Server copy', 'None'],
  ];
  strip.replaceChildren(...cells.map(([label, value]) => {
    const cell = el('div', 'link-cell');
    cell.title = `${label}: ${value}`; // full text if a phone screen cuts it short
    cell.append(el('span', 'link-label', label), el('span', 'link-value', value));
    return cell;
  }));
}

// ICE candidate types: host = local address, srflx/prflx = public address found via NAT, relay = TURN server.
function describeRoute(info) {
  if (!info) return 'Checking';
  if (info.localType === 'relay' || info.remoteType === 'relay') return 'Relayed (TURN)';
  if (info.localType === 'host' && info.remoteType === 'host') return 'Direct, same network';
  return 'Direct, across NAT';
}

function describeEncryption(info) {
  const version = { FEFD: 'DTLS 1.2', FEFC: 'DTLS 1.3' }[info?.dtlsVersion] ?? 'DTLS';
  const cipher = info?.cipher?.match(/AES_(128|256)_GCM|CHACHA20/)?.[0];
  if (!cipher) return version;
  return `${version}, ${cipher === 'CHACHA20' ? 'ChaCha20' : `AES-${cipher.split('_')[1]}-GCM`}`;
}

function openConversation(code) {
  state.viewing = code;
  renderAll();
  loadMessages();
}

async function loadMessages() {
  const peer = state.viewing;
  if (!peer) return;
  const messages = await storage.getConversation(state.me.code, peer);
  if (state.viewing !== peer) return;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  const list = $('messages');
  list.replaceChildren();
  list.dataset.day = '';
  const inFlight = [...state.transfers.values()].filter((transfer) => transfer.peer === peer);
  if (messages.length === 0 && inFlight.length === 0) renderChatEmpty(peer);
  messages.forEach((record) => appendMessage(record));
  inFlight.forEach((transfer) => appendMessage(transfer));
}

function renderChatEmpty(peer) {
  const connected = state.chat?.peer === peer && state.chat.status === 'connected';
  const item = el('li', 'chat-empty');
  item.append(
    el('strong', null, connected ? 'Say hello' : 'No saved messages'),
    el('span', null, connected
      ? `Messages go straight to ${nameOf(peer)}. Nothing is stored on the server.`
      : `Chats with ${nameOf(peer)} are saved here, on this device only.`),
  );
  $('messages').append(item);
}

// `record` is a saved message (text or media) or an in-progress transfer.
// `animate` is true only for messages arriving live, not for history loaded from storage.
function appendMessage(record, animate = false) {
  const list = $('messages');
  list.querySelector('.chat-empty')?.remove();

  const day = dayLabel(record.time);
  if (list.dataset.day !== day) {
    list.append(el('li', 'day-divider', day));
    list.dataset.day = day;
  }

  const item = el('li', record.from === state.me.code ? 'bubble mine' : 'bubble theirs');
  item.dataset.from = record.from;
  item.dataset.time = record.time;
  // Messages from the same person within a couple of minutes are grouped visually.
  const previous = list.lastElementChild?.classList.contains('bubble') ? list.lastElementChild : null;
  if (previous?.dataset.from === record.from && record.time - Number(previous.dataset.time) < GROUP_WINDOW_MS) {
    previous.classList.add('has-next');
    item.classList.add('continued');
  }
  if (animate) item.classList.add('is-new');
  fillBubble(item, record);
  list.append(item);
  list.scrollTop = list.scrollHeight;
}

function fillBubble(item, record) {
  delete item.dataset.transfer;
  item.classList.remove('file-bubble', 'media-bubble');
  const time = el('time', null, formatTime(record.time));

  if (record.direction) {
    // Still sending or receiving: a card with a progress bar.
    item.dataset.transfer = record.id;
    item.classList.add('file-bubble');
    const bar = el('span', 'progress');
    const fill = el('span', 'progress-fill');
    fill.style.transform = `scaleX(${record.progress})`;
    bar.append(fill);
    item.replaceChildren(
      el('span', 'file-kind', mediaKind(record.file.mime)),
      el('strong', 'file-name', record.file.name),
      bar,
      el('span', 'progress-label', transferLabel(record)),
    );
    return;
  }

  if (record.file && !record.blob) {
    item.replaceChildren(el('p', null, `${mediaKind(record.file.mime)} unavailable: ${record.file.name}`), time);
    return;
  }

  if (record.file) {
    item.classList.add('media-bubble');
    const url = URL.createObjectURL(record.blob);
    objectUrls.add(url);
    const save = el('a', 'media-save', 'Save');
    Object.assign(save, { href: url, download: record.file.name });
    const meta = el('div', 'media-meta');
    meta.append(save, el('span', null, formatBytes(record.file.size)), time);
    item.replaceChildren(mediaElement(record, url), meta);
    return;
  }

  item.replaceChildren(el('p', null, record.text), time);
}

// Media is only ever shown through <img> and <video>, never opened as a page, so a
// disguised file can't run scripts.
function mediaElement(record, url) {
  const keepScrolledDown = (media) => {
    media.addEventListener(media.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', () => {
      const list = $('messages');
      if (list.lastElementChild?.contains(media)) list.scrollTop = list.scrollHeight;
    }, { once: true });
  };
  if (VIDEO_TYPES.has(record.file.mime)) {
    const video = el('video', 'media');
    Object.assign(video, { src: url, controls: true, preload: 'metadata', playsInline: true });
    keepScrolledDown(video);
    return video;
  }
  const image = el('img', 'media');
  Object.assign(image, { src: url, alt: record.file.name, loading: 'lazy' });
  image.onclick = () => openLightbox(url, record.file.name);
  keepScrolledDown(image);
  return image;
}

function mediaKind(mime) {
  return mime.startsWith('video/') ? 'Video' : 'Photo';
}

function previewOf(record) {
  if (!record) return null;
  return record.file ? mediaKind(record.file.mime) : record.text;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function contactItem(code, online, subtitle) {
  const item = el('li', 'contact');
  item.classList.toggle('active', state.viewing === code);
  const avatar = el('span', 'avatar', initial(nameOf(code)));
  if (online) avatar.append(el('span', 'online-dot'));
  const text = el('span', 'contact-text');
  text.append(el('strong', null, nameOf(code)), el('span', 'contact-sub', subtitle ?? ''));
  item.append(avatar, text);
  item.onclick = () => openConversation(code);
  return item;
}

async function showApp() {
  $('me-name').textContent = state.me.name;
  $('my-code').textContent = formatCode(state.me.code);
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('session').classList.remove('hidden');
  await loadContacts();
  sendWatch();
  renderAll();
}

function showLogin() {
  $('app-view').classList.add('hidden');
  $('session').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  document.body.classList.remove('show-chat');
}

function showLoginError(text) {
  $('login-error').textContent = text;
}

function setServerStatus(online) {
  state.serverOnline = online;
  $('server-status').classList.toggle('offline', !online);
  $('server-status').title = online ? 'Connected to signaling server' : 'Reconnecting to signaling server';
}

function leave() {
  if (state.incoming) answerRequest(false);
  endChat();
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  Object.assign(state, { me: null, contacts: new Map(), online: new Set(), names: new Map(), viewing: null, serverOnline: false });
  showLogin();
}

function toast(text) {
  const item = el('div', 'toast', text);
  $('toasts').append(item);
  setTimeout(() => item.remove(), 4000);
}

// ---------- Small helpers ----------

// Builds elements with textContent (never innerHTML), so messages can't inject HTML/scripts.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, onClick, variant = '') {
  const node = el('button', `btn ${variant}`.trim(), label);
  node.type = 'button';
  node.onclick = (event) => {
    event.stopPropagation();
    onClick();
  };
  return node;
}

function initial(name) {
  return name.charAt(0).toUpperCase();
}

// The date lives in the day dividers, so bubbles only show the clock time.
function formatTime(time) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(time) {
  const date = new Date(time).toDateString();
  if (date === new Date().toDateString()) return 'Today';
  if (date === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday';
  return new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function updateCharCount() {
  const length = $('message-input').value.length;
  $('char-count').textContent = `${length} / ${MAX_MESSAGE_LENGTH}`;
  $('char-count').classList.toggle('near-limit', length > MAX_MESSAGE_LENGTH * 0.9);
}

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------- Wire up the page ----------

// Intro shutter: remove it once it has rolled up (or on click). Skipped for reduced motion.
function finishIntro() {
  $('intro')?.remove();
  document.documentElement.classList.add('intro-done');
}
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  finishIntro();
} else {
  $('intro').addEventListener('animationend', (event) => {
    if (event.animationName === 'shutter-up') finishIntro();
  });
  $('intro').addEventListener('click', finishIntro);
}

$('username').value = identity.name;
$('login-code').textContent = formatCode(identity.code);

$('shuffle-btn').onclick = () => {
  $('username').value = randomName();
  showLoginError('');
};

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.ws) return;
  const name = $('username').value.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    showLoginError('Use 3 to 20 characters: letters, numbers or underscore.');
    return;
  }
  showLoginError('');
  identity = { ...identity, name };
  sounds.unlock(); // this click is the user gesture browsers require before playing audio
  connect();
});

// Icon toggle buttons: aria-pressed picks which icon shows (see .icon-on / .icon-off in CSS).
function setToggle(button, on, label) {
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', label);
  button.title = label;
}

function renderSoundButton() {
  const on = sounds.isEnabled();
  setToggle($('sound-btn'), on, on ? 'Sound on' : 'Sound off');
}
renderSoundButton();
$('sound-btn').onclick = () => {
  sounds.setEnabled(!sounds.isEnabled());
  sounds.unlock();
  sounds.sent(); // a quick preview when turning it on (silent when turning it off)
  renderSoundButton();
};

// Full screen hides the browser's address bar and tabs. Not every browser allows it
// (iPhone Safari doesn't), so the button only shows where it works.
function renderFullscreenButton() {
  const on = Boolean(document.fullscreenElement);
  setToggle($('fullscreen-btn'), on, on ? 'Exit full screen' : 'Full screen');
}
$('fullscreen-btn').hidden = !document.fullscreenEnabled;
renderFullscreenButton();
$('fullscreen-btn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast("Full screen isn't available here."));
};
document.addEventListener('fullscreenchange', renderFullscreenButton);

// Format as XXXX-XXXX while typing.
$('add-code').addEventListener('input', (event) => {
  const code = normalizeCode(event.target.value).slice(0, CODE_LENGTH);
  event.target.value = code.length > 4 ? formatCode(code) : code;
  $('add-error').textContent = '';
});

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = normalizeCode($('add-code').value);
  const error = !isValidCode(code) ? 'Codes are 8 characters, like 7KQM-4XPD.'
    : code === state.me.code ? "That's your own code."
    : state.chat ? 'Finish your current chat first.'
    : '';
  $('add-error').textContent = error;
  if (error) return;
  $('add-code').value = '';
  requestChat(code);
});

$('copy-code-btn').onclick = copyCode;

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('message-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  updateCharCount();
  sendMessage(text);
});
$('message-input').addEventListener('input', updateCharCount);

$('attach-btn').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', (event) => {
  sendFiles([...event.target.files]);
  event.target.value = ''; // so picking the same file again still triggers "change"
});

// Drag and drop photos/videos onto the chat. Dropping anywhere else must not open the file.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
$('messages').addEventListener('dragover', () => {
  if (state.chat?.status === 'connected' && state.viewing === state.chat.peer) $('messages').classList.add('drop-target');
});
$('messages').addEventListener('dragleave', () => $('messages').classList.remove('drop-target'));
$('messages').addEventListener('drop', (event) => {
  $('messages').classList.remove('drop-target');
  if (state.chat?.status === 'connected' && state.viewing === state.chat.peer) sendFiles([...event.dataTransfer.files]);
});

// Full-size photo view: close on the button or a click outside the image.
$('media-dialog').addEventListener('click', (event) => {
  if (event.target.id === 'media-dialog' || event.target.id === 'media-close') $('media-dialog').close();
});

$('accept-btn').onclick = () => answerRequest(true);
$('decline-btn').onclick = () => answerRequest(false);
$('request-dialog').addEventListener('cancel', (event) => {
  event.preventDefault(); // Esc counts as Decline
  answerRequest(false);
});
$('safety-close').onclick = () => $('safety-dialog').close();
$('leave-btn').onclick = leave;
$('back-btn').onclick = () => {
  state.viewing = null;
  renderAll();
};
window.addEventListener('pagehide', () => endChat());
