// The video link between the two devices, and what to do when it will not
// connect or drops.
//
// A visit always tries a direct connection first. Only if that has not come up
// after a few seconds, or it later fails, do we ask our server for the relay:
// short-lived credentials for this one visit. Picture and sound then travel
// through Cloudflare's relay, still encrypted between the two devices. Most
// visits never touch it.
//
// The visitor makes the offer, after the home screen has answered. Messages
// pass through our server only to introduce the two devices.
import { getConfig } from './common.js';

// Tells a device its own public address, nothing more.
export const PUBLIC_STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// How long we wait before each step, in milliseconds.
export const TIMES = {
  askRelay: 5_000,          // not connected yet: ask for the relay
  giveUp: 30_000,           // never connected: end the visit and say so
  relayAnswer: 5_000,       // how long to wait for the server's answer about the relay
  lostGrace: 6_000,         // a short drop often heals by itself
  failedVisitor: 20_000,    // connection failed and not back: the visitor ends the visit
  failedHome: 25_000,       // the home screen a little later, in case the visitor has gone
  lostLimit: 60_000,        // however it happened: this long without a connection ends the visit
  refreshBefore: 15 * 60_000, // long visits: new relay credentials this long before the old run out
  refreshRetry: 3 * 60_000,
  pathChecks: [2_000, 6_000], // when to read how we are connected (the first reading can be wrong)
};
export const MAX_RESTARTS = 3;

// How the two devices are connected right now: { relayed } or null if unknown.
// Works in Chrome and in WebKit (every browser on an iPhone or iPad).
export async function pathInfo(pc) {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) || pair; });
  if (!pair) stats.forEach((s) => { if (!pair && s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s; });
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  return { relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay' };
}

// Starts the video link for one visit.
//   role        'home' or 'visitor'
//   stream      this device's camera and microphone
//   link        the connection to our server (from connect() in common.js)
//   onRemote    called with the other person's picture and sound
//   onState     'connecting', 'connected', 'reconnecting' or 'no_connection'
//               (after 'no_connection' the visit has been ended)
//   onPath      { relayed } a few seconds after connecting
//   onNote      'relay_not_set_up' or 'relay_unavailable', only with forceRelay
//   forceRelay  visitor only: use the relay from the start (a way to test it)
// Returns at once; `ready` settles when this side can take the other's messages.
export function startCall({ role, stream, link, onRemote, onState, onPath, onNote, forceRelay = false, config = getConfig(), deps = {} }) {
  const RTC = deps.RTCPeerConnection || globalThis.RTCPeerConnection;
  const Stream = deps.MediaStream || globalThis.MediaStream;
  const later = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout || ((id) => clearTimeout(id));
  const visitor = role === 'visitor';

  let pc = null;
  let closed = false;
  let publicStun = PUBLIC_STUN;
  let relayOnly = false;        // forceRelay, and the relay answered
  let everConnected = false;
  // What we know about the relay: 'none' (never asked), 'asking', 'have',
  // 'off' (not set up) or 'failed' (asked, and it could not be reached).
  let relay = 'none';
  let relayServers = null;
  let relayKey = '';
  let relayWaiter = null;
  let refreshTries = 0;
  let restarts = 0;
  let restartWanted = false;
  let offerSeen = false;        // home screen: the visitor's first offer has arrived
  const timers = {};
  const pending = [];           // the other side's candidates that arrived early

  const set = (name, fn, ms) => { cancel(timers[name]); timers[name] = later(() => { timers[name] = null; if (!closed) fn(); }, ms); };
  const clear = (...names) => { for (const name of names) { cancel(timers[name]); timers[name] = null; } };
  const signal = (data) => link.send({ type: 'signal', data });
  const servers = () => [...publicStun, ...(relayServers || [])];
  const policy = () => (relayOnly ? { iceTransportPolicy: 'relay' } : {});

  // One thing at a time: offers, answers and candidates must not overlap.
  let queue = Promise.resolve();
  const enqueue = (work) => {
    const run = queue.then(() => (closed ? undefined : work()));
    queue = run.catch((err) => { if (!closed) console.error(err); });
    return run;
  };

  function build() {
    try {
      pc = new RTC({ iceServers: servers(), ...policy() });
    } catch {
      // iPhones and iPads refuse server lists that other browsers accept.
      // Better a direct attempt than no visit at all.
      relayOnly = false;
      relayServers = null;
      relayKey = '';
      if (relay === 'have') relay = 'failed';
      clear('refresh');
      publicStun = PUBLIC_STUN;
      pc = new RTC({ iceServers: PUBLIC_STUN });
    }
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const remote = new Stream();
    pc.ontrack = (e) => {
      for (const t of e.streams[0]?.getTracks() || [e.track]) if (!remote.getTracks().includes(t)) remote.addTrack(t);
      onRemote?.(remote);
    };
    pc.onicecandidate = (e) => { if (e.candidate) signal({ candidate: e.candidate.toJSON() }); };
    // connectionState, not iceConnectionState: only the first reliably says "failed".
    pc.onconnectionstatechange = () => { if (!closed) onConnection(pc.connectionState); };
    pc.onsignalingstatechange = () => { if (!closed && restartWanted && pc.signalingState === 'stable') restartIce(); };
  }

  async function offer(options) {
    await pc.setLocalDescription(await pc.createOffer(options));
    signal({ sdp: pc.localDescription.toJSON() });
  }

  // A fresh attempt at finding a way through, on the same visit. Only the
  // visitor does this (it makes the offers); the home screen answers.
  function restartIce() {
    if (!visitor || closed || !pc) return;
    restartWanted = true;
    enqueue(async () => {
      // An offer still waiting for its answer: we are called again when it comes.
      if (!restartWanted || pc.signalingState !== 'stable') return;
      restartWanted = false;
      await offer({ iceRestart: true });
    });
  }
  function tryRestart() {
    if (!visitor || restarts >= MAX_RESTARTS) return;
    restarts += 1;
    restartIce();
  }

  function askRelay() {
    if (closed || relay === 'asking') return;
    relay = 'asking';
    link.send({ type: 'relay' });
    // No answer at all counts as "could not be reached".
    set('answer', () => { if (relay === 'asking') handleRelay({ iceServers: null, reason: 'unavailable' }); }, TIMES.relayAnswer);
  }

  const stuck = () => !!pc && (pc.connectionState === 'failed' || (everConnected && pc.connectionState === 'disconnected'));

  // The server's answer about the relay (also sent when the other side asked).
  function handleRelay(msg) {
    if (closed) return;
    clear('answer');
    const list = Array.isArray(msg?.iceServers) && msg.iceServers.length ? msg.iceServers : null;
    if (!list) {
      if (relayServers) {
        // We hold credentials already and could not get newer ones: try again
        // a little later, while the ones we have still work.
        relay = 'have';
        if (visitor && refreshTries < 3) { refreshTries += 1; set('refresh', askRelay, TIMES.refreshRetry); }
      } else {
        relay = msg?.reason === 'not_set_up' ? 'off' : 'failed';
      }
      relayWaiter?.();
      // Carry on trying directly.
      if (stuck()) tryRestart();
      return;
    }
    const key = JSON.stringify(list);
    const same = key === relayKey;
    const first = !relayServers;
    relay = 'have';
    relayServers = list;
    relayKey = key;
    relayWaiter?.();
    if (same) {
      if (stuck()) tryRestart();
      return;
    }
    refreshTries = 0;
    // Long visits: ask for new credentials before these run out.
    const ttl = Number(msg.ttl) || 0;
    if (visitor && ttl > 0) set('refresh', askRelay, Math.max(ttl * 1000 - TIMES.refreshBefore, ttl * 750));
    if (!pc) return;            // not built yet: build() will use them
    try {
      pc.setConfiguration({ iceServers: servers(), ...policy() });
    } catch {
      relayServers = null;
      relayKey = '';
      relay = 'failed';
      clear('refresh');
      if (stuck()) tryRestart();
      return;
    }
    // Connected already, by the time the answer came (the other side asked,
    // or the direct way came up just now): leave a working visit alone. The
    // servers are kept for a later drop, and the relay stays unused.
    if (first && pc.connectionState === 'connected') return;
    // New servers are only used from the next attempt on, so start one.
    restartIce();
  }

  // The timeline for getting connected, counted from when this side starts
  // talking to the other: ask for the relay after 5 seconds, give up after 30.
  function startClock() {
    if (everConnected) return;
    set('ask', () => { if (!everConnected && relay === 'none') askRelay(); }, TIMES.askRelay);
    set('giveUp', () => { if (!everConnected) giveUp(); }, TIMES.giveUp);
  }

  function giveUp() {
    if (closed) return;
    link.send({ type: 'end', reason: 'no_connection' });
    close();
    onState?.('no_connection');
  }

  function onConnection(state) {
    if (state === 'connected') {
      everConnected = true;
      clear('ask', 'giveUp', 'grace', 'failed', 'lost');
      onState?.('connected');
      TIMES.pathChecks.forEach((ms, i) => set(`path${i}`, async () => {
        if (pc.connectionState !== 'connected') return;
        const info = await pathInfo(pc).catch(() => null);
        if (info && !closed) onPath?.(info);
      }, ms));
      return;
    }
    if (!everConnected) {
      // Failed before ever connecting: the direct way is shut, so don't wait.
      if (state === 'failed') { if (relay === 'none') askRelay(); else if (relay !== 'asking') tryRestart(); }
      return;
    }
    if (state !== 'disconnected' && state !== 'failed') return;
    onState?.('reconnecting');
    if (!timers.lost) set('lost', giveUp, TIMES.lostLimit);
    if (state === 'disconnected') {
      if (!timers.grace) set('grace', () => { if (pc.connectionState === 'disconnected') recover(); }, TIMES.lostGrace);
    } else {
      clear('grace');
      if (!timers.failed) set('failed', giveUp, visitor ? TIMES.failedVisitor : TIMES.failedHome);
      recover();
    }
  }

  // The connection dropped after working. The visitor asks for the relay if
  // it has none yet; otherwise it tries again a few times.
  function recover() {
    if (!visitor || relay === 'asking') return;
    if (relay === 'none' || relay === 'failed') askRelay();
    else tryRestart();
  }

  // A message from the other device: its offer or answer, or a way to reach it.
  // Problems are reported once, by the queue; this never rejects.
  function handleSignal(data) {
    if (!data) return Promise.resolve();
    return enqueue(async () => {
      if (data.sdp) {
        // The home screen's clock starts again when the visitor's first offer
        // arrives: a visitor whose phone is slow to start has not failed yet.
        if (data.sdp.type === 'offer' && !offerSeen) { offerSeen = true; startClock(); }
        await pc.setRemoteDescription(data.sdp);
        while (pending.length) await pc.addIceCandidate(pending.shift()).catch(() => {});
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          signal({ sdp: pc.localDescription.toJSON() });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else pending.push(data.candidate);
      }
    }).catch(() => {});
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const name of Object.keys(timers)) clear(name);
    relayWaiter?.();
    try { pc?.close(); } catch { /* already gone */ }
  }

  const ready = enqueue(async () => {
    const cfg = await Promise.resolve(config).catch(() => null);
    if (Array.isArray(cfg?.iceServers) && cfg.iceServers.length) publicStun = cfg.iceServers;
    if (closed) return;
    if (visitor && forceRelay) {
      // Testing the relay: ask before anything else and wait for the answer.
      askRelay();
      if (relay === 'asking') await new Promise((resolve) => { relayWaiter = resolve; });
      relayWaiter = null;
      if (closed) return;
      if (relayServers) relayOnly = true;
      else onNote?.(relay === 'off' ? 'relay_not_set_up' : 'relay_unavailable');
    }
    build();
    onState?.('connecting');
    // For the home screen this also covers an offer that never comes.
    startClock();
    if (visitor) await offer();
  });

  return { ready, handleSignal, handleRelay, pathInfo: async () => (pc && !closed ? pathInfo(pc) : null), close };
}
