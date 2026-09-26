// Chat history and contacts, stored only in this browser using IndexedDB. Nothing goes
// to the server. Every record has an `owner` (your friend code) so two identities
// tested in the same browser keep separate data.
const DB_NAME = 'cipherlink';
const DB_VERSION = 2;
const MESSAGES = 'messages';
const CONTACTS = 'contacts';

let dbPromise = null;

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGES)) {
        const messages = db.createObjectStore(MESSAGES, { keyPath: 'id' });
        // Lets us fetch one conversation: every message where (owner, peer) match.
        messages.createIndex('conversation', ['owner', 'peer']);
      }
      // Version 2: people you've added by friend code.
      if (!db.objectStoreNames.contains(CONTACTS)) {
        const contacts = db.createObjectStore(CONTACTS, { keyPath: ['owner', 'code'] });
        contacts.createIndex('owner', 'owner');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgraded the database: let go so it isn't blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(name, mode, run) {
  const db = await openDB();
  return promisify(run(db.transaction(name, mode).objectStore(name)));
}

// ---------- Messages ----------
// A message is either text ({ text }) or a photo/video ({ file: { name, mime, size }, blob }).
// IndexedDB stores the Blob itself, so media stays on this device like text does.

export function saveMessage(message) {
  return withStore(MESSAGES, 'readwrite', (store) => store.put(message));
}

export async function getConversation(owner, peer) {
  const messages = await withStore(MESSAGES, 'readonly', (store) => store.index('conversation').getAll([owner, peer]));
  return messages.sort((a, b) => a.time - b.time);
}

// The latest message with each person, used for the preview line in the contact list.
export async function listConversations(owner) {
  const range = IDBKeyRange.bound([owner, ''], [owner, '￿']);
  const messages = await withStore(MESSAGES, 'readonly', (store) => store.index('conversation').getAll(range));

  const latest = new Map();
  for (const message of messages) {
    const current = latest.get(message.peer);
    if (!current || message.time > current.time) latest.set(message.peer, message);
  }
  return [...latest.values()].map((message) => ({ peer: message.peer, last: message, time: message.time }));
}

export async function deleteConversation(owner, peer) {
  const db = await openDB();
  const tx = db.transaction(MESSAGES, 'readwrite');
  const store = tx.objectStore(MESSAGES);
  const keys = await promisify(store.index('conversation').getAllKeys([owner, peer]));
  for (const key of keys) store.delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Contacts ----------

export function saveContact(contact) {
  return withStore(CONTACTS, 'readwrite', (store) => store.put(contact));
}

export function listContacts(owner) {
  return withStore(CONTACTS, 'readonly', (store) => store.index('owner').getAll(owner));
}

export function deleteContact(owner, code) {
  return withStore(CONTACTS, 'readwrite', (store) => store.delete([owner, code]));
}
