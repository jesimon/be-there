// Be There: the web server and the live "who is visiting" switchboard.
//
// Video and sound go straight between the two devices (WebRTC); this server
// only introduces them and enforces the rules in lib/rules.js. It never sees,
// records or stores a visit.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createStore } from './lib/store.js';
import { visitStatus, visitorView, homeView, MODES, DROP_IN_NOTICE_SECONDS } from './lib/rules.js';
import { sameHash, hashToken } from './lib/tokens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RING_SECONDS = 45;

function iceServers() {
  try {
    const list = JSON.parse(process.env.ICE_SERVERS || 'null');
    if (Array.isArray(list) && list.length) return list;
  } catch { /* fall through to the default */ }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
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

export function createApp({ store = createStore(), setupPassword = (process.env.SETUP_PASSWORD || '').trim() } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  // Private and early: keep it out of search engines; links carry secrets after
  // the # (never sent to servers) and no referrer leaves the site.
  app.use((req, res, next) => {
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
  app.get('/api/config', (req, res) => res.json({ iceServers: iceServers(), dropInNoticeSeconds: DROP_IN_NOTICE_SECONDS }));

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
  app.get('/api/organize', organizer, (req, res) => res.json({ home: homeView(req.home), online: live(req.home.id).online }));
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
  const pub = path.join(here, 'public');
  for (const page of ['home', 'visit', 'organize', 'setup']) {
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(pub, `${page}.html`)));
  }
  app.use(express.static(pub, { extensions: ['html'], maxAge: '5m' }));

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

  function endCallIf(homeId, test, reason = 'ended') {
    const l = live(homeId);
    const call = l.call;
    if (!call || !test(call)) return false;
    clearTimeout(call.timer);
    l.call = null;
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
        return endCallIf(home.id, () => true, 'ended');
      case 'signal':
        if (l.call?.state === 'live') send(l.call.socket, { type: 'signal', data: msg.data });
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
        endCallIf(home.id, (c) => c.socket === ws, msg.type === 'cancel' ? 'cancelled' : 'ended');
        return;
      case 'signal':
        if (l.call?.socket === ws && l.call.state === 'live') send(l.homeSocket, { type: 'signal', data: msg.data });
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

  return { app, onConnection };
}

export function startServer({ port = Number(process.env.PORT) || 3000, ...options } = {}) {
  const { app, onConnection } = createApp(options);
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
        close: () => new Promise((done) => { clearInterval(beat); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(done); }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startServer();
  console.log(`Be There on ${url}${process.env.SETUP_PASSWORD ? '' : ' (no SETUP_PASSWORD: anyone can create a home)'}`);
}
