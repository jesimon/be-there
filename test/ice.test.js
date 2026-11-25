// The relay's plumbing: what anyone may see, when the relay counts as set up,
// what we accept from Cloudflare, and asking for and revoking credentials.
// Nothing here talks to Cloudflare: fetch is always a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_STUN, publicIceServers, relaySettings, cleanIceServers, mintRelay, revokeRelay, createRelay } from '../lib/ice.js';

const KEY_ID = '0123456789abcdef0123456789abcdef';
const API_TOKEN = 'a1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4e5F6abcd';
const settings = { keyId: KEY_ID, apiToken: API_TOKEN, ttl: 43_200 };

// What Cloudflare's documentation says generate-ice-servers returns.
const documented = () => ({
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:443?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'u'.repeat(96),
      credential: 'c'.repeat(96),
    },
  ],
});

const answer = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (body === undefined) throw new SyntaxError('Unexpected token <'); return body; },
});
// A fake fetch that records what it was asked and answers from `reply`.
function fakeFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return typeof reply === 'function' ? reply(url, init) : reply; };
  return { calls, fetchImpl };
}

test('relaySettings: only values that look like a real key count as set up', () => {
  assert.deepEqual(relaySettings({ TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: API_TOKEN }), { keyId: KEY_ID, apiToken: API_TOKEN, ttl: 43_200 });
  // A pasted value often carries a stray space or newline.
  assert.equal(relaySettings({ TURN_KEY_ID: ` ${KEY_ID}\n`, TURN_API_TOKEN: `${API_TOKEN} ` }).keyId, KEY_ID);

  const notSetUp = [
    {},
    { TURN_KEY_ID: '', TURN_API_TOKEN: '' },
    { TURN_KEY_ID: 'paste-turn-token-id-here', TURN_API_TOKEN: 'paste-turn-api-token-here' },
    { TURN_KEY_ID: 'paste-turn-token-id-here', TURN_API_TOKEN: API_TOKEN },
    { TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: 'paste-turn-api-token-here' },
    { TURN_KEY_ID: KEY_ID },
    { TURN_API_TOKEN: API_TOKEN },
    { TURN_KEY_ID: KEY_ID.slice(1), TURN_API_TOKEN: API_TOKEN },          // too short
    { TURN_KEY_ID: `${KEY_ID}0`, TURN_API_TOKEN: API_TOKEN },             // too long
    { TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: API_TOKEN.slice(0, 39) },      // too short
    { TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: `${API_TOKEN.slice(0, 30)} ${API_TOKEN.slice(30)}` }, // a space inside
    { TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: 'your token goes here, about sixty four characters long, thanks' },
  ];
  for (const env of notSetUp) assert.equal(relaySettings(env), null, JSON.stringify(env));
});

test('relaySettings: how long credentials last has a default and limits', () => {
  const ttl = (value) => relaySettings({ TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: API_TOKEN, TURN_TTL_SECONDS: value }).ttl;
  assert.equal(ttl(undefined), 43_200);
  assert.equal(ttl(''), 43_200);
  assert.equal(ttl('not a number'), 43_200);
  assert.equal(ttl('3600'), 3600);
  assert.equal(ttl('60'), 600);
  assert.equal(ttl('0'), 600);
  assert.equal(ttl('-5'), 600);
  assert.equal(ttl('999999'), 172_800);
  assert.equal(ttl('7200.9'), 7200);
});

test('publicIceServers: STUN only, never a relay or a credential', () => {
  assert.deepEqual(publicIceServers({}), [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  assert.deepEqual(publicIceServers(), PUBLIC_STUN);
  assert.notEqual(publicIceServers({})[0], PUBLIC_STUN[0], 'callers get their own copy');
  assert.deepEqual(publicIceServers({ ICE_SERVERS: 'not json' }), PUBLIC_STUN);
  assert.deepEqual(publicIceServers({ ICE_SERVERS: '{"urls":"stun:a.example"}' }), PUBLIC_STUN);
  assert.deepEqual(publicIceServers({ ICE_SERVERS: '[]' }), PUBLIC_STUN);

  const env = {
    ICE_SERVERS: JSON.stringify([
      { urls: 'stun:stun.example.org:3478' },
      { urls: ['stun:two.example.org', 'turn:relay.example.org:3478?transport=udp', 'stun:three.example.org?transport=udp'] },
      { urls: 'turn:relay.example.org:3478', username: 'SECRET-USER', credential: 'SECRET-PASSWORD' },
      { urls: 'stun:four.example.org', username: 'SECRET-USER', credential: 'SECRET-PASSWORD' },
      { urls: 'turns:relay.example.org:443?transport=tcp' },
      { urls: 'stun:stun.example.org:53' },
      null,
      'stun:five.example.org',
    ]),
  };
  const list = publicIceServers(env);
  assert.deepEqual(list, [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['stun:two.example.org'] }]);
  assert.doesNotMatch(JSON.stringify(list), /SECRET|turn|username|credential/);

  // Only relays and credentials in the setting: back to the default.
  const onlyRelays = { ICE_SERVERS: JSON.stringify([{ urls: 'turn:relay.example.org', username: 'SECRET-USER', credential: 'SECRET-PASSWORD' }]) };
  assert.deepEqual(publicIceServers(onlyRelays), PUBLIC_STUN);
});

test('cleanIceServers: Cloudflare’s documented answer passes through unchanged', () => {
  assert.deepEqual(cleanIceServers(documented()), documented().iceServers);
});

test('cleanIceServers: accepts the older single-object shape and removes port 53', () => {
  const older = {
    iceServers: {
      urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'user',
      credential: 'pass',
    },
  };
  assert.deepEqual(cleanIceServers(older), [{
    urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'user',
    credential: 'pass',
  }]);
  // A server whose only address was on port 53 goes altogether.
  assert.deepEqual(cleanIceServers({ iceServers: [{ urls: ['turn:turn.cloudflare.com:53?transport=udp'], username: 'user', credential: 'pass' }] }), []);
});

test('cleanIceServers: drops whatever would make an iPhone or iPad refuse the list', () => {
  const login = { username: 'user', credential: 'pass' };
  const one = (server) => cleanIceServers({ iceServers: [server] });

  // A relay address may carry exactly one transport= and nothing else.
  const badTurn = [
    'turn:relay.example.org?', 'turn:relay.example.org? transport=tcp', 'turn:relay.example.org?transport=udp&transport=tcp',
    'turn:relay.example.org?transport=udp&x=1', 'turn:relay.example.org?foo=bar', 'turn:relay.example.org?transport=sctp',
    'turn:relay.example.org?transport=', 'turn://relay.example.org:3478', 'turn:user@relay.example.org', 'turn:relay.example.org:99999',
    'turn:relay.example.org:0', 'turn:printer.local:3478', 'http://relay.example.org', 'turn:', '', 42, null,
  ];
  for (const url of badTurn) assert.deepEqual(one({ urls: [url], ...login }), [], String(url));
  const goodTurn = ['turn:relay.example.org', 'turn:relay.example.org:3478', 'turn:relay.example.org?transport=udp', 'turns:relay.example.org:443?transport=tcp', 'turn:192.0.2.7:3478?transport=udp', 'turn:[2001:db8::7]:3478?transport=udp'];
  for (const url of goodTurn) assert.deepEqual(one({ urls: [url], ...login }), [{ urls: [url], ...login }], url);

  // A STUN address may not carry a query at all.
  assert.deepEqual(one({ urls: ['stun:stun.example.org?transport=udp'] }), []);
  assert.deepEqual(one({ urls: 'stun:stun.example.org' }), [{ urls: ['stun:stun.example.org'] }]);

  // A relay needs both a username and a password, each no longer than 509 bytes.
  const turn = 'turn:relay.example.org:3478?transport=udp';
  assert.deepEqual(one({ urls: [turn] }), []);
  assert.deepEqual(one({ urls: [turn], username: 'user' }), []);
  assert.deepEqual(one({ urls: [turn], credential: 'pass' }), []);
  assert.deepEqual(one({ urls: [turn], username: '', credential: 'pass' }), []);
  assert.deepEqual(one({ urls: [turn], username: 5, credential: 'pass' }), []);
  assert.deepEqual(one({ urls: [turn], username: 'u'.repeat(510), credential: 'pass' }), []);
  assert.deepEqual(one({ urls: [turn], username: 'user', credential: 'é'.repeat(255) }), [], '510 bytes, though 255 characters');
  assert.equal(one({ urls: [turn], username: 'u'.repeat(509), credential: 'c'.repeat(509) }).length, 1);

  // Without a usable login the relay addresses go, but a STUN address in the same entry stays.
  assert.deepEqual(one({ urls: ['stun:stun.example.org', turn] }), [{ urls: ['stun:stun.example.org'] }]);
  // An entry left with no address is dropped rather than passed on empty.
  assert.deepEqual(cleanIceServers({ iceServers: [{ urls: [] }, { urls: ['turn:x?bad'], ...login }, {}, null, 'stun:a.example'] }), []);

  // Only known fields are kept.
  assert.deepEqual(one({ urls: [turn], ...login, credentialType: 'password', extra: { deep: true } }), [{ urls: [turn], ...login }]);
  assert.deepEqual(one({ urls: ['stun:stun.example.org'], username: 'user', credential: 'pass' }), [{ urls: ['stun:stun.example.org'] }]);

  for (const junk of [null, undefined, 'text', 7, {}, { iceServers: 'stun:a.example' }, { iceServers: 5 }]) assert.deepEqual(cleanIceServers(junk), []);
});

test('mintRelay: asks Cloudflare the documented way and returns the servers', async () => {
  const { calls, fetchImpl } = fakeFetch(answer(201, documented()));
  const made = await mintRelay(settings, { fetchImpl });
  assert.equal(made.ok, true);
  assert.deepEqual(made.iceServers, documented().iceServers);
  assert.equal(made.username, 'u'.repeat(96));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { ttl: 43_200 });
  // Any 2xx counts.
  assert.equal((await mintRelay(settings, { fetchImpl: fakeFetch(answer(200, documented())).fetchImpl })).ok, true);
});

test('mintRelay: every failure comes back as a reason, never as an exception', async () => {
  const mint = (reply, options = {}) => mintRelay(settings, { fetchImpl: fakeFetch(reply).fetchImpl, ...options });
  assert.deepEqual(await mint(answer(404, { error: 'cannot find specified key' })), { ok: false, reason: 'http_404' });
  assert.deepEqual(await mint(answer(401, {})), { ok: false, reason: 'http_401' });
  assert.deepEqual(await mint(answer(500, undefined)), { ok: false, reason: 'http_500' });
  assert.deepEqual(await mint(answer(201, undefined)), { ok: false, reason: 'bad_response' }, 'not JSON');
  assert.deepEqual(await mint(answer(201, { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] })), { ok: false, reason: 'bad_response' }, 'no relay in the answer');
  assert.deepEqual(await mint(answer(201, { error: 'something else' })), { ok: false, reason: 'bad_response' });
  assert.deepEqual(await mint(() => { throw new TypeError('fetch failed'); }), { ok: false, reason: 'network' });
  // An answer that never comes: we stop waiting, and tell fetch to stop too.
  let signal;
  const started = Date.now();
  assert.deepEqual(await mint((url, init) => { signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 40 }), { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(signal.aborted, true);
  // A body that never finishes arriving is a timeout as well.
  assert.deepEqual(await mint({ ok: true, status: 201, json: () => new Promise(() => {}) }, { timeoutMs: 40 }), { ok: false, reason: 'timeout' });

  // Not set up: nobody is asked.
  const { calls, fetchImpl } = fakeFetch(answer(201, documented()));
  assert.deepEqual(await mintRelay(null, { fetchImpl }), { ok: false, reason: 'not_set_up' });
  assert.equal(calls.length, 0);
});

test('revokeRelay: tells Cloudflare, and never throws', async () => {
  const { calls, fetchImpl } = fakeFetch(answer(204, undefined));
  assert.equal(await revokeRelay(settings, 'user/with spaces', { fetchImpl }), true);
  assert.equal(calls[0].url, `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/user%2Fwith%20spaces/revoke`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_TOKEN}`);

  assert.equal(await revokeRelay(settings, 'gone', { fetchImpl: fakeFetch(answer(404, {})).fetchImpl }), false);
  assert.equal(await revokeRelay(settings, 'u', { fetchImpl: () => { throw new Error('boom'); } }), false);
  assert.equal(await revokeRelay(settings, 'u', { fetchImpl: () => Promise.reject(new TypeError('fetch failed')) }), false);
  assert.equal(await revokeRelay(settings, 'u', { fetchImpl: () => new Promise(() => {}), timeoutMs: 40 }), false);
  // Nothing to revoke, or no relay: nobody is asked.
  const none = fakeFetch(answer(204, undefined));
  assert.equal(await revokeRelay(settings, '', { fetchImpl: none.fetchImpl }), false);
  assert.equal(await revokeRelay(settings, undefined, { fetchImpl: none.fetchImpl }), false);
  assert.equal(await revokeRelay(null, 'u', { fetchImpl: none.fetchImpl }), false);
  assert.equal(none.calls.length, 0);
});

test('createRelay: off with placeholder settings, and a short life on request', async () => {
  const off = fakeFetch(answer(201, documented()));
  const placeholder = createRelay({ env: { TURN_KEY_ID: 'paste-turn-token-id-here', TURN_API_TOKEN: 'paste-turn-api-token-here' }, fetchImpl: off.fetchImpl });
  assert.equal(placeholder.ready, false);
  assert.deepEqual(await placeholder.mint(), { ok: false, reason: 'not_set_up' });
  assert.equal(await placeholder.revoke('u'), false);
  assert.equal(off.calls.length, 0, 'placeholder text is never sent anywhere');

  const on = fakeFetch((url) => (url.endsWith('/revoke') ? answer(204, undefined) : answer(201, documented())));
  const relay = createRelay({ env: { TURN_KEY_ID: KEY_ID, TURN_API_TOKEN: API_TOKEN, TURN_TTL_SECONDS: '7200' }, fetchImpl: on.fetchImpl });
  assert.equal(relay.ready, true);
  assert.equal(relay.ttl, 7200);
  assert.equal((await relay.mint()).ok, true);
  assert.deepEqual(JSON.parse(on.calls[0].init.body), { ttl: 7200 });
  assert.equal((await relay.mint({ ttl: 60 })).ok, true);
  assert.deepEqual(JSON.parse(on.calls[1].init.body), { ttl: 60 });
  assert.equal(await relay.revoke('u'.repeat(96)), true);
  assert.match(on.calls[2].url, /\/credentials\/u{96}\/revoke$/);
});

test('the relay code never writes to the log', async (t) => {
  const written = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => written.push(args));
  await mintRelay(settings, { fetchImpl: fakeFetch(answer(201, documented())).fetchImpl });
  await mintRelay(settings, { fetchImpl: fakeFetch(answer(404, {})).fetchImpl });
  await mintRelay(settings, { fetchImpl: () => { throw new Error('boom'); } });
  await revokeRelay(settings, 'u'.repeat(96), { fetchImpl: () => { throw new Error('boom'); } });
  await revokeRelay(settings, 'u'.repeat(96), { fetchImpl: fakeFetch(answer(204, undefined)).fetchImpl });
  assert.deepEqual(written, []);
});
