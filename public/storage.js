// Chat history, contacts and this device's key, stored only in this browser using IndexedDB.
// Nothing goes to the server. Every record has an `owner` (your friend code) so two
// identities tested in the same browser keep separate data.
const DB_NAME = 'cipherlink';
const DB_VERSION = 3;
const MESSAGES = 'messages';
const CONTACTS = 'contacts';
const KEYS = 'keys';

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
      // Version 3: this device's signing key, one per friend code.
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: 'owner' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgraded the database, or the browser closed the connection (phones do
      // this to pages they froze in the background): open a fresh one next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Runs one request. If the connection turned out to be closed, reopen it and try once more.
async function withStore(name, mode, run, retry = true) {
  try {
    const db = await openDB();
    return await promisify(run(db.transaction(name, mode).objectStore(name)));
  } catch (error) {
    if (!retry || error?.name === 'QuotaExceededError') throw error;
    dbPromise = null;
    return withStore(name, mode, run, false);
  }
}

// ---------- Messages ----------
// A message is either text ({ text }) or a photo/video ({ file: { name, mime, size }, blob }).
// IndexedDB stores the Blob itself, so media stays on this device like text does.

export function saveMessage(message) {
  return withStore(MESSAGES, 'readwrite', (store) => store.put(message));
}

export function deleteMessage(id) {
  return withStore(MESSAGES, 'readwrite', (store) => store.delete(id));
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

// Deletes every message with one person in a single transaction.
export async function deleteConversation(owner, peer, retry = true) {
  try {
    const db = await openDB();
    const tx = db.transaction(MESSAGES, 'readwrite');
    const request = tx.objectStore(MESSAGES).index('conversation').openCursor([owner, peer]);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) {
    if (!retry) throw error;
    dbPromise = null;
    return deleteConversation(owner, peer, false);
  }
}

// ---------- Contacts ----------
// { owner, code, name, addedAt, key? }: `key` is their device's public key, remembered
// from the first chat, so later chats can check it's still the same device.

export function saveContact(contact) {
  return withStore(CONTACTS, 'readwrite', (store) => store.put(contact));
}

export function listContacts(owner) {
  return withStore(CONTACTS, 'readonly', (store) => store.index('owner').getAll(owner));
}

export function deleteContact(owner, code) {
  return withStore(CONTACTS, 'readwrite', (store) => store.delete([owner, code]));
}

// ---------- Device key ----------
// { owner, privateKey, jwk }. The private key is a non-extractable CryptoKey: IndexedDB can
// hold it, but no script can read its bytes.

export function getDeviceKey(owner) {
  return withStore(KEYS, 'readonly', (store) => store.get(owner));
}

export function saveDeviceKey(key) {
  return withStore(KEYS, 'readwrite', (store) => store.put(key));
}
