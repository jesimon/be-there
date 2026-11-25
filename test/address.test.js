// The new address (lib/address.js): only the one written into the code is
// ever accepted, whatever the service's settings say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_ALLOW, canonicalOriginFrom } from '../lib/address.js';

const NEW = 'https://bethere.gladspring.org';

test('the list of addresses devices may be sent to is exactly the one we own', () => {
  // Changing this list changes where every secret link can be sent: this test
  // is here so that it can only be done on purpose.
  assert.deepEqual([...CANONICAL_ALLOW], [NEW]);
  assert.throws(() => { CANONICAL_ALLOW.push('https://evil.example'); }, TypeError, 'the list cannot be added to while the server runs');
});

test('nothing set means no new address, and nothing to warn about', () => {
  for (const unset of [undefined, null, '', '   ', '\n']) {
    assert.deepEqual(canonicalOriginFrom(unset), { origin: null, ignored: false }, JSON.stringify(unset));
  }
});

test('the address on the list is accepted, with stray spaces around it forgiven', () => {
  assert.deepEqual(canonicalOriginFrom(NEW), { origin: NEW, ignored: false });
  assert.deepEqual(canonicalOriginFrom(`  ${NEW}\n`), { origin: NEW, ignored: false });
});

test('anything else is ignored, look-alikes included', () => {
  const others = [
    'https://bethere.gladspring.org.evil.example',
    'https://bethere.gladspring.org.',
    'http://bethere.gladspring.org',
    'https://bethere.gladspring.org/',
    'https://bethere.gladspring.org/visit',
    'https://bethere.gladspring.org?x=1',
    'https://bethere.gladspring.org#x',
    'https://bethere.gladspring.org:443',
    'https://bethere.gladspring.org:8443',
    'https://BETHERE.gladspring.org',
    'HTTPS://bethere.gladspring.org',
    'https://bethere.gladspring.org@evil.example',
    'https://evil.example@bethere.gladspring.org',
    'https://evil.example/https://bethere.gladspring.org',
    'https://evil.example#https://bethere.gladspring.org',
    'https://bethere-gladspring.org',
    'https://xbethere.gladspring.org',
    'https://gladspring.org',
    'https://www.bethere.gladspring.org',
    'https://bethere.gladspring.org https://evil.example',
    'https://bethere.gladspring.org,https://evil.example',
    'https://bethere.gladspring.org\u0000',
    'https://bethere.gladspring.οrg',            // a Greek letter in place of the "o"
    '//bethere.gladspring.org',
    'bethere.gladspring.org',
    'wss://bethere.gladspring.org',
    'javascript:alert(1)',
    'https://be-there-gp50.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'true',
    '*',
  ];
  for (const value of others) {
    assert.deepEqual(canonicalOriginFrom(value), { origin: null, ignored: true }, value);
  }
  // Things that are not text at all.
  for (const value of [0, 1, true, false, {}, [], [NEW], { origin: NEW }, () => NEW]) {
    assert.deepEqual(canonicalOriginFrom(value), { origin: null, ignored: true }, String(value));
  }
});

test('a list of its own, for tests: the same exact match, and only plain addresses', () => {
  const local = 'http://127.0.0.1:4567';
  assert.deepEqual(canonicalOriginFrom(local, [local]), { origin: local, ignored: false });
  assert.deepEqual(canonicalOriginFrom(local, [NEW, local]), { origin: local, ignored: false });
  // With a list of its own, the built-in address is not on it.
  assert.deepEqual(canonicalOriginFrom(NEW, [local]), { origin: null, ignored: true });
  assert.deepEqual(canonicalOriginFrom('http://127.0.0.1:4568', [local]), { origin: null, ignored: true });
  assert.deepEqual(canonicalOriginFrom('http://localhost:4567', [local]), { origin: null, ignored: true });
  // An entry that is more than an address is never used, even if asked for word for word.
  for (const entry of ['https://example.org/path', 'https://example.org/', 'example.org', 'ftp://example.org', 'https://user@example.org', '']) {
    assert.deepEqual(canonicalOriginFrom(entry || 'x', [entry]), { origin: null, ignored: true }, entry);
  }
  // No list, or something that is not a list: nothing is accepted.
  for (const allow of [[], null, 'https://bethere.gladspring.org', { 0: NEW, length: 1 }]) {
    assert.deepEqual(canonicalOriginFrom(NEW, allow), { origin: null, ignored: true });
  }
  assert.deepEqual(canonicalOriginFrom(undefined, [local]), { origin: null, ignored: false });
});
