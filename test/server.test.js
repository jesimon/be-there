// The server end to end, without video: setup, invitations, consent, knocking,
// answering, passing signals, and ending.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server.js';
import { createStore } from '../lib/store.js';

let srv;
before(async () => { srv = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: 'open-sesame' }); });
after(() => srv.close());

const req = async (path, { token, method = 'GET', body } = {}) => {
  const res = await fetch(srv.url + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

// A WebSocket client that records messages and can wait for one.
function client(role, token) {
  const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws');
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
}

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
