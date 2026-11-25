// Secret links. Each home, organizer and visitor gets a long random token that
// lives only in the link they were given (after the #, so it never reaches
// server logs). Only a SHA-256 hash of each token is stored.
import crypto from 'node:crypto';

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

// Compares two hex hashes without leaking timing.
export function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
