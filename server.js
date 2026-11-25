// Be There: the web server and the live "who is visiting" switchboard.
//
// Video and sound go straight between the two devices when their networks
// allow it, and otherwise through Cloudflare's relay, encrypted from one device
// to the other (lib/ice.js). They never pass through this server: it only
// introduces the two devices and enforces the rules in lib/rules.js. It never
// sees, records or stores a visit.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createStore } from './lib/store.js';
import { visitStatus, visitorView, homeView, MODES, DROP_IN_NOTICE_SECONDS } from './lib/rules.js';
import { sameHash, hashToken } from './lib/tokens.js';
import { publicIceServers, createRelay } from './lib/ice.js';
import { CANONICAL_ALLOW, canonicalOriginFrom } from './lib/address.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RING_SECONDS = 45;
// Relay credentials are made at most this many times in one visit: once when
// it is first needed, then again only if a very long visit outlasts them.
const MAX_RELAY_MINTS = 4;
// Why a device may say a visit ended. Anything else is passed on as 'ended'.
// "Could not connect" is only believed of a visit that was answered: a knock
// that is still ringing has not tried to connect yet.
const END_REASONS = ['ended', 'no_connection'];
function endReason(reason, call) {
  if (!END_REASONS.includes(reason)) return 'ended';
  return reason === 'no_connection' && call?.state !== 'live' ? 'ended' : reason;
}

const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '') || [])[1] || '';

// A few requests per minute per address, for the routes that create things.
function rateLimit(perMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    next();
  };
}

export function createApp({
  store = createStore(),
  setupPassword = (process.env.SETUP_PASSWORD || '').trim(),
  env = process.env,
  relay = createRelay({ env }),
  now = Date.now,
  // Be There's new address, if it has been switched on. Only an address on
  // the list in lib/address.js is ever used; the two options are there so
  // that tests can use an address on this machine.
  canonicalOrigin = env.CANONICAL_ORIGIN,
  canonicalAllow = CANONICAL_ALLOW,
} = {}) {
  const address = canonicalOriginFrom(canonicalOrigin, canonicalAllow);
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  // Every address this server is reached at is served alike. There is no
  // redirect and no check of the Host header anywhere: devices hold links on
  // the first address, a connection to /ws cannot follow a redirect, and the
  // host's health check must always get its 200. A device moves to the new
  // address from inside its own page (public/js/moved.js).

  // Private and early: keep it out of search engines; links carry secrets after
  // the # (never sent to servers) and no referrer leaves the site.
  app.use((req, res, next) => {
    // Reached over HTTPS once, a browser keeps to HTTPS at that address (the
    // camera needs it anyway). This address only: no subdomains, no preload.
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    res.set({
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  // Anyone can read this, so it only ever lists public STUN servers. Relay
  // credentials go to the two devices of a live visit, over their own
  // connections, and nowhere else. canonicalOrigin is the new address (or
  // null): visitor, organizer and setup pages go there by themselves.
  app.get('/api/config', (req, res) => res.json({ iceServers: publicIceServers(env), dropInNoticeSeconds: DROP_IN_NOTICE_SECONDS, canonicalOrigin: address.origin }));

  // ----- Setting up a home (needs SETUP_PASSWORD when it is set) -----
  app.post('/api/homes', rateLimit(5), (req, res) => {
    if (setupPassword) {
      // Trimmed, since a pasted password often carries a stray space.
      const given = String(req.body?.password || '').trim();
      if (!sameHash(hashToken(given), hashToken(setupPassword))) return res.status(401).json({ error: 'That setup password is not right.' });
    }
    const { name, personName, timeZone, hours } = req.body || {};
    const { home, homeToken, organizerToken } = store.createHome({ name, personName, timeZone, hours });
    res.status(201).json({ home: homeView(home), homeToken, organizerToken });
  });
  app.get('/api/setup-info', (req, res) => res.json({ needsPassword: !!setupPassword }));

  // ----- Organizers: the family member who sets it up -----
  // They can invite and remove visitors and set the hours, but only the person
  // at home can say yes to a visitor, choose who may come straight in, or
  // pause and resume visits.
  const organizer = (req, res, next) => {
    const home = store.homeByOrganizerToken(bearer(req));
    if (!home) return res.status(401).json({ error: 'This organizer link does not work. Ask for a new one.' });
    req.home = home;
    next();
  };
  app.get('/api/organize', organizer, (req, res) => res.json({ home: homeView(req.home), online: live(req.home.id).online, relay: relay.ready ? 'ready' : 'off' }));
  // Lets the organizer check the relay key without a visit: make credentials
  // that last a minute, and make them stop working straight away.
  app.post('/api/organize/relay-test', organizer, rateLimit(6), async (req, res) => {
    if (!relay.ready) return res.json({ ok: false, reason: 'not_set_up' });
    const attempt = (options) => Promise.resolve().then(() => relay.mint(options)).catch(() => null);
    let made = await attempt({ ttl: 60 });
    // 400 is the relay service refusing the request itself, not the key. In
    // case it is the one-minute life it will not have, try once with the usual
    // one, so that a good key is never reported as a bad one.
    if (made?.reason === 'http_400') made = await attempt();
    if (!made?.ok) return res.json({ ok: false, reason: made?.reason || 'network' });
    await revoke(made.username);
    res.json({ ok: true });
  });
  app.patch('/api/organize/home', organizer, (req, res) => {
    const { name, personName, hours, timeZone } = req.body || {};
    const changes = Object.fromEntries(Object.entries({ name, personName, hours, timeZone }).filter(([, v]) => v !== undefined));
    store.updateHome(req.home, changes);
    changed(req.home);
    res.json({ home: homeView(req.home) });
  });
  app.post('/api/organize/visitors', organizer, rateLimit(20), (req, res) => {
    if (req.home.visitors.filter((v) => !v.removed).length >= 50) return res.status(400).json({ error: 'A home can have up to 50 visitors.' });
    const { visitor, token } = store.addVisitor(req.home, req.body || {});
    changed(req.home);
    res.status(201).json({ visitor: { id: visitor.id, name: visitor.name, relation: visitor.relation, approved: false, mode: visitor.mode }, token });
  });
  app.delete('/api/organize/visitors/:id', organizer, (req, res) => {
    const v = store.removeVisitor(req.home, req.params.id);
    if (!v) return res.status(404).json({ error: 'No such visitor.' });
    endCallIf(req.home.id, (call) => call.visitorId === v.id, 'removed');
    dropVisitor(req.home.id, v.id);
    changed(req.home);
    res.json({ ok: true });
  });
  app.post('/api/organize/home-link', organizer, (req, res) => {
    const token = store.resetHomeLink(req.home);
    // The old home screen stops working at once.
    const l = live(req.home.id);
    if (l.homeSocket) l.homeSocket.close(4001, 'link replaced');
    res.json({ homeToken: token });
  });
  app.post('/api/organize/organizer-link', organizer, (req, res) => res.json({ organizerToken: store.resetOrganizerLink(req.home) }));
  app.delete('/api/organize/home', organizer, (req, res) => {
    // End any visit first, so its relay credentials stop working too.
    endCallIf(req.home.id, () => true, 'ended');
    const l = live(req.home.id);
    if (l.homeSocket) l.homeSocket.close(4002, 'home deleted');
    for (const set of l.visitors.values()) for (const ws of set) ws.close(4002, 'home deleted');
    lives.delete(req.home.id);
    store.deleteHome(req.home);
    res.json({ ok: true });
  });

  // ----- Visitors -----
  app.get('/api/visit', (req, res) => {
    const found = store.visitorByToken(bearer(req));
    if (!found) return res.status(401).json({ error: 'This visitor link does not work. Ask the family for a new one.' });
    res.json(visitorView(found.home, found.visitor, liveSummary(found.home.id)));
  });

  // ----- Pages -----
  // Pages, scripts and styles are checked with the server every time they are
  // loaded (the ETag keeps that cheap), so a page never runs with one new
  // script and one old one after an update.
  const pub = path.join(here, 'public');
  const checkEveryTime = (res, file) => { if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); };
  for (const page of ['home', 'visit', 'organize', 'setup']) {
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(pub, `${page}.html`), { cacheControl: false, headers: { 'Cache-Control': 'no-cache' } }));
  }
  app.use(express.static(pub, { extensions: ['html'], maxAge: '5m', etag: true, setHeaders: checkEveryTime }));

  // ----- Live state: who is connected, who is visiting -----
  // homeId -> { homeSocket, visitors: Map<visitorId, Set<ws>>, call }
  const lives = new Map();
  function live(homeId) {
    if (!lives.has(homeId)) lives.set(homeId, { homeSocket: null, visitors: new Map(), call: null });
    const l = lives.get(homeId);
    l.online = !!l.homeSocket;
    return l;
  }
  const liveSummary = (homeId) => {
    const l = live(homeId);
    return { online: l.online, busyWith: l.call?.visitorId || null };
  };
  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function callInfo(home, call) {
    if (!call) return null;
    const v = home.visitors.find((x) => x.id === call.visitorId);
    return { visitorId: call.visitorId, name: v?.name || 'A visitor', state: call.state, mode: v?.mode || 'knock' };
  }

  // Tell everyone connected to this home what has changed.
  function changed(home) {
    const l = live(home.id);
    send(l.homeSocket, { type: 'state', home: homeView(home), call: callInfo(home, l.call) });
    for (const [visitorId, set] of l.visitors) {
      const v = home.visitors.find((x) => x.id === visitorId);
      if (!v || v.removed) continue;
      const view = visitorView(home, v, liveSummary(home.id));
      for (const ws of set) send(ws, { type: 'status', view });
    }
  }

  // ----- The relay, for visits that cannot connect directly -----
  // Credentials are made only for a live visit, only when one of its two
  // devices asks (they ask when a direct connection has not come up), are
  // given only to those two devices, and stop working when the visit ends.
  // Nothing about them is logged or stored: they live on the call, in memory.
  const background = new Set();     // requests to the relay service still under way
  const track = (promise) => {
    background.add(promise);
    promise.finally(() => background.delete(promise));
    return promise;
  };
  // Makes credentials stop working. Best effort, and never throws.
  const revoke = (username) => track(Promise.resolve().then(() => relay.revoke(username)).catch(() => {}));

  function releaseRelay(call) {
    if (!call.relay) return;
    for (const username of call.relay.usernames.splice(0)) revoke(username);
    call.relay.iceServers = null;
  }

  // `ws` is one of the two devices of `call`, which is live.
  function onRelayRequest(ws, homeId, call) {
    if (!relay.ready) return send(ws, { type: 'relay', iceServers: null, reason: 'not_set_up' });
    const unavailable = { type: 'relay', iceServers: null, reason: 'unavailable' };
    call.relay ||= { usernames: [], iceServers: null, mintedAt: 0, ttl: 0, mints: 0, waiting: null };
    const r = call.relay;
    // Credentials in the first half of their life are simply given again.
    if (r.iceServers && now() - r.mintedAt < r.ttl * 500) return send(ws, { type: 'relay', iceServers: r.iceServers, ttl: r.ttl });
    // One request to the relay service at a time: whoever asks meanwhile
    // shares its answer.
    if (r.waiting) {
      r.waiting.add(ws);
      return;
    }
    if (r.mints >= MAX_RELAY_MINTS) return send(ws, unavailable);
    r.mints += 1;
    r.waiting = new Set([ws]);
    track(Promise.resolve().then(() => relay.mint()).catch(() => null).then((made) => {
      const askers = r.waiting;
      r.waiting = null;
      const ok = !!made?.ok && Array.isArray(made.iceServers) && typeof made.username === 'string';
      // The visit ended while we were asking: these must not outlive it.
      if (lives.get(homeId)?.call !== call) {
        if (ok) revoke(made.username);
        return;
      }
      if (!ok) {
        for (const asker of askers) send(asker, unavailable);
        return;
      }
      r.usernames.push(made.username);
      r.iceServers = made.iceServers;
      r.mintedAt = now();
      r.ttl = Number(relay.ttl) || 0;
      // The home screen first: the visitor makes a new offer as soon as it
      // has the servers, and the home screen must hold them to answer it.
      const msg = { type: 'relay', iceServers: r.iceServers, ttl: r.ttl };
      send(lives.get(homeId).homeSocket, msg);
      send(call.socket, msg);
    }).catch(() => {}));
  }

  // When the server stops: end every visit, and wait until the relay service
  // has been told that their credentials no longer work. Each request to it
  // gives up by itself after a few seconds; the limit here is a backstop.
  async function shutdown() {
    for (const homeId of [...lives.keys()]) endCallIf(homeId, () => true, 'offline');
    let timer;
    const tooLong = new Promise((resolve) => { timer = setTimeout(resolve, 6000); });
    const told = (async () => { while (background.size) await Promise.allSettled([...background]); })();
    await Promise.race([told, tooLong]);
    clearTimeout(timer);
  }

  // Every way a visit can end comes through here, so this is also where its
  // relay credentials stop working.
  function endCallIf(homeId, test, reason = 'ended') {
    const l = live(homeId);
    const call = l.call;
    if (!call || !test(call)) return false;
    clearTimeout(call.timer);
    l.call = null;
    releaseRelay(call);
    send(l.homeSocket, { type: 'ended', visitorId: call.visitorId, reason });
    send(call.socket, { type: 'ended', reason });
    const home = store.getHome(homeId);
    if (home) changed(home);
    return true;
  }

  function dropVisitor(homeId, visitorId) {
    const set = live(homeId).visitors.get(visitorId);
    if (set) for (const ws of set) ws.close(4003, 'removed');
    live(homeId).visitors.delete(visitorId);
  }

  function onHomeMessage(ws, home, msg) {
    const l = live(home.id);
    switch (msg.type) {
      case 'pause':
        store.updateHome(home, { paused: !!msg.paused });
        if (home.paused) endCallIf(home.id, () => true, 'paused');
        return changed(home);
      case 'approve': {
        const v = store.updateVisitor(home, String(msg.visitorId), { approved: !!msg.approved });
        if (v && !v.approved) endCallIf(home.id, (c) => c.visitorId === v.id, 'not_allowed');
        return changed(home);
      }
      case 'mode':
        if (MODES.includes(msg.mode)) store.updateVisitor(home, String(msg.visitorId), { mode: msg.mode });
        return changed(home);
      case 'answer':
        if (l.call && l.call.visitorId === msg.visitorId && l.call.state === 'ringing') {
          clearTimeout(l.call.timer);
          l.call.state = 'live';
          send(l.call.socket, { type: 'answered' });
          changed(home);
        }
        return;
      case 'decline':
        return endCallIf(home.id, (c) => c.visitorId === msg.visitorId && c.state === 'ringing', 'declined');
      case 'end':
        return endCallIf(home.id, () => true, endReason(msg.reason, l.call));
      case 'signal':
        if (l.call?.state === 'live') send(l.call.socket, { type: 'signal', data: msg.data });
        return;
      case 'relay':
        if (l.call?.state === 'live') onRelayRequest(ws, home.id, l.call);
        return;
      default:
    }
  }

  function onVisitorMessage(ws, home, visitor, msg) {
    const l = live(home.id);
    switch (msg.type) {
      case 'knock': {
        const status = visitStatus(home, visitor, liveSummary(home.id));
        if (!status.ok || l.call) {
          send(ws, { type: 'cannot', reason: l.call ? 'busy' : status.reason });
          return;
        }
        l.call = { visitorId: visitor.id, socket: ws, state: 'ringing' };
        l.call.timer = setTimeout(() => endCallIf(home.id, (c) => c.socket === ws && c.state === 'ringing', 'no_answer'), RING_SECONDS * 1000);
        send(l.homeSocket, { type: 'knock', visitorId: visitor.id, name: visitor.name, mode: status.mode, notice: DROP_IN_NOTICE_SECONDS });
        send(ws, { type: 'ringing', mode: status.mode });
        changed(home);
        return;
      }
      case 'cancel':
      case 'end':
        endCallIf(home.id, (c) => c.socket === ws, msg.type === 'cancel' ? 'cancelled' : endReason(msg.reason, l.call));
        return;
      case 'signal':
        if (l.call?.socket === ws && l.call.state === 'live') send(l.homeSocket, { type: 'signal', data: msg.data });
        return;
      case 'relay':
        // Only the visitor who is in the visit, and only once it is answered.
        if (l.call?.socket === ws && l.call.state === 'live') onRelayRequest(ws, home.id, l.call);
        return;
      default:
    }
  }

  // Called for every new WebSocket. The first message must say who it is.
  function onConnection(ws) {
    let who = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const helloTimer = setTimeout(() => { if (!who) ws.close(4000, 'no hello'); }, 10_000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!who) {
        if (msg.type !== 'hello') return;
        if (msg.role === 'home') {
          const home = store.homeByHomeToken(msg.token);
          if (!home) return ws.close(4001, 'bad link');
          if (msg.timeZone && msg.timeZone !== home.timeZone) store.updateHome(home, { timeZone: msg.timeZone });
          const l = live(home.id);
          // One home screen at a time: a newer one replaces the old.
          if (l.homeSocket && l.homeSocket !== ws) {
            endCallIf(home.id, () => true, 'ended');
            l.homeSocket.close(4004, 'replaced');
          }
          l.homeSocket = ws;
          who = { role: 'home', homeId: home.id };
        } else if (msg.role === 'visitor') {
          const found = store.visitorByToken(msg.token);
          if (!found) return ws.close(4001, 'bad link');
          const l = live(found.home.id);
          if (!l.visitors.has(found.visitor.id)) l.visitors.set(found.visitor.id, new Set());
          l.visitors.get(found.visitor.id).add(ws);
          who = { role: 'visitor', homeId: found.home.id, visitorId: found.visitor.id };
        } else {
          return ws.close(4000, 'unknown role');
        }
        clearTimeout(helloTimer);
        changed(store.getHome(who.homeId));
        return;
      }

      const home = store.getHome(who.homeId);
      if (!home) return ws.close(4002, 'home deleted');
      if (who.role === 'home') {
        if (live(home.id).homeSocket !== ws) return;
        onHomeMessage(ws, home, msg);
      } else {
        const visitor = home.visitors.find((v) => v.id === who.visitorId && !v.removed);
        if (!visitor) return ws.close(4003, 'removed');
        onVisitorMessage(ws, home, visitor, msg);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!who) return;
      const l = live(who.homeId);
      if (who.role === 'home') {
        if (l.homeSocket !== ws) return;
        endCallIf(who.homeId, () => true, 'offline');
        l.homeSocket = null;
      } else {
        endCallIf(who.homeId, (c) => c.socket === ws, 'ended');
        const set = l.visitors.get(who.visitorId);
        if (set) { set.delete(ws); if (!set.size) l.visitors.delete(who.visitorId); }
      }
      const home = store.getHome(who.homeId);
      if (home) changed(home);
    });
  }

  return { app, onConnection, shutdown, relayReady: !!relay.ready, canonicalOrigin: address.origin, canonicalIgnored: address.ignored };
}

export function startServer({ port = Number(process.env.PORT) || 3000, ...options } = {}) {
  const { app, onConnection, shutdown, relayReady, canonicalOrigin, canonicalIgnored } = createApp(options);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', onConnection);
  // Drop connections that have silently died (a tablet that lost Wi-Fi).
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const { port: actual } = server.address();
      resolve({
        server,
        url: `http://localhost:${actual}`,
        relayReady,
        canonicalOrigin,
        canonicalIgnored,
        close: async () => {
          clearInterval(beat);
          await shutdown();
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url, relayReady, canonicalOrigin, canonicalIgnored, close } = await startServer();
  console.log(`Be There on ${url}${process.env.SETUP_PASSWORD ? '' : ' (no SETUP_PASSWORD: anyone can create a home)'}`);
  console.log(relayReady ? 'Relay: set up.' : 'Relay: not set up (visits connect directly only).');
  // The value that was set is never printed: only the address from the list
  // in the code, or that something else was asked for and left alone.
  if (canonicalOrigin) console.log(`New address: ${canonicalOrigin} (visitor, organizer and setup pages go there by themselves; the home screen stays where it is).`);
  if (canonicalIgnored) console.warn('CANONICAL_ORIGIN is set to an address this version does not know, so it is ignored. Nothing moves.');
  // The host stops the old server on every deploy. End visits properly first,
  // so no relay credentials are left working after it has gone.
  process.once('SIGTERM', () => {
    setTimeout(() => process.exit(0), 8000).unref();
    close().finally(() => process.exit(0));
  });
}
