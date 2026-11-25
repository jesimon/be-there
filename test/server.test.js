// The server end to end, without video: setup, invitations, consent, knocking,
// answering, passing signals, and ending. Then the relay: who may ask for it,
// who is told, and that its credentials stop working when the visit ends.
// The relay is always a fake here: nothing in these tests talks to Cloudflare.
// Then the new address: which one is accepted, and that both are served alike.
// Last, visitors' photos: who may add, change, remove and see them, what is
// kept, and that none of it is logged or written into the repository.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, createApp } from '../server.js';
import { createStore } from '../lib/store.js';
import { photosInMemory } from '../lib/photos.js';
import { acceptPhoto, JFIF_START } from '../lib/jpeg.js';

// Every file in the repository (but not what is installed, or git's own), with
// its size and when it was last written: taken now, and compared at the very
// end, to show that these tests write nothing into the repository.
const repository = fileURLToPath(new URL('..', import.meta.url));
function repositoryFiles() {
  const found = {};
  const look = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) look(full);
      else { const stat = fs.statSync(full); found[path.relative(repository, full)] = `${stat.size} bytes, written ${stat.mtimeMs}`; }
    }
  };
  look(repository);
  return found;
}
const repositoryBefore = repositoryFiles();

let srv;
before(async () => { srv = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: 'open-sesame', env: {} }); });
after(() => srv.close());

const reqOn = (server) => async (path, { token, method = 'GET', body } = {}) => {
  const res = await fetch(server.url + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a page, not JSON */ }
  return { status: res.status, headers: res.headers, body: json, text };
};
const req = (...args) => reqOn(srv)(...args);
const client = (...args) => clientOn(srv)(...args);

// A WebSocket client that records messages and can wait for one.
const clientOn = (server) => function connectClient(role, token) {
  const ws = new WebSocket(server.url.replace('http', 'ws') + '/ws');
  const seen = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    seen.push(msg);
    for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise((resolve) => ws.on('open', resolve));
  return {
    ws, seen, closed,
    ready: opened.then(() => ws.send(JSON.stringify({ type: 'hello', role, token, timeZone: 'UTC' }))),
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, test = () => true) {
      const found = seen.find((m) => m.type === type && test(m) && !m._used);
      if (found) { found._used = true; return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
        waiters.push({ test: (m) => m.type === type && test(m), resolve: (m) => { clearTimeout(timer); m._used = true; resolve(m); } });
      });
    },
  };
};

test('pages are private and carry safe headers', async () => {
  const res = await req('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const page of ['/', '/home', '/visit', '/organize', '/setup']) {
    const r = await fetch(srv.url + page);
    assert.equal(r.status, 200, page);
    assert.match(await r.text(), /noindex/);
  }
});

test('pages, scripts and styles are checked with the server every time', async () => {
  for (const file of ['/', '/home', '/visit', '/organize', '/setup', '/setup.html', '/js/common.js', '/js/peer.js', '/js/moved.js', '/js/photo.js', '/js/home.js', '/js/visit.js', '/js/organize.js', '/js/setup.js', '/css/style.css']) {
    const r = await fetch(srv.url + file);
    assert.equal(r.status, 200, file);
    assert.equal(r.headers.get('cache-control'), 'no-cache', file);
    assert.ok(r.headers.get('etag'), `${file} has an ETag`);
    await r.arrayBuffer();
  }
});

test('/api/config keeps its shape for pages that are already open, and lists STUN only', async () => {
  const config = (await req('/api/config')).body;
  // canonicalOrigin was added with the new address; null means there is none.
  assert.deepEqual(config, { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], dropInNoticeSeconds: 8, canonicalOrigin: null });

  // Even if someone puts a relay and its password in ICE_SERVERS.
  const env = { ICE_SERVERS: JSON.stringify([{ urls: 'stun:stun.example.org:3478' }, { urls: 'turn:relay.example.org:3478', username: 'SECRET-USER', credential: 'SECRET-PASSWORD' }]) };
  const other = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '', env });
  try {
    const res = await reqOn(other)('/api/config');
    assert.deepEqual(res.body.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
    assert.doesNotMatch(res.text, /SECRET|turn:|username|credential/);
  } finally {
    await other.close();
  }
});

test('a full visit: invite, consent, knock, answer, signals, end', async () => {
  // Setting up needs the password.
  assert.equal((await req('/api/homes', { method: 'POST', body: { personName: 'Mary' } })).status, 401);
  const created = await req('/api/homes', { method: 'POST', body: { personName: 'Mary', password: ' open-sesame\n', hours: { start: '00:00', end: '23:59' } } });
  assert.equal(created.status, 201);
  const { homeToken, organizerToken } = created.body;

  // The organizer invites Sarah; she can't visit yet.
  assert.equal((await req('/api/organize', { token: homeToken })).status, 401, 'a home screen link is not an organizer link');
  const inv = await req('/api/organize/visitors', { token: organizerToken, method: 'POST', body: { name: 'Sarah', relation: 'Granddaughter' } });
  assert.equal(inv.status, 201);
  const sarahToken = inv.body.token;
  const sarahId = inv.body.visitor.id;
  assert.equal((await req('/api/visit', { token: sarahToken })).body.status, 'awaiting_approval');

  // Organizers cannot approve visitors or pause for the person at home.
  await req('/api/organize/home', { token: organizerToken, method: 'PATCH', body: { paused: true } });
  assert.equal((await req('/api/organize', { token: organizerToken })).body.home.paused, false);

  const homeScreen = client('home', homeToken);
  await homeScreen.ready;
  const first = await homeScreen.next('state');
  assert.equal(first.home.visitors[0].approved, false);

  const sarah = client('visitor', sarahToken);
  await sarah.ready;
  assert.equal((await sarah.next('status')).view.status, 'awaiting_approval');
  sarah.send({ type: 'knock' });
  assert.equal((await sarah.next('cannot')).reason, 'awaiting_approval');

  // Mary says yes on her screen.
  homeScreen.send({ type: 'approve', visitorId: sarahId, approved: true });
  await sarah.next('status', (m) => m.view.canVisit);

  // Sarah knocks; Mary's screen shows it.
  sarah.send({ type: 'knock' });
  await sarah.next('ringing');
  const knock = await homeScreen.next('knock');
  assert.equal(knock.name, 'Sarah');
  assert.equal(knock.mode, 'knock');

  // A signal before Mary answers goes nowhere.
  sarah.send({ type: 'signal', data: { early: true } });

  homeScreen.send({ type: 'answer', visitorId: sarahId });
  await sarah.next('answered');
  sarah.send({ type: 'signal', data: { sdp: { type: 'offer', sdp: 'x' } } });
  const toHome = await homeScreen.next('signal');
  assert.deepEqual(toHome.data, { sdp: { type: 'offer', sdp: 'x' } });
  homeScreen.send({ type: 'signal', data: { sdp: { type: 'answer', sdp: 'y' } } });
  assert.deepEqual((await sarah.next('signal')).data, { sdp: { type: 'answer', sdp: 'y' } });
  assert.ok(!homeScreen.seen.some((m) => m.type === 'signal' && m.data?.early), 'no signals before answering');

  // A second visitor is told someone else is visiting.
  const tom = (await req('/api/organize/visitors', { token: organizerToken, method: 'POST', body: { name: 'Tom' } })).body;
  homeScreen.send({ type: 'approve', visitorId: tom.visitor.id, approved: true });
  const tomWs = client('visitor', tom.token);
  await tomWs.ready;
  assert.equal((await tomWs.next('status', (m) => m.view.status === 'busy')).view.canVisit, false);
  assert.doesNotMatch(JSON.stringify(tomWs.seen), /Sarah/, 'visitors never learn who else visits');

  // Mary pauses visits: the visit ends at once.
  homeScreen.send({ type: 'pause', paused: true });
  assert.equal((await sarah.next('ended')).reason, 'paused');
  await sarah.next('status', (m) => m.view.status === 'paused');
  homeScreen.send({ type: 'pause', paused: false });
  await sarah.next('status', (m) => m.view.canVisit);

  // Drop-in: Mary lets Sarah come straight in; the home screen is told so it can count down.
  homeScreen.send({ type: 'mode', visitorId: sarahId, mode: 'dropin' });
  await sarah.next('status', (m) => m.view.you.mode === 'dropin');
  sarah.send({ type: 'knock' });
  const drop = await homeScreen.next('knock', (m) => m.mode === 'dropin');
  assert.ok(drop.notice >= 5, 'the person at home always gets notice');
  homeScreen.send({ type: 'decline', visitorId: sarahId });
  assert.equal((await sarah.next('ended')).reason, 'declined');

  // Removing Sarah closes her connection and her link stops working.
  assert.equal((await req(`/api/organize/visitors/${sarahId}`, { token: organizerToken, method: 'DELETE' })).status, 200);
  assert.equal(await sarah.closed, 4003);
  assert.equal((await req('/api/visit', { token: sarahToken })).status, 401);

  // Turning the home screen off shows Tom it is offline.
  homeScreen.ws.close();
  await tomWs.next('status', (m) => m.view.status === 'offline');

  // Deleting the home removes everything.
  assert.equal((await req('/api/organize/home', { token: organizerToken, method: 'DELETE' })).status, 200);
  assert.equal((await req('/api/organize', { token: organizerToken })).status, 401);
  assert.equal((await req('/api/visit', { token: tom.token })).status, 401);
  tomWs.ws.close();
});

test('a newer home screen replaces the old one, and bad links are refused', async () => {
  const { homeToken } = (await req('/api/homes', { method: 'POST', body: { personName: 'Joe', password: 'open-sesame' } })).body;
  const a = client('home', homeToken);
  await a.ready;
  await a.next('state');
  const b = client('home', homeToken);
  await b.ready;
  await b.next('state');
  assert.equal(await a.closed, 4004);
  const bad = client('home', 'not-a-real-token');
  await bad.ready;
  assert.equal(await bad.closed, 4001);
  b.ws.close();
});

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

// Stands in for lib/ice.js's createRelay(): hands out made-up servers and
// remembers what it was asked. `gate` holds an answer back until released.
function fakeRelay({ ready = true, ttl = 3600 } = {}) {
  const relay = {
    ready,
    ttl,
    asked: [],          // the options of every mint
    minted: [],         // usernames handed out
    revoked: [],
    fail: null,         // a reason: make the next mints fail
    gate: null,
    async mint(options) {
      relay.asked.push(options);
      if (relay.gate) await relay.gate;
      if (relay.fail === 'throw') throw new Error('boom');
      if (relay.fail) return { ok: false, reason: relay.fail };
      const n = relay.minted.length + 1;
      const username = `relay-user-${n}`;
      relay.minted.push(username);
      return { ok: true, username, iceServers: [{ urls: ['turn:relay.example.org:3478?transport=udp'], username, credential: `relay-secret-${n}` }] };
    },
    async revoke(username) { relay.revoked.push(username); },
  };
  return relay;
}

const until = async (check, what = 'condition') => {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// A server of its own with a fake relay. Homes are made straight in the store,
// so the tests are not slowed by the limit on creating homes.
async function world(t, { relay = fakeRelay(), now, env = {}, store = createStore(':memory:') } = {}) {
  const server = await startServer({ port: 0, store, setupPassword: '', env, relay, ...(now ? { now } : {}) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(); } };
  t.after(close);
  const w = { relay, store, server, close, req: reqOn(server), client: clientOn(server) };

  // A home with approved visitors, its screen switched on, and everyone connected.
  w.household = async (names = ['Sarah']) => {
    const { home, homeToken, organizerToken } = store.createHome({ personName: 'Mary', hours: { start: '00:00', end: '00:00' } });
    const homeScreen = w.client('home', homeToken);
    await homeScreen.ready;
    await homeScreen.next('state');
    const people = [];
    for (const name of names) {
      const { visitor, token } = store.addVisitor(home, { name });
      store.updateVisitor(home, visitor.id, { approved: true });
      const socket = w.client('visitor', token);
      await socket.ready;
      await socket.next('status', (m) => m.view.canVisit);
      people.push({ id: visitor.id, token, socket });
    }
    return { home, homeToken, organizerToken, homeScreen, people, sarah: people[0].socket, sarahId: people[0].id };
  };
  // ...and then a visit in progress between the home screen and the first visitor.
  w.visit = async (names) => {
    const h = await w.household(names);
    h.sarah.send({ type: 'knock' });
    await h.homeScreen.next('knock');
    h.homeScreen.send({ type: 'answer', visitorId: h.sarahId });
    await h.sarah.next('answered');
    return h;
  };
  // ...and then relay credentials made for it (the visitor asked).
  w.relayedVisit = async (names) => {
    const h = await w.visit(names);
    h.sarah.send({ type: 'relay' });
    const msg = await h.sarah.next('relay');
    await h.homeScreen.next('relay');
    return { ...h, username: msg.iceServers[0].username };
  };
  return w;
}

const relayMessages = (socket) => socket.seen.filter((m) => m.type === 'relay');
// Waits until the server has dealt with everything both devices of a visit
// have sent so far, and they have received whatever it sent back: each sends
// the other a signal, which arrives after anything sent before it.
let marks = 0;
async function settled(v) {
  marks += 1;
  const mark = marks;
  v.homeScreen.send({ type: 'signal', data: { mark } });
  v.sarah.send({ type: 'signal', data: { mark } });
  await v.sarah.next('signal', (m) => m.data?.mark === mark);
  await v.homeScreen.next('signal', (m) => m.data?.mark === mark);
}
// A received message without the test client's own bookkeeping.
const plain = ({ _used, ...msg }) => msg;

test('relay: ignored when there is no visit, while it rings, and from someone who is not in the visit', async (t) => {
  const w = await world(t);
  const { homeScreen, people, sarah, sarahId } = await w.household(['Sarah', 'Tom']);
  const tom = people[1].socket;

  // No visit. Each sends something after it that the server does answer, so we
  // know the relay request was read and passed over.
  homeScreen.send({ type: 'relay' });
  homeScreen.send({ type: 'mode', visitorId: sarahId, mode: 'knock' });
  await homeScreen.next('state');
  sarah.send({ type: 'relay' });
  sarah.send({ type: 'cancel' });

  // Ringing: not yet answered, so not yet a visit.
  sarah.send({ type: 'knock' });
  await homeScreen.next('knock');
  sarah.send({ type: 'relay' });
  sarah.send({ type: 'knock' });
  assert.equal((await sarah.next('cannot')).reason, 'busy');
  homeScreen.send({ type: 'relay' });
  homeScreen.send({ type: 'mode', visitorId: sarahId, mode: 'knock' });
  await homeScreen.next('state', (m) => m.call?.state === 'ringing');

  // Answered. Tom has a working link but is not the one visiting.
  homeScreen.send({ type: 'answer', visitorId: sarahId });
  await sarah.next('answered');
  tom.send({ type: 'relay' });
  tom.send({ type: 'knock' });
  assert.equal((await tom.next('cannot')).reason, 'busy');

  assert.equal(w.relay.asked.length, 0, 'no credentials were made');
  for (const socket of [homeScreen, sarah, tom]) assert.deepEqual(relayMessages(socket), []);

  // Now the visitor in the visit asks, and it works; Tom still hears nothing.
  sarah.send({ type: 'relay' });
  await sarah.next('relay');
  await homeScreen.next('relay');
  tom.send({ type: 'knock' });
  await tom.next('cannot');
  assert.deepEqual(relayMessages(tom), []);
  assert.doesNotMatch(JSON.stringify(tom.seen), /relay-user|relay-secret|Sarah/);
});

test('relay: both devices of a live visit get the same servers, made once', async (t) => {
  const w = await world(t);
  const { homeScreen, sarah } = await w.visit();

  // Both ask before the answer has come back: one request is made for both.
  let release;
  w.relay.gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  sarah.send({ type: 'relay' });
  homeScreen.send({ type: 'relay' });
  sarah.send({ type: 'relay' });
  // The signals of the visit keep flowing meanwhile.
  await settled({ homeScreen, sarah });
  assert.equal(w.relay.asked.length, 1);
  assert.deepEqual(relayMessages(sarah), [], 'nothing is said until the credentials exist');
  release();
  w.relay.gate = null;

  const toVisitor = plain(await sarah.next('relay'));
  const toHome = plain(await homeScreen.next('relay'));
  assert.deepEqual(toVisitor, { type: 'relay', iceServers: [{ urls: ['turn:relay.example.org:3478?transport=udp'], username: 'relay-user-1', credential: 'relay-secret-1' }], ttl: 3600 });
  assert.deepEqual(toHome, toVisitor);

  // Asking again gets the same answer, to the asker alone, and nothing new is made.
  await settled({ homeScreen, sarah });
  assert.equal(relayMessages(homeScreen).length, 1, 'one answer, though the home screen asked once and the visitor twice');
  assert.equal(relayMessages(sarah).length, 1);
  homeScreen.send({ type: 'relay' });
  assert.deepEqual(plain(await homeScreen.next('relay')), toVisitor);
  await settled({ homeScreen, sarah });
  assert.equal(relayMessages(sarah).length, 1, 'the visitor is not told again when the home screen asks again');
  sarah.send({ type: 'relay' });
  assert.deepEqual(plain(await sarah.next('relay')), toVisitor);
  await settled({ homeScreen, sarah });
  assert.equal(relayMessages(homeScreen).length, 2);
  assert.equal(relayMessages(sarah).length, 2);
  assert.equal(w.relay.asked.length, 1);
  assert.deepEqual(w.relay.asked[0], undefined, 'the usual lifetime');
  assert.deepEqual(w.relay.revoked, [], 'nothing is revoked while the visit goes on');
});

test('relay: "not set up" and "unavailable" go only to the one who asked', async (t) => {
  const off = await world(t, { relay: fakeRelay({ ready: false }) });
  const a = await off.visit();
  a.sarah.send({ type: 'relay' });
  assert.deepEqual(plain(await a.sarah.next('relay')), { type: 'relay', iceServers: null, reason: 'not_set_up' });
  await settled(a);
  assert.deepEqual(relayMessages(a.homeScreen), [], 'the home screen did not ask, so it is told nothing');
  a.homeScreen.send({ type: 'relay' });
  assert.deepEqual(plain(await a.homeScreen.next('relay')), { type: 'relay', iceServers: null, reason: 'not_set_up' });
  await settled(a);
  assert.equal(relayMessages(a.sarah).length, 1);
  assert.equal(relayMessages(a.homeScreen).length, 1);
  assert.equal(off.relay.asked.length, 0);

  for (const failure of ['http_404', 'timeout', 'throw']) {
    const w = await world(t);
    w.relay.fail = failure;
    const b = await w.visit();
    b.homeScreen.send({ type: 'relay' });
    // The reason given to the page is always the same plain one.
    assert.deepEqual(plain(await b.homeScreen.next('relay')), { type: 'relay', iceServers: null, reason: 'unavailable' });
    await settled(b);
    assert.deepEqual(relayMessages(b.sarah), [], failure);
    assert.deepEqual(w.relay.revoked, []);

    // A later request may try again, and can succeed.
    w.relay.fail = null;
    b.sarah.send({ type: 'relay' });
    assert.equal((await b.sarah.next('relay')).iceServers[0].username, 'relay-user-1');
    await b.homeScreen.next('relay', (m) => m.iceServers);
    await w.close();
  }
});

test('relay: credentials stop working however the visit ends', async (t) => {
  const endings = {
    'the visitor leaves': (v) => v.sarah.send({ type: 'end' }),
    'the visitor gives up connecting': (v) => v.sarah.send({ type: 'end', reason: 'no_connection' }),
    'the person at home ends it': (v) => v.homeScreen.send({ type: 'end' }),
    'the person at home pauses visits': (v) => v.homeScreen.send({ type: 'pause', paused: true }),
    'the person at home stops this visitor': (v) => v.homeScreen.send({ type: 'approve', visitorId: v.sarahId, approved: false }),
    'the organizer removes the visitor': (v, w) => w.req(`/api/organize/visitors/${v.sarahId}`, { token: v.organizerToken, method: 'DELETE' }),
    'the home screen goes offline': (v) => v.homeScreen.ws.close(),
    'the visitor’s phone goes offline': (v) => v.sarah.ws.terminate(),
    'another screen takes over as the home screen': async (v, w) => { const second = w.client('home', v.homeToken); await second.ready; },
    'the organizer replaces the home screen link': (v, w) => w.req('/api/organize/home-link', { token: v.organizerToken, method: 'POST' }),
    'the organizer deletes the home': (v, w) => w.req('/api/organize/home', { token: v.organizerToken, method: 'DELETE' }),
    'the server stops': (v, w) => w.close(),
  };
  for (const [name, end] of Object.entries(endings)) {
    const w = await world(t);
    const v = await w.relayedVisit();
    assert.deepEqual(w.relay.revoked, [], name);
    await end(v, w);
    await until(() => w.relay.revoked.length > 0, `revocation when ${name}`);
    assert.deepEqual(w.relay.revoked, [v.username], name);
    await w.close();
    assert.deepEqual(w.relay.revoked, [v.username], `${name}: revoked once`);
  }
});

test('when the server stops, it waits until the relay service has been told', async (t) => {
  const w = await world(t);
  const v = await w.relayedVisit();
  // Telling the relay service takes a moment, as it does over the network.
  w.relay.revoke = async (username) => { await new Promise((r) => setTimeout(r, 60)); w.relay.revoked.push(username); };
  await w.close();
  assert.deepEqual(w.relay.revoked, [v.username], 'revoked by the time the server has stopped');
  assert.equal((await v.sarah.next('ended')).reason, 'offline');
});

test('relay: a visit that ends while its credentials are being made', async (t) => {
  const w = await world(t);
  const { homeScreen, sarah } = await w.visit();
  let release;
  w.relay.gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  sarah.send({ type: 'relay' });
  await until(() => w.relay.asked.length >= 1, 'the request for credentials');
  homeScreen.send({ type: 'end' });
  await sarah.next('ended');
  assert.deepEqual(w.relay.revoked, []);
  release();
  // They are revoked at once, and given to nobody.
  await until(() => w.relay.revoked.length === 1, 'revocation');
  assert.deepEqual(w.relay.revoked, ['relay-user-1']);
  sarah.send({ type: 'knock' });
  await sarah.next('ringing');
  assert.deepEqual(relayMessages(sarah), []);
  assert.deepEqual(relayMessages(homeScreen), []);
});

test('relay: every visit gets its own credentials', async (t) => {
  const w = await world(t);
  const v = await w.relayedVisit();
  v.sarah.send({ type: 'end' });
  await v.homeScreen.next('ended');
  await until(() => w.relay.revoked.length === 1, 'revocation');

  v.sarah.send({ type: 'knock' });
  await v.homeScreen.next('knock');
  v.homeScreen.send({ type: 'answer', visitorId: v.sarahId });
  await v.sarah.next('answered');
  v.homeScreen.send({ type: 'relay' });
  assert.equal((await v.sarah.next('relay')).iceServers[0].username, 'relay-user-2');
  v.homeScreen.send({ type: 'end' });
  await until(() => w.relay.revoked.length === 2, 'second revocation');
  assert.deepEqual(w.relay.revoked, ['relay-user-1', 'relay-user-2']);
});

test('relay: credentials never appear in anything served outside the visit', async (t) => {
  const w = await world(t);
  const v = await w.relayedVisit(['Sarah', 'Tom']);
  const secret = /relay-user|relay-secret|relay\.example|"credential"|"username"/;
  for (const path of ['/healthz', '/api/config', '/api/setup-info', '/api/visit', '/api/organize', '/', '/home', '/visit', '/organize', '/setup', '/js/peer.js', '/no-such-page']) {
    const res = await w.req(path);
    assert.doesNotMatch(res.text, secret, path);
  }
  // Nor in what the organizer or another visitor is given, with their links.
  assert.doesNotMatch((await w.req('/api/organize', { token: v.organizerToken })).text, secret);
  assert.doesNotMatch((await w.req('/api/visit', { token: v.people[1].token })).text, secret);
  assert.doesNotMatch((await w.req('/api/visit', { token: v.people[0].token })).text, secret);
  assert.doesNotMatch(JSON.stringify(v.people[1].socket.seen), secret);
  // /api/config still says what it always said.
  assert.deepEqual((await w.req('/api/config')).body, { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], dropInNoticeSeconds: 8, canonicalOrigin: null });
});

test('the organizer sees whether the relay is set up, and can test it', async (t) => {
  const w = await world(t);
  const { homeToken, organizerToken, people } = await w.household();
  assert.equal((await w.req('/api/organize', { token: organizerToken })).body.relay, 'ready');

  // Only the organizer's link may run the test.
  for (const token of [undefined, 'not-a-real-token', homeToken, people[0].token]) {
    assert.equal((await w.req('/api/organize/relay-test', { token, method: 'POST' })).status, 401);
  }
  assert.equal(w.relay.asked.length, 0);

  // It makes credentials that last a minute and revokes them straight away.
  const good = await w.req('/api/organize/relay-test', { token: organizerToken, method: 'POST' });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { ok: true });
  assert.deepEqual(w.relay.asked, [{ ttl: 60 }]);
  assert.deepEqual(w.relay.revoked, ['relay-user-1']);
  assert.doesNotMatch(good.text, /relay-user|relay-secret/);

  // A key that Cloudflare does not accept: a plain reason, nothing to revoke.
  w.relay.fail = 'http_404';
  assert.deepEqual((await w.req('/api/organize/relay-test', { token: organizerToken, method: 'POST' })).body, { ok: false, reason: 'http_404' });
  w.relay.fail = 'throw';
  assert.deepEqual((await w.req('/api/organize/relay-test', { token: organizerToken, method: 'POST' })).body, { ok: false, reason: 'network' });
  assert.deepEqual(w.relay.revoked, ['relay-user-1']);

  // It cannot be used to hammer the relay service.
  w.relay.fail = null;
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await w.req('/api/organize/relay-test', { token: organizerToken, method: 'POST' })).status);
  assert.ok(statuses.includes(429), 'limited to a few tries a minute');
  assert.ok(w.relay.asked.length <= 6);

  // Not set up: says so, and asks nobody.
  const off = await world(t, { relay: fakeRelay({ ready: false }) });
  const h = await off.household();
  assert.equal((await off.req('/api/organize', { token: h.organizerToken })).body.relay, 'off');
  assert.deepEqual((await off.req('/api/organize/relay-test', { token: h.organizerToken, method: 'POST' })).body, { ok: false, reason: 'not_set_up' });
  assert.equal(off.relay.asked.length, 0);
  assert.equal(off.server.relayReady, false);
  assert.equal(w.server.relayReady, true);
});

test('the relay test falls back to the usual lifetime if a one-minute one is refused', async (t) => {
  const w = await world(t);
  const { organizerToken } = await w.household();
  const test = async () => (await w.req('/api/organize/relay-test', { token: organizerToken, method: 'POST' })).body;
  // A relay service that will not make credentials lasting only a minute.
  const usual = w.relay.mint;
  w.relay.mint = async (options) => {
    if (options?.ttl !== 60) return usual(options);
    w.relay.asked.push(options);
    return { ok: false, reason: 'http_400' };
  };
  assert.deepEqual(await test(), { ok: true });
  assert.deepEqual(w.relay.asked, [{ ttl: 60 }, undefined]);
  assert.deepEqual(w.relay.revoked, ['relay-user-1'], 'and those are revoked straight away as well');

  // Refused either way: the reason is passed on, after one more try and no more.
  w.relay.mint = async (options) => { w.relay.asked.push(options); return { ok: false, reason: 'http_400' }; };
  assert.deepEqual(await test(), { ok: false, reason: 'http_400' });
  assert.equal(w.relay.asked.length, 4);
  // A key that is not accepted is not tried twice.
  w.relay.mint = async (options) => { w.relay.asked.push(options); return { ok: false, reason: 'http_401' }; };
  assert.deepEqual(await test(), { ok: false, reason: 'http_401' });
  assert.equal(w.relay.asked.length, 5);
});

test('why a visit ended is passed on only when it is a reason we know', async (t) => {
  const w = await world(t);
  const v = await w.visit();
  const again = async () => {
    v.sarah.send({ type: 'knock' });
    await v.homeScreen.next('knock');
    v.homeScreen.send({ type: 'answer', visitorId: v.sarahId });
    await v.sarah.next('answered');
  };

  v.sarah.send({ type: 'end', reason: 'no_connection' });
  assert.equal((await v.homeScreen.next('ended')).reason, 'no_connection');
  assert.equal((await v.sarah.next('ended')).reason, 'no_connection');

  await again();
  v.homeScreen.send({ type: 'end', reason: 'no_connection' });
  assert.equal((await v.sarah.next('ended')).reason, 'no_connection');
  assert.equal((await v.homeScreen.next('ended')).reason, 'no_connection');

  for (const reason of [undefined, 'ended', 'paused', 'removed', '<b>hello</b>', 7, { a: 1 }, null]) {
    await again();
    v.sarah.send({ type: 'end', reason });
    assert.equal((await v.homeScreen.next('ended')).reason, 'ended', JSON.stringify(reason));
    assert.equal((await v.sarah.next('ended')).reason, 'ended');
    await again();
    v.homeScreen.send({ type: 'end', reason });
    assert.equal((await v.sarah.next('ended')).reason, 'ended', JSON.stringify(reason));
    assert.equal((await v.homeScreen.next('ended')).reason, 'ended');
  }

  // Cancelling a knock is still reported as cancelled, whatever reason is sent with it.
  v.sarah.send({ type: 'knock' });
  await v.homeScreen.next('knock');
  v.sarah.send({ type: 'cancel', reason: 'no_connection' });
  assert.equal((await v.homeScreen.next('ended')).reason, 'cancelled');
  assert.equal((await v.sarah.next('ended')).reason, 'cancelled');

  // A knock that was never answered has not tried to connect: neither side
  // can make the other be told that it "couldn't connect".
  v.sarah.send({ type: 'knock' });
  await v.homeScreen.next('knock');
  v.sarah.send({ type: 'end', reason: 'no_connection' });
  assert.equal((await v.homeScreen.next('ended')).reason, 'ended');
  assert.equal((await v.sarah.next('ended')).reason, 'ended');
  v.sarah.send({ type: 'knock' });
  await v.homeScreen.next('knock');
  v.homeScreen.send({ type: 'end', reason: 'no_connection' });
  assert.equal((await v.sarah.next('ended')).reason, 'ended');
  assert.equal((await v.homeScreen.next('ended')).reason, 'ended');
});

test('a visit through the relay leaves nothing in the server’s log', async (t) => {
  const written = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => written.push(args));
  const w = await world(t);
  const v = await w.relayedVisit();
  v.sarah.send({ type: 'signal', data: { sdp: { type: 'offer', sdp: 'x' } } });
  await v.homeScreen.next('signal');
  v.sarah.send({ type: 'end', reason: 'no_connection' });
  await v.homeScreen.next('ended');
  await until(() => w.relay.revoked.length === 1, 'revocation');

  // And when the relay cannot be reached.
  w.relay.fail = 'throw';
  v.sarah.send({ type: 'knock' });
  await v.homeScreen.next('knock');
  v.homeScreen.send({ type: 'answer', visitorId: v.sarahId });
  await v.sarah.next('answered');
  v.sarah.send({ type: 'relay' });
  await v.sarah.next('relay', (m) => m.reason === 'unavailable');
  await w.req('/api/organize/relay-test', { token: v.organizerToken, method: 'POST' });
  await w.close();
  assert.deepEqual(written, []);
});

// The switchboard on its own, with pretend sockets: the order in which
// messages are sent, and a clock the test moves by hand.
function switchboard({ relay = fakeRelay(), now } = {}) {
  const store = createStore(':memory:');
  const { onConnection } = createApp({ store, setupPassword: '', env: {}, relay, ...(now ? { now } : {}) });
  const sent = [];      // [who, message] in the order the server sent them
  const join = (who, role, token) => {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.send = (raw) => sent.push([who, JSON.parse(raw)]);
    ws.close = () => { if (ws.readyState === 1) { ws.readyState = 3; ws.emit('close'); } };
    onConnection(ws);
    const say = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
    say({ type: 'hello', role, token, timeZone: 'UTC' });
    return { say, close: ws.close };
  };
  const { home, homeToken } = store.createHome({ personName: 'Mary', hours: { start: '00:00', end: '00:00' } });
  const { visitor, token } = store.addVisitor(home, { name: 'Sarah' });
  store.updateVisitor(home, visitor.id, { approved: true });
  const homeScreen = join('home', 'home', homeToken);
  const sarah = join('visitor', 'visitor', token);
  sarah.say({ type: 'knock' });
  homeScreen.say({ type: 'answer', visitorId: visitor.id });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const relays = () => sent.filter(([, m]) => m.type === 'relay');
  return { relay, sent, relays, homeScreen, sarah, settle };
}

test('relay: the home screen is told first, then the visitor', async () => {
  for (const asker of ['sarah', 'homeScreen']) {
    const s = switchboard();
    s[asker].say({ type: 'relay' });
    await s.settle();
    assert.deepEqual(s.relays().map(([who]) => who), ['home', 'visitor'], `asked by ${asker}`);
    assert.deepEqual(s.relays()[0][1], s.relays()[1][1]);
    assert.equal(s.relays()[0][1].iceServers[0].username, 'relay-user-1');
    s.sarah.close();
    await s.settle();
    assert.deepEqual(s.relay.revoked, ['relay-user-1']);
  }
});

test('relay: a long visit gets fresh credentials, a few times at most', async () => {
  let clock = 1_000_000;
  const s = switchboard({ relay: fakeRelay({ ttl: 3600 }), now: () => clock });
  const ask = async (who) => { s[who].say({ type: 'relay' }); await s.settle(); return s.relays().at(-1)[1]; };

  assert.equal((await ask('sarah')).iceServers[0].username, 'relay-user-1');
  // Still in the first half of their life: the same ones again.
  clock += 1799 * 1000;
  assert.equal((await ask('sarah')).iceServers[0].username, 'relay-user-1');
  assert.equal(s.relay.asked.length, 1);

  // Past half their life: new ones, to both devices, home screen first.
  clock += 2 * 1000;
  const before = s.relays().length;
  assert.equal((await ask('sarah')).iceServers[0].username, 'relay-user-2');
  assert.deepEqual(s.relays().slice(before).map(([who, m]) => [who, m.iceServers[0].username, m.ttl]), [['home', 'relay-user-2', 3600], ['visitor', 'relay-user-2', 3600]]);
  // The old ones are kept working until the visit ends: the visit may still be using them.
  assert.deepEqual(s.relay.revoked, []);

  clock += 1801 * 1000;
  assert.equal((await ask('homeScreen')).iceServers[0].username, 'relay-user-3');
  clock += 1801 * 1000;
  assert.equal((await ask('sarah')).iceServers[0].username, 'relay-user-4');
  // A fifth time in one visit is refused, to the asker alone, without asking the relay service.
  clock += 1801 * 1000;
  const count = s.relays().length;
  assert.deepEqual(await ask('sarah'), { type: 'relay', iceServers: null, reason: 'unavailable' });
  assert.deepEqual(s.relays().slice(count).map(([who]) => who), ['visitor']);
  assert.equal(s.relay.asked.length, 4);

  // When the visit ends, all of them stop working.
  s.homeScreen.say({ type: 'end' });
  await s.settle();
  assert.deepEqual(s.relay.revoked, ['relay-user-1', 'relay-user-2', 'relay-user-3', 'relay-user-4']);
});

test('relay: failed attempts count towards the limit too', async () => {
  const s = switchboard();
  s.relay.fail = 'timeout';
  for (let i = 0; i < 6; i += 1) { s.sarah.say({ type: 'relay' }); await s.settle(); }
  assert.equal(s.relay.asked.length, 4);
  assert.equal(s.relays().length, 6);
  assert.ok(s.relays().every(([who, m]) => who === 'visitor' && m.iceServers === null && m.reason === 'unavailable'));
});

// ---------------------------------------------------------------------------
// The new address
// ---------------------------------------------------------------------------

const NEW_ADDRESS = 'https://bethere.gladspring.org';

// One request with headers of our own choosing, Host included, that follows
// no redirect.
function raw(server, pathname, headers = {}) {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    request.on('error', reject);
    request.end();
  });
}

// What a server started with these options says its new address is.
async function addressWith(options) {
  const server = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '', env: {}, relay: fakeRelay(), ...options });
  try {
    const res = await reqOn(server)('/api/config');
    assert.equal(res.status, 200);
    // What pages already open rely on is still there, whatever the address.
    assert.deepEqual(res.body.iceServers, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
    assert.equal(res.body.dropInNoticeSeconds, 8);
    assert.deepEqual(Object.keys(res.body).sort(), ['canonicalOrigin', 'dropInNoticeSeconds', 'iceServers']);
    assert.equal(server.canonicalOrigin, res.body.canonicalOrigin);
    return { origin: res.body.canonicalOrigin, ignored: server.canonicalIgnored, text: res.text };
  } finally {
    await server.close();
  }
}

test('the new address: there is none until it is switched on', async () => {
  assert.equal((await req('/api/config')).body.canonicalOrigin, null);
  assert.deepEqual(await addressWith({}), { origin: null, ignored: false, text: JSON.stringify({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], dropInNoticeSeconds: 8, canonicalOrigin: null }) });
  for (const empty of ['', '  ']) {
    const found = await addressWith({ env: { CANONICAL_ORIGIN: empty } });
    assert.equal(found.origin, null);
    assert.equal(found.ignored, false);
  }
});

test('the new address: named when CANONICAL_ORIGIN is the one built into the code', async () => {
  const found = await addressWith({ env: { CANONICAL_ORIGIN: NEW_ADDRESS } });
  assert.equal(found.origin, NEW_ADDRESS);
  assert.equal(found.ignored, false);
  // A stray space or line end from pasting it into the host's settings is forgiven.
  assert.equal((await addressWith({ env: { CANONICAL_ORIGIN: ` ${NEW_ADDRESS}\n` } })).origin, NEW_ADDRESS);
});

test('the new address: any other value is ignored, look-alikes included', async () => {
  const others = [
    'https://bethere.gladspring.org.evil.example',
    'http://bethere.gladspring.org',
    'https://bethere.gladspring.org/',
    'https://bethere.gladspring.org/visit',
    'https://bethere.gladspring.org/#x',
    'https://bethere.gladspring.org:8443',
    'https://BeThere.gladspring.org',
    'https://bethere.gladspring.org@evil.example',
    'https://evil.example/?https://bethere.gladspring.org',
    'bethere.gladspring.org',
    'https://be-there-gp50.onrender.com',
    'https://evil.example',
    'http://127.0.0.1:3000',
  ];
  for (const value of others) {
    const found = await addressWith({ env: { CANONICAL_ORIGIN: value } });
    assert.equal(found.origin, null, value);
    assert.equal(found.ignored, true, value);
    assert.doesNotMatch(found.text, /evil|8443|onrender|127\.0\.0\.1/, 'the value is not passed on to pages');
  }
  // The list is in the code. Nothing in the settings can add to it.
  const local = 'http://127.0.0.1:3000';
  const tried = await addressWith({ env: { CANONICAL_ORIGIN: local, CANONICAL_ALLOW: local, CANONICAL_ORIGINS: local, CANONICAL_ALLOW_LIST: JSON.stringify([local]) } });
  assert.equal(tried.origin, null);
  assert.equal(tried.ignored, true);
});

test('the new address: a test may use an address on this machine, with a list of its own', async () => {
  const local = 'http://127.0.0.1:45678';
  assert.equal((await addressWith({ canonicalOrigin: local, canonicalAllow: [local] })).origin, local);
  // Without its own list, the built-in one applies.
  assert.deepEqual({ ...(await addressWith({ canonicalOrigin: local })), text: '' }, { origin: null, ignored: true, text: '' });
  assert.equal((await addressWith({ canonicalOrigin: NEW_ADDRESS })).origin, NEW_ADDRESS);
  // The list alone switches nothing on.
  assert.equal((await addressWith({ canonicalAllow: [local] })).origin, null);
  // A look-alike of the local one is still ignored.
  assert.equal((await addressWith({ canonicalOrigin: 'http://127.0.0.1:45679', canonicalAllow: [local] })).origin, null);
});

test('both addresses are served alike: 200 for either Host, and never a redirect', async (t) => {
  // With the new address switched on, and with it off.
  for (const env of [{ CANONICAL_ORIGIN: NEW_ADDRESS }, {}]) {
    const server = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '', env, relay: fakeRelay() });
    t.after(() => server.close());
    const { port } = new URL(server.url);
    const hosts = [
      { Host: 'be-there-gp50.onrender.com' },
      { Host: 'bethere.gladspring.org' },
      // As the host's proxy passes requests on.
      { Host: 'be-there-gp50.onrender.com', 'X-Forwarded-Host': 'be-there-gp50.onrender.com', 'X-Forwarded-Proto': 'https' },
      { Host: 'bethere.gladspring.org', 'X-Forwarded-Host': 'bethere.gladspring.org', 'X-Forwarded-Proto': 'https' },
      { Host: `127.0.0.1:${port}`, 'X-Forwarded-Host': 'bethere.gladspring.org', 'X-Forwarded-Proto': 'http' },
      { Host: 'some-other-name.example' },
    ];
    const paths = ['/healthz', '/', '/home', '/visit', '/organize', '/setup', '/visit?relay=1', '/api/config', '/api/setup-info',
      '/js/moved.js', '/js/photo.js', '/js/common.js', '/js/home.js', '/js/visit.js', '/js/organize.js', '/js/setup.js', '/js/peer.js', '/css/style.css', '/favicon.svg'];
    for (const pathname of paths) {
      let first = null;
      for (const headers of hosts) {
        const res = await raw(server, pathname, headers);
        const where = `${pathname} as ${headers.Host}`;
        assert.equal(res.status, 200, where);
        assert.equal(res.headers.location, undefined, where);
        first ??= res.text;
        assert.equal(res.text, first, `${where}: the same answer at every address`);
      }
    }
    // What does not exist is a plain 404 at either address, not a redirect.
    for (const headers of hosts) {
      const missing = await raw(server, '/no-such-page', headers);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.location, undefined);
    }
  }
});

test('links, visits and the live connection work the same through either address', async (t) => {
  const OLD = 'be-there-gp50.onrender.com';
  const NEW = 'bethere.gladspring.org';
  // With the new address switched on, as it is once deployed, and with it off.
  // Switched on, it is still only something pages are told: the server turns
  // nobody away at /ws for the name they came by, or for the page they came from.
  for (const env of [{ CANONICAL_ORIGIN: NEW_ADDRESS }, {}]) {
    const mode = env.CANONICAL_ORIGIN ? 'new address on' : 'new address off';
    const w = await world(t, { env });
    assert.equal(w.server.canonicalOrigin, env.CANONICAL_ORIGIN || null);
    const { home, homeToken, organizerToken } = w.store.createHome({ personName: 'Mary', hours: { start: '00:00', end: '00:00' } });
    const { visitor, token } = w.store.addVisitor(home, { name: 'Sarah' });
    w.store.updateVisitor(home, visitor.id, { approved: true });
    for (const Host of [OLD, NEW]) {
      const organize = await raw(w.server, '/api/organize', { Host, Authorization: `Bearer ${organizerToken}` });
      assert.equal(organize.status, 200, `${Host}, ${mode}`);
      assert.equal(JSON.parse(organize.text).home.personName, 'Mary');
      assert.equal((await raw(w.server, '/api/visit', { Host, Authorization: `Bearer ${token}` })).status, 200, `${Host}, ${mode}`);
    }

    // A live connection to /ws by either name, as a browser at either address
    // makes it.
    const join = (Host, role, secret, from = Host) => {
      const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/ws', { headers: { Host }, origin: `https://${from}` });
      const seen = [];
      let closedWith = null;
      ws.on('message', (data) => seen.push(JSON.parse(data.toString())));
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role, token: secret, timeZone: 'UTC' })));
      ws.on('close', (code) => { closedWith = code; });
      ws.on('error', () => { closedWith ??= 'refused'; });
      t.after(() => ws.terminate());
      const got = (type) => until(() => seen.some((m) => m.type === type) || closedWith !== null, `${type} at ${Host}, ${mode}`).then(() => {
        assert.equal(closedWith, null, `${role} at ${Host} was turned away, ${mode}`);
        return seen.find((m) => m.type === type);
      });
      return { ws, seen, got, send: (m) => ws.send(JSON.stringify(m)) };
    };
    // Each kind of page is let in at each address, whichever of the two the
    // page itself was loaded from...
    for (const Host of [OLD, NEW]) {
      for (const from of [OLD, NEW]) {
        const asVisitor = join(Host, 'visitor', token, from);
        await asVisitor.got('status');
        asVisitor.ws.terminate();
      }
    }
    // ...the home screen too, whichever of the two it is at.
    const first = join(NEW, 'home', homeToken);
    await first.got('state');
    first.ws.terminate();
    await until(() => first.ws.readyState === WebSocket.CLOSED, 'the first home screen to go');

    // The home screen stays at the old address; the visitor is at the new
    // one. They still meet: it is one server.
    const homeScreen = join(OLD, 'home', homeToken);
    await homeScreen.got('state');
    const sarah = join(NEW, 'visitor', token);
    await until(() => sarah.seen.some((m) => m.type === 'status' && m.view.canVisit), `Sarah to be able to visit, ${mode}`);
    sarah.send({ type: 'knock' });
    assert.equal((await homeScreen.got('knock')).name, 'Sarah');
    homeScreen.send({ type: 'answer', visitorId: visitor.id });
    await sarah.got('answered');
    sarah.send({ type: 'signal', data: { hello: 1 } });
    assert.deepEqual((await homeScreen.got('signal')).data, { hello: 1 });
    homeScreen.send({ type: 'end' });
    assert.equal((await sarah.got('ended')).reason, 'ended');
    await w.close();
  }
});

test('a page checking the new address opens /ws and says nothing: nothing happens, nothing is logged', async (t) => {
  const written = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => written.push(args));
  const w = await world(t, { env: { CANONICAL_ORIGIN: NEW_ADDRESS } });
  const h = await w.household();
  // The check a page at the old address makes before it moves: from another
  // address, open, wait, close. No hello, no link.
  for (let i = 0; i < 3; i += 1) {
    const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/ws', { headers: { Host: 'bethere.gladspring.org' }, origin: 'https://be-there-gp50.onrender.com' });
    const received = [];
    ws.on('message', (data) => received.push(data.toString()));
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
    assert.deepEqual(received, [], 'the server tells it nothing');
  }
  // The home and its visitor heard nothing of it, and visits go on as before.
  h.sarah.send({ type: 'knock' });
  await h.homeScreen.next('knock');
  await h.sarah.next('ringing');
  assert.deepEqual(h.homeScreen.seen.map((m) => m.type).filter((type) => type !== 'state'), ['knock']);
  assert.deepEqual(h.sarah.seen.map((m) => m.type).filter((type) => type !== 'status'), ['ringing']);
  await w.close();
  assert.deepEqual(written, []);
});

test('over HTTPS, browsers are told to keep to HTTPS at that address only', async () => {
  for (const Host of ['be-there-gp50.onrender.com', 'bethere.gladspring.org']) {
    for (const pathname of ['/healthz', '/visit', '/api/config', '/js/moved.js']) {
      const secure = await raw(srv, pathname, { Host, 'X-Forwarded-Proto': 'https' });
      assert.equal(secure.status, 200);
      // Six months, this address alone: no includeSubDomains (gladspring.org has other sites) and no preload.
      assert.equal(secure.headers['strict-transport-security'], 'max-age=15552000', `${Host}${pathname}`);
      const plain = await raw(srv, pathname, { Host });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers['strict-transport-security'], undefined, `${Host}${pathname} over plain http`);
    }
  }
});

// A port that is free right now, for a server started as its own program.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// Starts the real server as the host does (`node server.js`) and gives back
// everything it printed while starting. Its data file would go in a folder of
// its own outside the repository, and it is given none of this machine's
// settings.
async function startupOutput(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-there-test-'));
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
      cwd: dir,
      env: { PATH: process.env.PATH, PORT: String(await freePort()), DATA_FILE: path.join(dir, 'db.json'), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stopping = false;
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const stop = () => { if (!stopping) { stopping = true; child.kill('SIGTERM'); } };
    const giveUp = setTimeout(() => child.kill('SIGKILL'), 10_000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      // "Relay: …" is printed before the lines about the address; a moment
      // later everything it says at startup has been said.
      stream.on('data', (text) => { out += text; if (/^Relay:/m.test(out)) setTimeout(stop, 200); });
    }
    await exited;
    clearTimeout(giveUp);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('starting the server: one plain line about the new address, and a wrong value is never printed', async () => {
  const off = await startupOutput({});
  assert.match(off, /^Be There on http:\/\/localhost:\d+/m);
  assert.doesNotMatch(off, /address|CANONICAL/i, 'nothing is said when it is not set');

  const on = await startupOutput({ CANONICAL_ORIGIN: NEW_ADDRESS });
  assert.match(on, /^New address: https:\/\/bethere\.gladspring\.org /m);
  assert.doesNotMatch(on, /ignored/);

  const wrong = await startupOutput({ CANONICAL_ORIGIN: 'https://bethere.gladspring.org.evil.example/secret-path' });
  assert.match(wrong, /^CANONICAL_ORIGIN is set to an address this version does not know, so it is ignored\. Nothing moves\.$/m);
  assert.equal(wrong.match(/CANONICAL_ORIGIN/g).length, 1, 'said once');
  assert.doesNotMatch(wrong, /evil|secret-path|New address/);
});

// ---------------------------------------------------------------------------
// Photos of visitors
// ---------------------------------------------------------------------------

const picture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
// What the organizer's page sends (a browser's canvas made it), and another.
const CANVAS = picture('canvas-384.jpg');
const GREY = picture('grey-256.jpg');
const KEPT = acceptPhoto(CANVAS);
const KEPT_GREY = acceptPhoto(GREY);
const REFUSED = 'That picture couldn’t be used. Please try another photo.';
const organizePhoto = (id) => `/api/organize/visitors/${id}/photo`;
const homePhoto = (id) => `/api/home/visitors/${id}/photo`;

// One request whose body and answer are bytes, as a photo is.
const bytesOn = (server) => async (pathname, { token, method = 'GET', body, type = body ? 'image/jpeg' : null, headers = {} } = {}) => {
  const res = await fetch(server.url + pathname, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(type ? { 'Content-Type': type } : {}), ...headers },
    body,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* a picture, not JSON */ }
  return { status: res.status, headers: res.headers, bytes, body: json };
};
// A world whose answers can be read as bytes, with a home (Sarah and Tom)
// and a second home (Ann) beside it.
async function photoWorld(t, options) {
  const w = await world(t, options);
  w.bytes = bytesOn(w.server);
  w.put = (id, token, body = CANVAS, more = {}) => w.bytes(organizePhoto(id), { method: 'PUT', token, body, ...more });
  const mary = await w.household(['Sarah', 'Tom']);
  const joe = await w.household(['Ann']);
  const tagOf = (h, n = 0) => w.store.getHome(h.home.id).visitors.filter((v) => !v.removed)[n]?.photo?.etag ?? null;
  return { w, mary, joe, sarahId: mary.people[0].id, tomId: mary.people[1].id, annId: joe.people[0].id, tagOf };
}

test('photos: only the organizer’s link can add, change or remove one', async (t) => {
  const { w, mary, joe, sarahId, tomId, annId, tagOf } = await photoWorld(t);
  const strangers = { 'no link': undefined, 'a made-up link': 'not-a-real-token', 'the home screen’s link': mary.homeToken, 'the visitor’s own link': mary.people[0].token, 'another visitor’s link': mary.people[1].token, 'another home’s screen': joe.homeToken };
  const nobody = async (when) => {
    for (const [who, token] of Object.entries(strangers)) {
      assert.equal((await w.put(sarahId, token)).status, 401, `${who} adding, ${when}`);
      assert.equal((await w.put(sarahId, token, GREY)).status, 401, `${who} changing, ${when}`);
      assert.equal((await w.bytes(organizePhoto(sarahId), { method: 'DELETE', token })).status, 401, `${who} removing, ${when}`);
      const read = await w.bytes(organizePhoto(sarahId), { token });
      assert.equal(read.status, 401, `${who} reading through the organizer’s route, ${when}`);
      assert.ok(!read.bytes.includes(JFIF_START));
    }
    // An organizer of another home has a working link, but not for this visitor.
    for (const method of ['PUT', 'DELETE', 'GET']) {
      const res = await w.bytes(organizePhoto(sarahId), { method, token: joe.organizerToken, ...(method === 'PUT' ? { body: GREY } : {}) });
      assert.equal(res.status, 404, `another home’s organizer, ${method}, ${when}`);
      assert.deepEqual(res.body, { error: 'No such visitor.' });
    }
  };

  await nobody('before there is a photo');
  assert.equal(tagOf(mary), null);
  assert.equal(w.store.photoBytes(mary.home, sarahId), null);

  // The organizer adds one.
  const added = await w.put(sarahId, mary.organizerToken);
  assert.equal(added.status, 200);
  assert.deepEqual(added.body, { photo: KEPT.etag });
  assert.equal(tagOf(mary), KEPT.etag);
  assert.ok(w.store.photoBytes(mary.home, sarahId).equals(KEPT.bytes), 'what is kept is the rebuilt picture');
  assert.equal(tagOf(mary, 1), null, 'only that visitor’s');
  assert.equal(tagOf(joe), null);

  await nobody('once there is a photo');
  assert.equal(tagOf(mary), KEPT.etag, 'nobody else changed or removed it');
  assert.ok(w.store.photoBytes(mary.home, sarahId).equals(KEPT.bytes));

  // The organizer changes it, then removes it.
  const changed = await w.put(sarahId, mary.organizerToken, GREY);
  assert.deepEqual([changed.status, changed.body], [200, { photo: KEPT_GREY.etag }]);
  assert.notEqual(KEPT_GREY.etag, KEPT.etag);
  assert.ok(w.store.photoBytes(mary.home, sarahId).equals(KEPT_GREY.bytes));
  const removed = await w.bytes(organizePhoto(sarahId), { method: 'DELETE', token: mary.organizerToken });
  assert.deepEqual([removed.status, removed.body], [200, { ok: true }]);
  assert.equal(tagOf(mary), null);
  assert.equal(w.store.photoBytes(mary.home, sarahId), null);
  assert.equal((await w.bytes(organizePhoto(sarahId), { method: 'DELETE', token: mary.organizerToken })).status, 200, 'removing what is not there is fine');

  // Not for someone who is not a visitor, or who has been removed.
  for (const id of ['no-such-visitor', annId, '..%2f..%2fdb.json', '%00', 'a'.repeat(300)]) {
    const res = await w.put(id, mary.organizerToken);
    assert.deepEqual([res.status, res.body], [404, { error: 'No such visitor.' }], id);
  }
  // A path that climbs is not a photo route at all.
  for (const id of ['..', '%2e%2e', '.']) assert.equal((await w.put(id, mary.organizerToken)).status, 404, id);
  assert.equal(tagOf(joe), null);
  assert.equal((await w.req(`/api/organize/visitors/${tomId}`, { token: mary.organizerToken, method: 'DELETE' })).status, 200);
  assert.equal((await w.put(tomId, mary.organizerToken)).status, 404);
  assert.equal(w.store.photoBytes(mary.home, tomId), null);
});

test('photos: the home screen can fetch those of its own visitors, and nobody else’s', async (t) => {
  const { w, mary, joe, sarahId, tomId, annId } = await photoWorld(t);
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  assert.equal((await w.put(annId, joe.organizerToken, GREY)).status, 200);

  // Its own visitor's photo, with its own link's secret.
  const own = await w.bytes(homePhoto(sarahId), { token: mary.homeToken });
  assert.equal(own.status, 200);
  assert.ok(own.bytes.equals(KEPT.bytes));
  // The organizer sees the same picture through their own route.
  const viaOrganizer = await w.bytes(organizePhoto(sarahId), { token: mary.organizerToken });
  assert.equal(viaOrganizer.status, 200);
  assert.ok(viaOrganizer.bytes.equals(KEPT.bytes));

  // No link, or a link that is not a home screen's: turned away.
  const notHome = { 'no link': undefined, 'a made-up link': 'not-a-real-token', 'the organizer’s link': mary.organizerToken, 'the visitor’s own link': mary.people[0].token, 'another visitor’s link': mary.people[1].token };
  for (const [who, token] of Object.entries(notHome)) {
    const res = await w.bytes(homePhoto(sarahId), { token });
    assert.equal(res.status, 401, who);
    assert.match(res.body.error, /home screen link/);
    assert.ok(!res.bytes.includes(JFIF_START), who);
  }
  // Knowing the ids, or even the photo's tag, is not having the link. And the
  // secret counts only where a link secret may travel: never in the address.
  const address = `${homePhoto(sarahId)}?home=${mary.home.id}&token=${mary.homeToken}&access_token=${mary.homeToken}&authorization=Bearer%20${mary.homeToken}`;
  assert.equal((await w.bytes(address)).status, 401, 'the secret in the address');
  for (const guess of [mary.home.id, sarahId, KEPT.etag, `${mary.home.id}:${sarahId}`]) {
    assert.equal((await w.bytes(`${homePhoto(sarahId)}?home=${mary.home.id}`, { token: guess })).status, 401, 'an id in place of the secret');
    assert.equal((await w.bytes(`${organizePhoto(sarahId)}?home=${mary.home.id}`, { token: guess })).status, 401);
  }
  assert.equal((await w.bytes(`${organizePhoto(sarahId)}?token=${mary.organizerToken}`)).status, 401);
  assert.equal((await w.bytes(homePhoto(sarahId), { headers: { Authorization: mary.homeToken } })).status, 401, 'the secret without “Bearer”');
  assert.equal((await w.bytes(homePhoto(sarahId), { headers: { Cookie: `token=${mary.homeToken}`, 'X-Token': mary.homeToken } })).status, 401);
  // Another home's visitor is simply not found, as is anyone without a photo.
  const notFound = { 'another home’s visitor': [annId, mary.homeToken], 'our visitor, asked for by another home': [sarahId, joe.homeToken], 'a visitor with no photo': [tomId, mary.homeToken], 'nobody': ['no-such-visitor', mary.homeToken], 'a path that climbs': ['..%2f..%2fdb.json', mary.homeToken] };
  for (const [what, [id, token]] of Object.entries(notFound)) {
    const res = await w.bytes(homePhoto(id), { token });
    assert.deepEqual([res.status, res.body], [404, { error: 'No photo.' }], what);
  }
  assert.ok((await w.bytes(homePhoto(annId), { token: joe.homeToken })).bytes.equals(KEPT_GREY.bytes));

  // A visitor's link opens no photo route at all, not even for their own picture.
  const visitorToken = mary.people[0].token;
  for (const pathname of ['/api/visit/photo', `/api/visit/visitors/${sarahId}/photo`, `/api/visitors/${sarahId}/photo`, `/api/visit/${sarahId}/photo`, '/api/photo']) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await w.bytes(pathname, { method, token: visitorToken, ...(method === 'PUT' ? { body: CANVAS } : {}) });
      assert.equal(res.status, 404, `${method} ${pathname}`);
      assert.ok(!res.bytes.includes(JFIF_START));
    }
  }
  // Only reading is offered to the home screen.
  for (const method of ['PUT', 'DELETE', 'POST']) {
    assert.equal((await w.bytes(homePhoto(sarahId), { method, token: mary.homeToken, ...(method === 'DELETE' ? {} : { body: GREY }) })).status, 404, method);
  }
  assert.ok(w.store.photoBytes(mary.home, sarahId).equals(KEPT.bytes));

  // A replaced home screen link stops working for photos too; the new one works.
  const { homeToken: newToken } = (await w.req('/api/organize/home-link', { token: mary.organizerToken, method: 'POST' })).body;
  assert.equal((await w.bytes(homePhoto(sarahId), { token: mary.homeToken })).status, 401);
  assert.equal((await w.bytes(homePhoto(sarahId), { token: newToken })).status, 200);

  // The visitor is removed: their photo cannot be fetched any more.
  assert.equal((await w.req(`/api/organize/visitors/${sarahId}`, { token: mary.organizerToken, method: 'DELETE' })).status, 200);
  assert.equal((await w.bytes(homePhoto(sarahId), { token: newToken })).status, 404);
  assert.equal((await w.bytes(organizePhoto(sarahId), { token: mary.organizerToken })).status, 404);
});

test('photos: a photo is sent with exactly these headers, and “not changed” when the tag matches', async (t) => {
  const { w, mary, sarahId } = await photoWorld(t);
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  const routes = { 'to the home screen': [homePhoto(sarahId), mary.homeToken], 'to the organizer': [organizePhoto(sarahId), mary.organizerToken] };
  for (const [name, [pathname, token]] of Object.entries(routes)) {
    const res = await w.bytes(pathname, { token });
    assert.equal(res.status, 200, name);
    const got = Object.fromEntries(['content-type', 'x-content-type-options', 'content-disposition', 'content-security-policy', 'cross-origin-resource-policy', 'cache-control', 'vary', 'etag', 'content-length'].map((h) => [h, res.headers.get(h)]));
    assert.deepEqual(got, {
      'content-type': 'image/jpeg',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'attachment; filename="photo.jpg"',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, no-cache',
      vary: 'Authorization',
      etag: `"${KEPT.etag}"`,
      'content-length': String(KEPT.bytes.length),
    }, name);
    // What every answer from this server carries is still there.
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.bytes.equals(KEPT.bytes), name);
    assert.ok(res.bytes.subarray(0, 20).equals(JFIF_START));

    // The same tag: 304, with no picture.
    for (const tag of [`"${KEPT.etag}"`, `W/"${KEPT.etag}"`, `"something-else", "${KEPT.etag}"`, '*']) {
      const same = await w.bytes(pathname, { token, headers: { 'If-None-Match': tag } });
      assert.equal(same.status, 304, `${name}, ${tag}`);
      assert.equal(same.bytes.length, 0);
      assert.deepEqual([same.headers.get('etag'), same.headers.get('cache-control'), same.headers.get('vary')], [`"${KEPT.etag}"`, 'private, no-cache', 'Authorization']);
    }
    // Another tag, or the tag without its quotes: the picture.
    for (const tag of ['"something-else"', KEPT.etag, `"${KEPT_GREY.etag}"`, '']) {
      const other = await w.bytes(pathname, { token, headers: { 'If-None-Match': tag } });
      assert.equal(other.status, 200, `${name}, ${tag}`);
      assert.ok(other.bytes.equals(KEPT.bytes));
    }
    // Knowing the tag does not get anyone past the door.
    for (const wrong of [undefined, 'not-a-real-token', mary.people[0].token]) {
      assert.equal((await w.bytes(pathname, { token: wrong, headers: { 'If-None-Match': `"${KEPT.etag}"` } })).status, 401, name);
    }
  }
  // After a change the old tag no longer matches.
  assert.equal((await w.put(sarahId, mary.organizerToken, GREY)).status, 200);
  const after = await w.bytes(homePhoto(sarahId), { token: mary.homeToken, headers: { 'If-None-Match': `"${KEPT.etag}"` } });
  assert.equal(after.status, 200);
  assert.equal(after.headers.get('etag'), `"${KEPT_GREY.etag}"`);
  assert.ok(after.bytes.equals(KEPT_GREY.bytes));
  // The answers that are not a picture do not pretend to be one.
  const missing = await w.bytes(homePhoto('no-such-visitor'), { token: mary.homeToken });
  assert.match(missing.headers.get('content-type'), /^application\/json/);
  assert.equal(missing.headers.get('etag') === `"${KEPT_GREY.etag}"`, false);
});

test('photos: sent as anything but a JPEG picture is 415, and too large is 413', async (t) => {
  const { w, mary, sarahId, tagOf } = await photoWorld(t);
  const send = (more) => w.put(sarahId, mary.organizerToken, CANVAS, more);
  for (const type of ['image/png', 'application/octet-stream', 'text/plain', 'multipart/form-data; boundary=x', '']) {
    const res = await send({ type });
    assert.equal(res.status, 415, `sent as “${type}”`);
    assert.deepEqual(res.body, { error: 'A photo must be sent as a JPEG picture.' });
  }
  // JSON is read by the reader every route shares: still not a photo.
  assert.equal((await w.put(sarahId, mary.organizerToken, JSON.stringify({ photo: CANVAS.toString('base64') }), { type: 'application/json' })).status, 415);
  // A compressed body is never unpacked (50 MB of nothing packs into a few KB).
  const packed = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024));
  assert.ok(packed.length < 100 * 1024);
  const gz = await w.put(sarahId, mary.organizerToken, packed, { headers: { 'Content-Encoding': 'gzip' } });
  assert.deepEqual([gz.status, gz.body], [415, { error: 'A photo must be sent as a JPEG picture.' }]);
  assert.equal(tagOf(mary), null, 'none of those was kept');
  // "image/jpeg" with a parameter after it is still a JPEG.
  assert.equal((await send({ type: 'image/jpeg; charset=binary' })).status, 200);
  assert.ok(w.store.photoBytes(mary.home, sarahId).equals(KEPT.bytes));

  // One byte over 200 KB, and a good deal over.
  const sizes = await photoWorld(t);
  const sendSized = (length) => sizes.w.put(sizes.sarahId, sizes.mary.organizerToken, Buffer.concat([CANVAS, Buffer.alloc(length - CANVAS.length)]));
  for (const length of [200 * 1024 + 1, 500 * 1024]) {
    const res = await sendSized(length);
    assert.equal(res.status, 413, `${length} bytes`);
    assert.deepEqual(res.body, { error: 'That photo is too large. Please try another photo.' });
  }
  assert.equal(sizes.tagOf(sizes.mary), null);
  // Exactly 200 KB is let in (and what came after the picture is dropped).
  const full = await sendSized(200 * 1024);
  assert.deepEqual([full.status, full.body], [200, { photo: KEPT.etag }]);
  assert.ok(sizes.w.store.photoBytes(sizes.mary.home, sizes.sarahId).equals(KEPT.bytes));
});

test('photos: a picture that is not what we accept is refused in plain words, and nothing changes', async (t) => {
  const { w, mary, sarahId, tagOf } = await photoWorld(t);
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  const base = picture('baseline-256.jpg');
  const sof = base.indexOf(Buffer.from([0xff, 0xc0, 0x00, 0x11]));
  const adobe = Buffer.concat([base.subarray(0, 2), Buffer.from([0xff, 0xee, 0x00, 0x0e]), Buffer.from('Adobe\0d\0\0\0\0\x01', 'latin1'), base.subarray(2)]);
  const bad = {
    not_jpeg: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    not_square: picture('sideways-320x240.jpg'),
    not_upright: picture('orientation-6-256.jpg'),
    truncated: base.subarray(0, base.length - 2),
    too_many_pixels: (() => { const b = Buffer.from(base); b.writeUInt16BE(513, sof + 5); b.writeUInt16BE(513, sof + 7); return b; })(),
    too_small: (() => { const b = Buffer.from(base); b.writeUInt16BE(95, sof + 5); b.writeUInt16BE(95, sof + 7); return b; })(),
    adobe_marker: adobe,
    second_image: Buffer.concat([base.subarray(0, 2), base]),
  };
  for (const [reason, body] of Object.entries(bad)) {
    const res = await w.put(sarahId, mary.organizerToken, body);
    assert.equal(res.status, 400, reason);
    assert.deepEqual(res.body, { error: REFUSED, reason });
    assert.match(res.headers.get('content-type'), /^application\/json/);
  }
  // The photo that was there is still there, untouched.
  assert.equal(tagOf(mary), KEPT.etag);
  assert.ok((await w.bytes(homePhoto(sarahId), { token: mary.homeToken })).bytes.equals(KEPT.bytes));
});

test('photos: where it was taken, and anything hidden in the file, never reaches the store or the home screen', async (t) => {
  const { w, mary, sarahId } = await photoWorld(t);
  const src = picture('metadata-256.jpg');
  const dirty = Buffer.concat([src, Buffer.from('<script>alert(1)</script>PK\x03\x04 SENTINEL-TAIL')]);
  for (const word of ['SENTINEL-GPS-METHOD', 'SENTINEL-MAKE', 'SENTINEL-COMMENT', 'SENTINEL-XMP', 'Exif', 'ICC_PROFILE', '<script>']) assert.ok(dirty.includes(word));
  const res = await w.put(sarahId, mary.organizerToken, dirty);
  assert.equal(res.status, 200);
  for (const kept of [w.store.photoBytes(mary.home, sarahId), (await w.bytes(homePhoto(sarahId), { token: mary.homeToken })).bytes]) {
    for (const word of ['SENTINEL', 'Exif', 'ICC_PROFILE', 'xmpmeta', 'Photoshop', '<script', 'PK\x03\x04', 'Example Road']) assert.ok(!kept.includes(word), `${word} is gone`);
    assert.ok(kept.subarray(0, 20).equals(JFIF_START));
    assert.equal(kept.subarray(-2).toString('hex'), 'ffd9');
    assert.ok(kept.equals(acceptPhoto(picture('baseline-256.jpg')).bytes), 'only the picture is left');
  }
});

test('photos: the home screen and the organizer are told the tag at once; a visitor is never told anything', async (t) => {
  const { w, mary, joe, sarahId, tomId } = await photoWorld(t);
  const { homeScreen, sarah } = mary;
  const tom = mary.people[1].socket;
  const tags = (msg) => msg.home.visitors.map((v) => v.photo);
  assert.deepEqual(tags((await w.req('/api/organize', { token: mary.organizerToken })).body), [null, null]);

  // Added: the home screen hears straight away, with nobody having to approve it.
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  assert.deepEqual(tags(await homeScreen.next('state', (m) => m.home.visitors[0]?.photo)), [KEPT.etag, null]);
  assert.deepEqual(tags((await w.req('/api/organize', { token: mary.organizerToken })).body), [KEPT.etag, null]);
  // Changed, for the other visitor too.
  assert.equal((await w.put(sarahId, mary.organizerToken, GREY)).status, 200);
  assert.deepEqual(tags(await homeScreen.next('state', (m) => m.home.visitors[0]?.photo === KEPT_GREY.etag)), [KEPT_GREY.etag, null]);
  assert.equal((await w.put(tomId, mary.organizerToken)).status, 200);
  assert.deepEqual(tags(await homeScreen.next('state', (m) => m.home.visitors[1]?.photo)), [KEPT_GREY.etag, KEPT.etag]);
  // Removed.
  assert.equal((await w.bytes(organizePhoto(sarahId), { method: 'DELETE', token: mary.organizerToken })).status, 200);
  assert.deepEqual(tags(await homeScreen.next('state', (m) => m.home.visitors[1]?.photo && m.home.visitors[0].photo === null)), [null, KEPT.etag]);
  // Removing again changes nothing, so nobody is told again.
  const told = homeScreen.seen.filter((m) => m.type === 'state').length;
  assert.equal((await w.bytes(organizePhoto(sarahId), { method: 'DELETE', token: mary.organizerToken })).status, 200);
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  await homeScreen.next('state', (m) => m.home.visitors[0]?.photo === KEPT.etag);
  assert.equal(homeScreen.seen.filter((m) => m.type === 'state').length, told + 1);
  // The other home hears nothing of it.
  assert.doesNotMatch(JSON.stringify(joe.homeScreen.seen), new RegExp(`${KEPT.etag}|${KEPT_GREY.etag}`));

  // A whole visit, with photos on both visitors: Sarah knocks, is answered, signals, and it ends.
  sarah.send({ type: 'knock' });
  const knock = await homeScreen.next('knock');
  assert.deepEqual(Object.keys(plain(knock)).sort(), ['mode', 'name', 'notice', 'type', 'visitorId'], 'a knock names the visitor; the photo is the one the screen already has');
  homeScreen.send({ type: 'answer', visitorId: sarahId });
  await sarah.next('answered');
  await settled({ homeScreen, sarah });
  homeScreen.send({ type: 'end' });
  await sarah.next('ended');
  await tom.next('status', (m) => m.view.canVisit);

  // Nothing either visitor was ever sent, or can ask for, mentions a photo.
  const tagWords = new RegExp(`photo|etag|${KEPT.etag}|${KEPT_GREY.etag}`, 'i');
  for (const person of mary.people) {
    assert.ok(person.socket.seen.length >= 3);
    assert.doesNotMatch(JSON.stringify(person.socket.seen), tagWords);
    const view = await w.req('/api/visit', { token: person.token });
    assert.equal(view.status, 200);
    assert.doesNotMatch(view.text, tagWords);
    assert.deepEqual(Object.keys(view.body.you).sort(), ['approved', 'mode', 'name']);
  }
  // What is open to anyone says nothing either.
  for (const pathname of ['/api/config', '/api/setup-info', '/healthz']) assert.doesNotMatch((await w.req(pathname)).text, tagWords, pathname);
  // Inviting someone still answers as it did.
  const invited = await w.req('/api/organize/visitors', { token: mary.organizerToken, method: 'POST', body: { name: 'Una' } });
  assert.deepEqual(Object.keys(invited.body.visitor).sort(), ['approved', 'id', 'mode', 'name', 'relation']);
});

test('photos: kept as one small file beside the data file; gone when the photo, the visitor or the home goes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-there-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const photosDir = path.join(dir, 'photos');
  const files = () => (fs.existsSync(photosDir) ? fs.readdirSync(photosDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(photosDir, path.join(e.parentPath, e.name))).sort() : []);
  const { w, mary, joe, sarahId, tomId, annId } = await photoWorld(t, { store: createStore(path.join(dir, 'db.json')) });
  assert.deepEqual(files(), []);

  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  assert.equal((await w.put(tomId, mary.organizerToken, GREY)).status, 200);
  assert.equal((await w.put(annId, joe.organizerToken)).status, 200);
  const fileOf = (h, id) => path.join(h.home.id, `${id}.jpg`);
  assert.deepEqual(files(), [fileOf(mary, sarahId), fileOf(mary, tomId), fileOf(joe, annId)].sort());
  assert.ok(fs.readFileSync(path.join(photosDir, fileOf(mary, sarahId))).equals(KEPT.bytes), 'the file is the rebuilt picture');
  // The data file holds the tags and not the pictures.
  const data = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.match(data, new RegExp(KEPT.etag));
  assert.ok(data.length < 5000);

  // A refused change, and a change: still one file for her.
  assert.equal((await w.put(sarahId, mary.organizerToken, picture('sideways-320x240.jpg'))).status, 400);
  assert.equal((await w.put(sarahId, mary.organizerToken, GREY)).status, 200);
  assert.deepEqual(files().length, 3);
  assert.ok(fs.readFileSync(path.join(photosDir, fileOf(mary, sarahId))).equals(KEPT_GREY.bytes));

  // The photo is removed.
  assert.equal((await w.bytes(organizePhoto(sarahId), { method: 'DELETE', token: mary.organizerToken })).status, 200);
  assert.deepEqual(files(), [fileOf(mary, tomId), fileOf(joe, annId)].sort());
  // The visitor is removed.
  assert.equal((await w.req(`/api/organize/visitors/${tomId}`, { token: mary.organizerToken, method: 'DELETE' })).status, 200);
  assert.deepEqual(files(), [fileOf(joe, annId)]);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'db.json'), 'utf8').split(joe.home.id)[0], /"photo"/, 'no tag is left on the first home’s visitors');
  // The home is deleted: its whole folder goes; the other home's is untouched.
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  assert.equal(fs.existsSync(path.join(photosDir, mary.home.id)), true);
  assert.equal((await w.req('/api/organize/home', { token: mary.organizerToken, method: 'DELETE' })).status, 200);
  assert.equal(fs.existsSync(path.join(photosDir, mary.home.id)), false);
  assert.deepEqual(files(), [fileOf(joe, annId)]);
  assert.equal((await w.bytes(homePhoto(sarahId), { token: mary.homeToken })).status, 401);
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 401);
  assert.ok((await w.bytes(homePhoto(annId), { token: joe.homeToken })).bytes.equals(KEPT.bytes));
  // Nothing else was written in that folder.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['db.json', 'photos']);
});

test('photos: with a store kept in memory, as these tests use, the pictures are in memory too', async (t) => {
  const photos = photosInMemory();
  const { w, mary, sarahId, tomId } = await photoWorld(t, { store: createStore(':memory:', { photos }) });
  assert.equal(photos.size, 0);
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  assert.equal((await w.put(tomId, mary.organizerToken, GREY)).status, 200);
  assert.equal(photos.size, 2);
  assert.ok(photos.get(mary.home.id, sarahId).equals(KEPT.bytes));
  assert.equal((await w.req(`/api/organize/visitors/${sarahId}`, { token: mary.organizerToken, method: 'DELETE' })).status, 200);
  assert.equal(photos.size, 1);
  assert.equal((await w.req('/api/organize/home', { token: mary.organizerToken, method: 'DELETE' })).status, 200);
  assert.equal(photos.size, 0);
});

test('photos: at most 10 uploads a minute from one address', async (t) => {
  const { w, mary, joe, sarahId, annId } = await photoWorld(t);
  const statuses = [];
  for (let i = 0; i < 12; i += 1) statuses.push((await w.put(sarahId, mary.organizerToken, i % 2 ? GREY : CANVAS)).status);
  assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
  // It is by address: another organizer there has to wait as well.
  const waiting = await w.put(annId, joe.organizerToken);
  assert.equal(waiting.status, 429);
  assert.deepEqual(waiting.body, { error: 'Too many requests. Please wait a minute.' });
  // Someone without a working link does not use up the organizer's tries, and reading is not limited.
  const other = await photoWorld(t);
  for (let i = 0; i < 15; i += 1) assert.equal((await other.w.put(other.sarahId, 'not-a-real-token')).status, 401);
  assert.equal((await other.w.put(other.sarahId, other.mary.organizerToken)).status, 200);
  for (let i = 0; i < 15; i += 1) assert.equal((await w.bytes(homePhoto(sarahId), { token: mary.homeToken })).status, 200);
});

test('photos: nothing about an upload or a request is logged, even when it goes wrong', async (t) => {
  const written = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) t.mock.method(console, method, (...args) => written.push(args));
  const { w, mary, sarahId } = await photoWorld(t);
  assert.equal((await w.put(sarahId, mary.organizerToken)).status, 200);
  assert.equal((await w.put(sarahId, mary.organizerToken, picture('sideways-320x240.jpg'))).status, 400);
  assert.equal((await w.put(sarahId, mary.organizerToken, Buffer.concat([CANVAS, Buffer.alloc(250 * 1024)]))).status, 413);
  assert.equal((await w.put(sarahId, mary.organizerToken, CANVAS, { type: 'image/png' })).status, 415);
  assert.equal((await w.put(sarahId, mary.organizerToken, zlib.gzipSync(CANVAS), { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await w.put(sarahId, 'not-a-real-token')).status, 401);
  assert.equal((await w.put('no-such-visitor', mary.organizerToken)).status, 404);
  // JSON that is not JSON, sent to the photo route: answered plainly, not printed.
  const broken = await w.put(sarahId, mary.organizerToken, '{"photo": ', { type: 'application/json' });
  assert.deepEqual([broken.status, broken.body], [400, { error: REFUSED }]);
  const tooMuchJson = await w.put(sarahId, mary.organizerToken, JSON.stringify({ photo: 'x'.repeat(20_000) }), { type: 'application/json' });
  assert.deepEqual([tooMuchJson.status, tooMuchJson.body], [413, { error: 'That photo is too large. Please try another photo.' }]);
  // The same route spelt as the server also accepts it: capitals, and a last "/".
  for (const spelling of [organizePhoto(sarahId).toUpperCase().replace(sarahId.toUpperCase(), sarahId), `${organizePhoto(sarahId)}/`]) {
    const big = await w.bytes(spelling, { method: 'PUT', token: mary.organizerToken, body: Buffer.concat([CANVAS, Buffer.alloc(250 * 1024)]) });
    assert.deepEqual([big.status, big.body], [413, { error: 'That photo is too large. Please try another photo.' }], spelling);
  }
  assert.equal((await w.bytes(homePhoto(sarahId), { token: mary.homeToken })).status, 200);
  assert.equal((await w.bytes(homePhoto(sarahId), { token: mary.homeToken, headers: { 'If-None-Match': `"${KEPT.etag}"` } })).status, 304);
  assert.equal((await w.bytes(homePhoto(sarahId), { token: 'not-a-real-token' })).status, 401);
  assert.equal((await w.bytes(homePhoto('no-such-visitor'), { token: mary.homeToken })).status, 404);
  assert.equal((await w.bytes(organizePhoto(sarahId), { token: mary.organizerToken })).status, 200);
  assert.equal((await w.bytes(organizePhoto(sarahId), { method: 'DELETE', token: mary.organizerToken })).status, 200);
  await w.close();

  // The disk fails as the picture is written: a plain answer, the old photo stays, nothing is printed.
  let failing = false;
  const inner = photosInMemory();
  const photos = { ...inner, put: (...args) => { if (failing) throw new Error(`ENOSPC: no space left on device, write '/var/data/photos/${args[0]}/${args[1]}.jpg'`); inner.put(...args); } };
  const second = await photoWorld(t, { store: createStore(':memory:', { photos }) });
  assert.equal((await second.w.put(second.sarahId, second.mary.organizerToken)).status, 200);
  failing = true;
  const failed = await second.w.put(second.sarahId, second.mary.organizerToken, GREY);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'The photo could not be saved. Please try again.' });
  assert.equal(second.tagOf(second.mary), KEPT.etag);
  assert.ok((await second.w.bytes(homePhoto(second.sarahId), { token: second.mary.homeToken })).bytes.equals(KEPT.bytes));
  await second.w.close();
  assert.deepEqual(written, []);
});

test('photos: these tests wrote nothing into the repository', () => {
  assert.deepEqual(repositoryFiles(), repositoryBefore);
});
