// The browser's side of a visit's video link (public/js/peer.js), without a
// browser: a pretend RTCPeerConnection and a clock the test moves by hand.
// This is where the timeline is checked: when the relay is asked for, what
// happens when it answers, and when a visit that cannot connect is ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCall, pathInfo, PUBLIC_STUN, TIMES, MAX_RESTARTS } from '../public/js/peer.js';

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeClock() {
  let now = 0;
  let ids = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { ids += 1; timers.set(ids, { at: now + ms, fn }); return ids; },
    clearTimeout: (id) => { timers.delete(id); },
    get waiting() { return timers.size; },
    // Moves time on, running whatever falls due, in order.
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
    },
  };
}

const RELAY = [{ urls: ['turn:relay.example.org:3478?transport=udp'], username: 'u1', credential: 'c1' }];
const RELAY_2 = [{ urls: ['turn:relay.example.org:3478?transport=udp'], username: 'u2', credential: 'c2' }];

// Sets up one side of a visit. `refuse(config)` makes the pretend browser
// throw on a server list, as an iPhone does with one it does not like.
async function side({ role = 'visitor', forceRelay = false, config = { iceServers: PUBLIC_STUN }, refuse = () => false, onSend } = {}) {
  const clock = fakeClock();
  const peers = [];
  class Peer {
    constructor(cfg) {
      if (refuse(cfg)) throw new Error('refused');
      Object.assign(this, { made: cfg, configs: [], offers: [], answers: 0, tracks: [], added: [], connectionState: 'new', signalingState: 'stable', localDescription: null, remoteDescription: null, closed: false, stats: new Map() });
      peers.push(this);
    }
    addTrack(track) { this.tracks.push(track); }
    setConfiguration(cfg) { if (refuse(cfg)) throw new Error('refused'); this.configs.push(cfg); }
    async createOffer(options) { this.offers.push(options || {}); return { type: 'offer', sdp: `offer ${this.offers.length}` }; }
    async createAnswer() { this.answers += 1; return { type: 'answer', sdp: `answer ${this.answers}` }; }
    async setLocalDescription(d) { this.localDescription = { ...d, toJSON: () => ({ type: d.type, sdp: d.sdp }) }; this.state(d.type === 'offer' ? 'have-local-offer' : 'stable'); }
    async setRemoteDescription(d) {
      if (d.type === 'answer' && this.signalingState !== 'have-local-offer') throw new Error('no offer is waiting for an answer');
      this.remoteDescription = d;
      this.state(d.type === 'offer' ? 'have-remote-offer' : 'stable');
    }
    async addIceCandidate(c) { this.added.push(c); }
    async getStats() { return this.stats; }
    close() { this.closed = true; }
    state(s) { this.signalingState = s; this.onsignalingstatechange?.(); }
    become(s) { this.connectionState = s; this.onconnectionstatechange?.(); }
  }
  class Stream {
    constructor() { this.list = []; }
    getTracks() { return this.list; }
    addTrack(t) { this.list.push(t); }
  }
  const sent = [];
  const seen = { states: [], paths: [], notes: [], remotes: 0 };
  const link = { send: (msg) => { sent.push(msg); onSend?.(msg, call); } };
  const call = startCall({
    role,
    stream: { getTracks: () => ['camera', 'microphone'] },
    link,
    forceRelay,
    config,
    onRemote: () => { seen.remotes += 1; },
    onState: (s) => seen.states.push(s),
    onPath: (p) => seen.paths.push(p),
    onNote: (n) => seen.notes.push(n),
    deps: { RTCPeerConnection: Peer, MediaStream: Stream, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  });
  await flush();
  const t = {
    call, clock, sent, seen, peers,
    get pc() { return peers.at(-1); },
    of: (type) => sent.filter((m) => m.type === type),
    offers: () => sent.filter((m) => m.type === 'signal' && m.data.sdp?.type === 'offer').map((m) => m.data.sdp.sdp),
    // The other side's answer to the offer that is waiting.
    async answer() { await call.handleSignal({ sdp: { type: 'answer', sdp: 'their answer' } }); await flush(); },
    async relay(msg) { call.handleRelay({ type: 'relay', ...msg }); await flush(); },
    async become(state) { t.pc.become(state); await flush(); },
  };
  return t;
}

test('the timeline is the one agreed', () => {
  assert.equal(TIMES.askRelay, 5_000, 'ask for the relay after 5 seconds without a connection');
  assert.equal(TIMES.giveUp, 30_000, 'end a visit that never connected after 30 seconds');
  assert.equal(TIMES.relayAnswer, 5_000, 'wait up to 5 seconds for the answer about the relay');
  assert.equal(TIMES.lostGrace, 6_000, 'a drop of up to 6 seconds is left to heal by itself');
  assert.equal(TIMES.failedVisitor, 20_000);
  assert.equal(TIMES.failedHome, 25_000);
  assert.equal(TIMES.refreshBefore, 15 * 60_000, 'newer credentials 15 minutes before the old run out');
  assert.deepEqual(TIMES.pathChecks, [2_000, 6_000]);
  assert.equal(MAX_RESTARTS, 3);
});

test('visitor: a visit that connects directly never asks for the relay', async () => {
  const t = await side();
  assert.deepEqual(t.pc.made, { iceServers: PUBLIC_STUN }, 'public STUN only, no relay');
  assert.deepEqual(t.pc.tracks, ['camera', 'microphone']);
  assert.deepEqual(t.offers(), ['offer 1'], 'the visitor makes the offer');
  assert.deepEqual(t.pc.offers, [{}]);
  await t.answer();
  await t.clock.advance(3000);
  await t.become('connecting');
  await t.become('connected');
  assert.deepEqual(t.seen.states, ['connecting', 'connected']);

  // How it is connected is read twice, a little later: the first reading can be wrong.
  t.pc.stats = new Map([['T', { type: 'transport', selectedCandidatePairId: 'P' }], ['P', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }], ['L', { candidateType: 'host' }], ['R', { candidateType: 'prflx' }]]);
  await t.clock.advance(1999);
  assert.deepEqual(t.seen.paths, []);
  await t.clock.advance(1);
  assert.deepEqual(t.seen.paths, [{ relayed: false }]);
  t.pc.stats.set('R', { candidateType: 'relay' });
  await t.clock.advance(4000);
  assert.deepEqual(t.seen.paths, [{ relayed: false }, { relayed: true }]);

  await t.clock.advance(24 * 3600 * 1000);
  assert.deepEqual(t.of('relay'), []);
  assert.deepEqual(t.of('end'), []);
  assert.deepEqual(t.offers(), ['offer 1']);
  assert.equal(t.clock.waiting, 0, 'nothing left ticking during a healthy visit');
});

test('visitor: not connected after 5 seconds, it asks for the relay once and tries again through it', async () => {
  const t = await side();
  await t.answer();
  await t.become('connecting');
  await t.clock.advance(TIMES.askRelay - 1);
  assert.deepEqual(t.of('relay'), []);
  await t.clock.advance(1);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }]);

  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.deepEqual(t.pc.configs, [{ iceServers: [...PUBLIC_STUN, ...RELAY] }], 'the same connection, now with the relay; direct is still allowed');
  assert.deepEqual(t.pc.offers, [{}, { iceRestart: true }]);
  assert.deepEqual(t.offers(), ['offer 1', 'offer 2']);
  assert.equal(t.peers.length, 1);

  // The same answer again (the home screen asked too) changes nothing.
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.equal(t.pc.configs.length, 1);
  assert.equal(t.pc.offers.length, 2);

  await t.answer();
  await t.become('connected');
  await t.clock.advance(60_000);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }], 'asked once');
  assert.deepEqual(t.of('end'), []);
  assert.deepEqual(t.seen.states, ['connecting', 'connected']);
});

test('visitor: already connected when the relay’s answer comes, it leaves the visit alone', async () => {
  // The home screen asked; meanwhile the direct connection came up.
  const t = await side();
  await t.answer();
  await t.clock.advance(4900);
  await t.become('connected');
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.deepEqual(t.pc.configs, [{ iceServers: [...PUBLIC_STUN, ...RELAY] }], 'the servers are kept for later');
  assert.deepEqual(t.offers(), ['offer 1'], 'but nothing is restarted, so the relay stays unused');
  assert.deepEqual(t.of('relay'), []);

  // If the connection drops later, the next attempt can use them, without asking again.
  await t.become('failed');
  assert.deepEqual(t.pc.offers.at(-1), { iceRestart: true });
  assert.deepEqual(t.of('relay'), []);
  await t.answer();
  await t.become('connected');
  // Newer credentials for a long visit do restart: the old ones are about to run out.
  await t.relay({ iceServers: RELAY_2, ttl: 43_200 });
  assert.equal(t.pc.offers.length, 3);
  assert.deepEqual(t.pc.offers.at(-1), { iceRestart: true });
});

test('visitor: a connection that fails early asks for the relay at once', async () => {
  const t = await side();
  await t.answer();
  await t.clock.advance(1500);
  await t.become('failed');
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }]);
  await t.become('connecting');
  await t.become('failed');
  await t.clock.advance(TIMES.askRelay);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }], 'still only once');
});

test('visitor: the new offer waits until the first one has been answered', async () => {
  const t = await side();
  // The home screen has not answered the first offer yet.
  await t.clock.advance(TIMES.askRelay);
  await t.relay({ iceServers: RELAY, ttl: 600 });
  assert.equal(t.pc.configs.length, 1);
  assert.deepEqual(t.offers(), ['offer 1'], 'no second offer on top of an unanswered one');
  await t.answer();
  assert.deepEqual(t.offers(), ['offer 1', 'offer 2']);
  assert.deepEqual(t.pc.offers[1], { iceRestart: true });
});

test('home screen: asks after 5 seconds, takes the servers, and only answers offers', async () => {
  const t = await side({ role: 'home' });
  assert.deepEqual(t.sent, [], 'the home screen never makes the offer');
  await t.call.handleSignal({ candidate: { candidate: 'early' } });
  await t.call.handleSignal({ sdp: { type: 'offer', sdp: 'their offer' } });
  assert.deepEqual(t.pc.added, [{ candidate: 'early' }], 'candidates that came early are kept for after the offer');
  assert.deepEqual(t.sent, [{ type: 'signal', data: { sdp: { type: 'answer', sdp: 'answer 1' } } }]);

  await t.clock.advance(TIMES.askRelay - 1);
  assert.deepEqual(t.of('relay'), []);
  await t.clock.advance(1);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }]);
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.deepEqual(t.pc.configs, [{ iceServers: [...PUBLIC_STUN, ...RELAY] }]);
  assert.deepEqual(t.pc.offers, [], 'it waits for the visitor’s new offer');

  await t.call.handleSignal({ sdp: { type: 'offer', sdp: 'their second offer' } });
  assert.equal(t.pc.answers, 2);
  await t.become('connected');
  await t.clock.advance(12 * 3600 * 1000);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }], 'the home screen never asks for newer credentials; the visitor does');
  assert.deepEqual(t.of('end'), []);
});

test('home screen: its 5 and 30 seconds are counted from the visitor’s first offer', async () => {
  // A visitor whose phone is slow to start: the offer comes 4 seconds after the answer.
  const t = await side({ role: 'home' });
  await t.clock.advance(4000);
  await t.call.handleSignal({ sdp: { type: 'offer', sdp: 'their offer' } });
  await t.clock.advance(TIMES.askRelay - 1);
  assert.deepEqual(t.of('relay'), [], 'not 5 seconds after answering, but 5 seconds after the offer');
  await t.clock.advance(1);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }]);
  await t.relay({ iceServers: null, reason: 'not_set_up' });
  // A later offer (the visitor trying again) does not start the count afresh.
  await t.clock.advance(10_000);
  await t.call.handleSignal({ sdp: { type: 'offer', sdp: 'their second offer' } });
  await t.clock.advance(TIMES.giveUp - TIMES.askRelay - 10_000 - 1);
  assert.deepEqual(t.of('end'), []);
  await t.clock.advance(1);
  assert.deepEqual(t.of('end'), [{ type: 'end', reason: 'no_connection' }]);

  // No offer ever comes: the home screen is not left waiting for ever.
  const alone = await side({ role: 'home' });
  await alone.clock.advance(TIMES.giveUp - 1);
  assert.deepEqual(alone.of('end'), []);
  await alone.clock.advance(1);
  assert.deepEqual(alone.of('end'), [{ type: 'end', reason: 'no_connection' }]);
  assert.equal(alone.seen.states.at(-1), 'no_connection');
});

test('home screen: told about the relay before it asked, it does not ask', async () => {
  const t = await side({ role: 'home' });
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  await t.clock.advance(TIMES.askRelay + 1000);
  assert.deepEqual(t.of('relay'), []);
  assert.equal(t.pc.configs.length, 1);
});

for (const role of ['visitor', 'home']) {
  test(`${role}: with no relay it keeps trying directly, and after 30 seconds ends the visit`, async () => {
    for (const reason of ['not_set_up', 'unavailable']) {
      const t = await side({ role });
      if (role === 'visitor') await t.answer();
      await t.become('connecting');
      await t.clock.advance(TIMES.askRelay);
      await t.relay({ iceServers: null, reason });
      assert.equal(t.pc.configs.length, 0);
      assert.equal(t.pc.closed, false);
      await t.clock.advance(TIMES.giveUp - TIMES.askRelay - 1);
      assert.deepEqual(t.of('end'), []);
      await t.clock.advance(1);
      assert.deepEqual(t.of('end'), [{ type: 'end', reason: 'no_connection' }]);
      assert.equal(t.seen.states.at(-1), 'no_connection');
      assert.equal(t.pc.closed, true);
      assert.deepEqual(t.of('relay'), [{ type: 'relay' }]);
      await t.clock.advance(120_000);
      assert.equal(t.of('end').length, 1, 'said once');
      assert.equal(t.clock.waiting, 0);
    }
  });
}

test('no answer at all about the relay is treated as "could not be reached"', async () => {
  const t = await side();
  await t.answer();
  await t.clock.advance(TIMES.askRelay + TIMES.relayAnswer);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }]);
  // A late answer is still used.
  await t.relay({ iceServers: RELAY, ttl: 600 });
  assert.equal(t.pc.configs.length, 1);
  assert.deepEqual(t.pc.offers.at(-1), { iceRestart: true });
});

test('visitor: a short drop heals by itself; a longer one asks for the relay', async () => {
  const t = await side();
  await t.answer();
  await t.become('connected');
  await t.clock.advance(60_000);

  await t.become('disconnected');
  assert.equal(t.seen.states.at(-1), 'reconnecting');
  await t.clock.advance(TIMES.lostGrace - 1);
  await t.become('connected');
  await t.clock.advance(60_000);
  assert.deepEqual(t.of('relay'), []);
  assert.deepEqual(t.offers(), ['offer 1']);
  assert.equal(t.seen.states.at(-1), 'connected');

  await t.become('disconnected');
  await t.clock.advance(TIMES.lostGrace);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }], 'it had no relay yet, so it asks');
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.deepEqual(t.pc.offers.at(-1), { iceRestart: true });
  await t.answer();
  await t.become('connected');
  await t.clock.advance(60_000);
  assert.deepEqual(t.of('end'), []);
});

test('visitor: once it has the relay, a drop is retried at most three times, then the visit ends', async () => {
  const t = await side();
  await t.answer();
  await t.clock.advance(TIMES.askRelay);
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  await t.answer();
  await t.become('connected');
  const before = t.pc.offers.length;

  await t.become('failed');
  assert.equal(t.pc.offers.length, before + 1, 'tries again at once');
  assert.deepEqual(t.pc.offers.at(-1), { iceRestart: true });
  for (let i = 0; i < 5; i += 1) {
    if (t.pc.signalingState === 'have-local-offer') await t.answer();
    await t.become('connecting');
    await t.clock.advance(1000);
    await t.become('failed');
  }
  assert.equal(t.pc.offers.length, before + MAX_RESTARTS);
  assert.deepEqual(t.of('relay'), [{ type: 'relay' }], 'it does not ask for the relay again');
  assert.deepEqual(t.of('end'), []);
  await t.clock.advance(TIMES.failedVisitor - 5000);
  assert.deepEqual(t.of('end'), [{ type: 'end', reason: 'no_connection' }]);
  assert.equal(t.seen.states.at(-1), 'no_connection');
});

test('how long a failed connection is given: 20 seconds for the visitor, 25 for the home screen', async () => {
  for (const [role, wait] of [['visitor', TIMES.failedVisitor], ['home', TIMES.failedHome]]) {
    const t = await side({ role });
    if (role === 'visitor') await t.answer();
    await t.become('connected');
    await t.clock.advance(5000);
    await t.become('failed');
    if (role === 'home') assert.deepEqual(t.sent, [], 'the home screen waits for the visitor to try again');
    await t.relay({ iceServers: null, reason: 'not_set_up' });
    await t.clock.advance(wait - 1);
    assert.deepEqual(t.of('end'), [], role);
    await t.clock.advance(1);
    assert.deepEqual(t.of('end'), [{ type: 'end', reason: 'no_connection' }], role);
  }
  assert.equal(TIMES.failedVisitor, 20_000);
  assert.equal(TIMES.failedHome, 25_000);

  // Back within the time: the visit goes on.
  const t = await side();
  await t.answer();
  await t.become('connected');
  await t.become('failed');
  await t.relay({ iceServers: null, reason: 'not_set_up' });
  await t.clock.advance(TIMES.failedVisitor - 1);
  await t.become('connected');
  await t.clock.advance(120_000);
  assert.deepEqual(t.of('end'), []);
});

test('a connection that stays lost without ever "failing" still ends, after a minute', async () => {
  const t = await side({ role: 'home' });
  await t.become('connected');
  await t.become('disconnected');
  await t.clock.advance(TIMES.lostLimit - 1);
  assert.deepEqual(t.of('end'), []);
  await t.clock.advance(1);
  assert.deepEqual(t.of('end'), [{ type: 'end', reason: 'no_connection' }]);
});

test('visitor: on a long visit it asks for newer credentials before the old run out', async () => {
  const t = await side();
  await t.answer();
  await t.clock.advance(TIMES.askRelay);
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  await t.answer();
  await t.become('connected');
  assert.equal(t.of('relay').length, 1);

  // 15 minutes before the 12 hours are up (the 5 seconds had already passed).
  await t.clock.advance((43_200 - 15 * 60) * 1000 - 1);
  assert.equal(t.of('relay').length, 1);
  await t.clock.advance(1);
  assert.equal(t.of('relay').length, 2);
  await t.relay({ iceServers: RELAY_2, ttl: 43_200 });
  assert.deepEqual(t.pc.configs.at(-1), { iceServers: [...PUBLIC_STUN, ...RELAY_2] });
  assert.deepEqual(t.pc.offers.at(-1), { iceRestart: true });
  assert.equal(t.pc.offers.length, 3);
  await t.answer();

  // Newer ones could not be made: it keeps the ones it has and asks again a little later.
  await t.clock.advance((43_200 - 15 * 60) * 1000);
  assert.equal(t.of('relay').length, 3);
  await t.relay({ iceServers: null, reason: 'unavailable' });
  assert.equal(t.pc.offers.length, 3);
  await t.clock.advance(TIMES.refreshRetry);
  assert.equal(t.of('relay').length, 4);
  assert.deepEqual(t.of('end'), []);

  // Short-lived credentials are renewed three quarters of the way through.
  const short = await side();
  await short.answer();
  await short.clock.advance(TIMES.askRelay);
  await short.relay({ iceServers: RELAY, ttl: 600 });
  await short.answer();
  await short.become('connected');
  await short.clock.advance(450_000 - 1);
  assert.equal(short.of('relay').length, 1);
  await short.clock.advance(1);
  assert.equal(short.of('relay').length, 2);
});

test('?relay=1: the visitor asks first and then uses only the relay', async () => {
  const t = await side({ forceRelay: true });
  assert.deepEqual(t.sent, [{ type: 'relay' }], 'asked before anything else');
  assert.equal(t.peers.length, 0, 'nothing is tried until the answer comes');
  await t.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.deepEqual(t.pc.made, { iceServers: [...PUBLIC_STUN, ...RELAY], iceTransportPolicy: 'relay' });
  assert.deepEqual(t.pc.offers, [{}]);
  assert.deepEqual(t.seen.notes, []);
  await t.answer();
  await t.clock.advance(TIMES.askRelay + 1000);
  assert.equal(t.of('relay').length, 1);

  // Newer credentials later keep it on the relay.
  await t.relay({ iceServers: RELAY_2, ttl: 43_200 });
  assert.deepEqual(t.pc.configs, [{ iceServers: [...PUBLIC_STUN, ...RELAY_2], iceTransportPolicy: 'relay' }]);
});

test('?relay=1 without a relay: says so and carries on directly', async () => {
  const off = await side({ forceRelay: true });
  await off.relay({ iceServers: null, reason: 'not_set_up' });
  assert.deepEqual(off.seen.notes, ['relay_not_set_up']);
  assert.deepEqual(off.pc.made, { iceServers: PUBLIC_STUN });
  assert.deepEqual(off.offers(), ['offer 1']);
  await off.answer();
  await off.clock.advance(TIMES.askRelay + 1000);
  assert.equal(off.of('relay').length, 1, 'it does not ask a second time');

  const down = await side({ forceRelay: true });
  await down.relay({ iceServers: null, reason: 'unavailable' });
  assert.deepEqual(down.seen.notes, ['relay_unavailable']);
  assert.deepEqual(down.pc.made, { iceServers: PUBLIC_STUN });

  // No answer within 5 seconds: the same.
  const silent = await side({ forceRelay: true });
  await silent.clock.advance(TIMES.relayAnswer - 1);
  assert.equal(silent.peers.length, 0);
  await silent.clock.advance(1);
  assert.deepEqual(silent.seen.notes, ['relay_unavailable']);
  assert.deepEqual(silent.pc.made, { iceServers: PUBLIC_STUN });
  assert.deepEqual(silent.offers(), ['offer 1']);
});

test('a server list the browser refuses falls back to public STUN, never to no visit', async () => {
  // The list from /api/config is refused when the connection is made.
  const odd = [{ urls: 'stun:odd.example.org?x=1' }];
  const a = await side({ config: { iceServers: odd }, refuse: (cfg) => cfg.iceServers.some((s) => String(s.urls).includes('odd')) });
  assert.deepEqual(a.pc.made, { iceServers: PUBLIC_STUN });
  assert.deepEqual(a.offers(), ['offer 1']);

  // The relay's list is refused when it arrives: carry on without it.
  const b = await side({ refuse: (cfg) => cfg.iceServers.some((s) => s.username) });
  await b.answer();
  await b.clock.advance(TIMES.askRelay);
  await b.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.deepEqual(b.pc.configs, []);
  assert.deepEqual(b.offers(), ['offer 1']);
  assert.deepEqual(b.of('end'), []);
  await b.become('connected');
  await b.clock.advance(24 * 3600 * 1000);
  assert.equal(b.of('relay').length, 1, 'and it does not keep asking for credentials it cannot use');

  // With ?relay=1 and a relay list the browser refuses: a direct attempt.
  const c = await side({ forceRelay: true, refuse: (cfg) => cfg.iceServers.some((s) => s.username) });
  await c.relay({ iceServers: RELAY, ttl: 43_200 });
  assert.deepEqual(c.pc.made, { iceServers: PUBLIC_STUN });
  assert.deepEqual(c.offers(), ['offer 1']);

  // /api/config could not be read: the built-in list.
  const d = await side({ config: Promise.reject(new Error('offline')) });
  assert.deepEqual(d.pc.made, { iceServers: PUBLIC_STUN });
  assert.deepEqual(PUBLIC_STUN, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
});

test('closing stops everything: no timers, no messages, no callbacks afterwards', async () => {
  const t = await side();
  await t.answer();
  await t.become('connected');
  await t.become('failed');
  const sent = t.sent.length;
  const states = t.seen.states.length;
  t.call.close();
  assert.equal(t.pc.closed, true);
  assert.equal(t.clock.waiting, 0);
  await t.relay({ iceServers: RELAY, ttl: 600 });
  await t.call.handleSignal({ sdp: { type: 'offer', sdp: 'late' } });
  t.pc.become('connected');
  await t.clock.advance(120_000);
  assert.equal(t.sent.length, sent);
  assert.equal(t.seen.states.length, states);
  assert.equal(await t.call.pathInfo(), null);

  // Closed while still waiting for the relay's answer (?relay=1).
  const waiting = await side({ forceRelay: true });
  waiting.call.close();
  await waiting.call.ready;
  await waiting.clock.advance(60_000);
  assert.equal(waiting.peers.length, 0);
  assert.deepEqual(waiting.sent, [{ type: 'relay' }]);
});

test('pathInfo: relayed when either end of the chosen pair is a relay', async () => {
  const stats = (local, remote, extra = []) => ({
    getStats: async () => new Map([
      ['T', { type: 'transport', selectedCandidatePairId: 'P' }],
      ['P', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded', nominated: true }],
      ['L', { type: 'local-candidate', candidateType: local }],
      ['R', { type: 'remote-candidate', candidateType: remote }],
      ...extra,
    ]),
  });
  assert.deepEqual(await pathInfo(stats('host', 'srflx')), { relayed: false });
  assert.deepEqual(await pathInfo(stats('srflx', 'prflx')), { relayed: false });
  assert.deepEqual(await pathInfo(stats('relay', 'srflx')), { relayed: true });
  assert.deepEqual(await pathInfo(stats('host', 'relay')), { relayed: true });
  // Another, unused pair through a relay does not count.
  assert.deepEqual(await pathInfo(stats('host', 'host', [['P2', { type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R' }], ['L2', { candidateType: 'relay' }]])), { relayed: false });
  // No transport report: fall back to the nominated pair.
  const noTransport = { getStats: async () => new Map([['P', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded', nominated: true }], ['L', { candidateType: 'relay' }], ['R', { candidateType: 'host' }]]) };
  assert.deepEqual(await pathInfo(noTransport), { relayed: true });
  assert.equal(await pathInfo({ getStats: async () => new Map() }), null);
});
