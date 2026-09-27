// This device's signing key (ECDSA P-256), created once per friend code and kept in
// IndexedDB. The private key is non-extractable: the page can sign with it, but no script
// can read or copy it. Signatures prove two things:
//   - to the server, that a friend code belongs to this browser (see server.js, join)
//   - to a contact, that they're talking to the same device as before (see app.js, auth)
import * as storage from './storage.js';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' };

const cache = new Map(); // friend code -> Promise of its key, so one key is made per code

export function deviceKey(code) {
  if (!cache.has(code)) cache.set(code, loadOrCreate(code));
  return cache.get(code);
}

async function loadOrCreate(code) {
  const saved = await storage.getDeviceKey(code).catch(() => null);
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey(ALGORITHM, false, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const key = { owner: code, privateKey: pair.privateKey, jwk: { kty, crv, x, y } };
  // If storage is blocked the key lasts for this visit only.
  await storage.saveDeviceKey(key).catch((error) => console.error('Saving device key failed:', error));
  return key;
}

export async function sign(privateKey, text) {
  const signature = await crypto.subtle.sign(SIGNING, privateKey, new TextEncoder().encode(text));
  return toBase64Url(new Uint8Array(signature));
}

export async function verify(jwk, text, signature) {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ALGORITHM, false, ['verify']);
    return await crypto.subtle.verify(SIGNING, key, fromBase64Url(signature), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

// A public key from another browser is untrusted input: check its shape before using it.
export function isValidKey(jwk) {
  return Boolean(jwk) && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && jwk.x.length === 43 && jwk.y.length === 43;
}

export function sameKey(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y;
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}
