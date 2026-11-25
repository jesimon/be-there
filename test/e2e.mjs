// A real visit in two browsers with fake cameras: the home screen and a
// visitor. Run with `npm run e2e` (needs Playwright and Chromium installed).
// Set SHOTS=<folder> to save screenshots along the way.
//
// It also checks the relay, with a small relay server of our own on this
// machine (node-turn) standing in for Cloudflare's: nothing here leaves the
// machine. Then the new address: one server reached by two names, as the real
// one is, and pages that move from the old name to the new one (or stay).
// It takes about a minute and a half, a third of it waiting for a visit that
// is meant not to connect.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server.js';
import { createStore } from '../lib/store.js';

// Playwright is loaded with require so a globally installed copy works too.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const Turn = require('node-turn');

const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const snap = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
// The same screen at tablet and phone size, in light and dark. `top` names
// the part of the page to bring to the top of each picture.
const SIZES = { tablet: { width: 1180, height: 820 }, phone: { width: 390, height: 844 } };
const snapAll = async (page, name, top) => {
  if (!shots) return;
  const was = page.viewportSize();
  for (const [size, viewport] of Object.entries(SIZES)) {
    for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      if (top) await page.locator(top).evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(shots, `${name}-${size}-${colorScheme}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  await page.setViewportSize(was);
};

// The local relay server, and a stand-in for lib/ice.js's createRelay() that
// makes a new username and password on it for each visit and removes them
// when the visit ends, as the real one does with Cloudflare.
const freePort = () => new Promise((resolve, reject) => {
  const socket = dgram.createSocket('udp4');
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => resolve(port)); });
});
const turnPort = await freePort();
const turn = new Turn({ authMech: 'long-term', credentials: {}, listeningPort: turnPort, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], debugLevel: 'OFF' });
turn.start();
const relay = {
  ready: true,
  ttl: 3600,
  down: false,          // true: the relay service cannot be reached
  minted: [],
  revoked: [],
  async mint() {
    if (relay.down) return { ok: false, reason: 'timeout' };
    const username = `visit-${relay.minted.length + 1}`;
    const credential = crypto.randomBytes(12).toString('hex');
    turn.addUser(username, credential);
    relay.minted.push(username);
    return { ok: true, username, iceServers: [{ urls: [`turn:127.0.0.1:${turnPort}?transport=udp`], username, credential }] };
  },
  async revoke(username) { turn.removeUser(username); relay.revoked.push(username); },
};

// The pages are told to ask the relay server on this machine for their own
// address too (it answers STUN as well), in place of Cloudflare's public STUN
// server, so that no browser here asks anyone outside for anything.
const env = { ICE_SERVERS: JSON.stringify([{ urls: `stun:127.0.0.1:${turnPort}` }]) };
const srv = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '', env, relay });
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const step = (s) => console.log(`- ${s}`);
const until = async (check, what, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// Runs in each page before its own scripts: keeps hold of the video
// connections the page makes, so the test can ask the browser how each one is
// really connected.
const watchPeers = () => {
  const Real = window.RTCPeerConnection;
  window.peersMade = [];
  window.RTCPeerConnection = class extends Real {
    constructor(...args) { super(...args); window.peersMade.push(this); }
  };
};
// Lets the test make this page's camera slow to start, as a tablet's can be,
// and keeps hold of what the camera gave, to check it was switched off again.
const slowCamera = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.cameraDelay = 0;
  window.camerasOpened = [];
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    await new Promise((resolve) => setTimeout(resolve, window.cameraDelay));
    const stream = await real(constraints);
    window.camerasOpened.push(stream);
    return stream;
  };
};
// Stands in for a network that lets nothing through directly (mobile data, an
// office): this page's connections can only ever go through a relay. The page
// itself does not know; it must find that out and ask for the relay.
const blockDirect = () => {
  const Real = window.RTCPeerConnection;
  window.peersMade = [];
  window.RTCPeerConnection = class extends Real {
    constructor(config = {}) { super({ ...config, iceTransportPolicy: 'relay' }); window.peersMade.push(this); }
    setConfiguration(config = {}) { return super.setConfiguration({ ...config, iceTransportPolicy: 'relay' }); }
  };
};
// The two ends of the connection the browser chose, e.g. { local: 'relay', remote: 'host' }.
const chosenPath = (page) => page.evaluate(async () => {
  const pc = window.peersMade.at(-1);
  const stats = await pc.getStats();
  let pair;
  stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
  if (!pair) return null;
  return { local: stats.get(pair.localCandidateId)?.candidateType, remote: stats.get(pair.remoteCandidateId)?.candidateType, state: pc.connectionState };
});
const pathLine = (page, text) => page.waitForFunction((t) => document.querySelector('#path')?.textContent === t, text, { timeout: 20_000 });

// ----- The new address -----
// A port nothing is listening on (it was free a moment ago).
const freeTcpPort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
// A Be There server whose new address is `canonical(port)`. The browser takes
// "localhost" and "127.0.0.1" for two different sites, though they are one
// server: here "localhost" is the old address and "127.0.0.1" the new one.
const noRelay = { ready: false, ttl: 0, mint: async () => ({ ok: false, reason: 'not_set_up' }), revoke: async () => {} };
const extras = [];      // more servers to stop at the end
const serverWithNewAddress = async (canonical) => {
  const port = await freeTcpPort();
  const canonicalOrigin = canonical(port);
  const store = createStore(':memory:');
  const server = await startServer({ port, store, setupPassword: '', env, relay: noRelay, canonicalOrigin, canonicalAllow: [canonicalOrigin] });
  extras.push(() => server.close());
  return { server, store, old: server.url, canonicalOrigin };
};
const originOf = (page) => new URL(page.url()).origin;
// What this browser remembers at one address: read from a page there that
// runs no script of ours.
const rememberedAt = async (ctx, origin, key) => {
  const page = await ctx.newPage();
  await page.goto(`${origin}/healthz`);
  const value = await page.evaluate((k) => localStorage.getItem(k), key);
  await page.close();
  return value;
};

let failure = null;
try {
  // The organizer sets up a home through the real setup page.
  const org = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await org.goto(`${srv.url}/setup`);
  await org.fill('input[name=personName]', 'Mary');
  await org.fill('input[name=start]', '00:00');
  await org.fill('input[name=end]', '23:59');
  await org.click('button[type=submit]');
  await org.waitForSelector('#done:not([hidden])');
  const homeLink = await org.textContent('#home-link');
  const orgLink = await org.textContent('#org-link');
  await snap(org, '1-setup-done');
  step('set up a home');

  // The organizer invites Sarah.
  await org.goto(orgLink);
  await org.waitForSelector('#content:not([hidden])');
  await org.fill('#invite input[name=name]', 'Sarah');
  await org.fill('#invite input[name=relation]', 'Granddaughter');
  await org.click('#invite button[type=submit]');
  await org.waitForSelector('#new-link:not([hidden])');
  const visitLink = await org.textContent('#new-url');
  assert.equal(await org.getAttribute('#new-open', 'href'), visitLink, '“Open it on this phone” opens the full link');
  // This server has no new address: links are for the address the page is at,
  // and nothing is said about moving.
  assert.ok(visitLink.startsWith(`${srv.url}/visit#`));
  assert.ok(homeLink.startsWith(`${srv.url}/home#`));
  assert.equal(await org.isVisible('#moved-note'), false);
  assert.match(await org.innerText('.tips'), /Keeping the tablet ready/);
  await snap(org, '2-organizer');
  step('invited Sarah');

  // The home screen (a tablet in landscape).
  const homeCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera', 'microphone'] });
  await homeCtx.addInitScript(watchPeers);
  await homeCtx.addInitScript(slowCamera);
  const home = await homeCtx.newPage();
  await home.goto(homeLink);
  // The screen connects without a tap: the organizer sees it is on.
  await org.reload();
  await org.waitForFunction(() => document.querySelector('#online')?.textContent === 'Home screen is on');
  await home.click('#start');
  await home.waitForSelector('.person.pending');
  await snap(home, '3-home-asks-mary');
  step('home screen shows Sarah waiting for a yes');

  // Sarah's phone.
  const visitCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  await visitCtx.addInitScript(watchPeers);
  const visit = await visitCtx.newPage();
  await visit.goto(visitLink);
  await visit.waitForFunction(() => document.querySelector('#state')?.textContent.includes('Waiting for them'));
  assert.equal(await visit.isDisabled('#visit'), true, 'Sarah cannot visit before Mary says yes');
  step('Sarah cannot visit yet');

  // Mary says yes.
  await home.click('.person.pending .btn.yes');
  await visit.waitForFunction(() => !document.querySelector('#visit').disabled);
  await snap(home, '4-home-idle');
  await snap(visit, '5-visitor-lobby');
  step('Mary said yes');

  // Sarah knocks; Mary answers.
  await visit.click('#visit');
  await home.waitForSelector('#knock:not([hidden])');
  assert.match(await home.textContent('#knock-title'), /Sarah is here to see you/);
  await snap(home, '6-home-knock');
  await home.click('#answer');
  step('Sarah knocked and Mary answered');

  // Both see and hear each other: video frames arrive on both sides.
  const hasVideo = (page) => page.waitForFunction(() => {
    const v = document.querySelector('#remote');
    return v && v.videoWidth > 0 && v.readyState >= 2 && v.srcObject?.getAudioTracks().length > 0;
  }, null, { timeout: 20_000 });
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  assert.match(await home.textContent('#with-you-text'), /Sarah is with you/);
  await home.waitForTimeout(800);
  await snap(home, '7-home-in-visit');
  await snap(visit, '8-visitor-in-visit');
  step('video and sound flow both ways; the home screen shows who is there');

  // Sarah's page says, in one small line, that the visit went directly. The
  // home screen says nothing about how it is connected.
  await pathLine(visit, 'Connected directly.');
  const stunUsed = await visit.evaluate(() => window.peersMade.at(-1).getConfiguration().iceServers.flatMap((s) => s.urls));
  assert.deepEqual(stunUsed, [`stun:127.0.0.1:${turnPort}`], 'a direct visit is given public STUN only, here the one on this machine');
  assert.notEqual((await chosenPath(visit)).local, 'relay');
  assert.notEqual((await chosenPath(home)).local, 'relay');
  assert.doesNotMatch(await home.innerText('body'), /relay|directly|connect/i);
  assert.equal(await home.locator('#path').count(), 0);
  await snap(visit, '8b-visitor-connected-directly');
  step('the visitor page says “Connected directly.”');

  // Mary ends the visit; Sarah is told.
  await home.click('#end');
  await visit.waitForSelector('#lobby:not([hidden])');
  assert.match(await visit.textContent('#hint'), /ended/);
  assert.equal(await home.isVisible('#call'), false);
  // The camera is released on the home screen when the visit ends.
  assert.equal(await home.evaluate(() => document.querySelector('#local').srcObject), null);
  step('Mary ended the visit');

  // Sarah knocks again and gives up just as Mary answers, while the tablet's
  // camera is still starting. No visit is left on the home screen (it would
  // show Sarah as being there, and later end someone else's knock), and the
  // camera does not stay on.
  const linksBefore = await home.evaluate(() => window.peersMade.length);
  const camerasBefore = await home.evaluate(() => window.camerasOpened.length);
  await home.evaluate(() => { window.cameraDelay = 1500; });
  await visit.click('#visit');
  await home.waitForSelector('#knock:not([hidden])');
  await home.click('#answer');
  await visit.click('#cancel');
  await home.waitForFunction((n) => window.camerasOpened.length > n, camerasBefore);
  await home.waitForTimeout(500);
  assert.equal(await home.isVisible('#call'), false, 'no visit is shown on the home screen');
  assert.equal(await home.isVisible('#idle'), true);
  assert.equal(await home.evaluate(() => window.camerasOpened.at(-1).getTracks().every((t) => t.readyState === 'ended')), true, 'the camera was switched off again');
  assert.equal(await home.evaluate(() => window.peersMade.length), linksBefore, 'no video link was made');
  await home.evaluate(() => { window.cameraDelay = 0; });
  step('a knock given up while the home camera was starting leaves no visit behind');

  // Drop-in: Mary lets Sarah come straight in; Mary still gets notice.
  await home.click('.person .btn.toggle');
  await visit.waitForFunction(() => document.querySelector('#visit').textContent === 'Visit now');
  await visit.click('#visit');
  await home.waitForSelector('#knock:not([hidden])');
  assert.match(await home.textContent('#knock-title'), /Sarah is coming in/);
  await snap(home, '9-home-dropin-notice');
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  step('drop-in connected after the notice');
  await home.click('#end');
  await visit.waitForSelector('#lobby:not([hidden])');
  // Two visits that connected directly: the relay was never asked for.
  assert.deepEqual(relay.minted, [], 'direct visits make no relay credentials');
  step('direct visits never touched the relay');

  // ----- The relay -----
  // From here Sarah may come straight in, so each visit starts with Mary's
  // notice; she taps "Let them in now" rather than wait for it to run out.
  const startVisit = async (page) => {
    await page.waitForFunction(() => { const b = document.querySelector('#visit'); return b && !b.hidden && !b.disabled; });
    await page.click('#visit');
    await home.waitForSelector('#knock:not([hidden])');
    await home.click('#answer');
  };

  // The organizer page says the relay is ready, and can test it without a visit.
  await org.reload();
  await org.waitForFunction(() => document.querySelector('#relay-state')?.textContent === 'Relay: ready');
  await org.click('#relay-test');
  await org.waitForFunction(() => document.querySelector('#relay-result').textContent === 'The relay works.');
  assert.deepEqual(relay.revoked, relay.minted, 'the test’s credentials were revoked straight away');
  assert.equal(relay.minted.length, 1);
  await org.locator('#relay-test').scrollIntoViewIfNeeded();
  await snapAll(org, '10-organizer-relay-ready');
  step('organizer: “Relay: ready”, and “The relay works.”');

  // "?relay=1" on the visitor's link sends the visit through the relay from the start.
  await visit.goto(visitLink.replace('/visit#', '/visit?relay=1#'));
  await startVisit(visit);
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  await pathLine(visit, 'Connected through the relay.');
  const forced = await chosenPath(visit);
  assert.equal(forced.local, 'relay', 'the browser confirms the visitor is connected through the relay');
  assert.equal(await visit.evaluate(() => window.peersMade.at(-1).getConfiguration().iceTransportPolicy), 'relay');
  await until(async () => { const p = await chosenPath(home); return p.local === 'relay' || p.remote === 'relay'; }, 'the home screen to see the relay too');
  assert.equal(relay.minted.length, 2, 'one set of credentials for this visit');
  assert.equal(relay.revoked.length, 1, 'and they work for as long as the visit lasts');
  assert.doesNotMatch(await home.innerText('body'), /relay|directly|connect/i);
  await snapAll(visit, '11-visitor-through-relay');
  await snap(home, '12-home-during-relayed-visit');
  await visit.click('#end');
  await home.waitForSelector('#idle:not([hidden])');
  await until(() => relay.revoked.length === 2, 'the visit’s credentials to be revoked');
  assert.deepEqual(relay.revoked, relay.minted);
  step('“?relay=1”: connected through the relay; credentials revoked when the visit ended');

  // A phone on a network that blocks direct connections. Nothing tells the
  // page: the visit simply does not connect, and after about 5 seconds the
  // page asks for the relay and connects through it.
  await visit.close();
  const strictCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  await strictCtx.addInitScript(blockDirect);
  const strict = await strictCtx.newPage();
  await strict.goto(visitLink);
  await startVisit(strict);
  const answeredAt = Date.now();
  await pathLine(strict, 'Connecting…');
  await strict.waitForTimeout(3000);
  assert.equal(relay.minted.length, 2, 'for the first seconds only a direct connection is tried');
  assert.notEqual((await chosenPath(strict))?.state, 'connected');
  await snap(strict, '13-visitor-connecting');
  await until(() => relay.minted.length === 3, 'the relay to be asked for');
  const askedAfter = Date.now() - answeredAt;
  assert.ok(askedAfter > 4000 && askedAfter < 9000, `asked for the relay after about 5 seconds (${askedAfter} ms)`);
  await Promise.all([hasVideo(home), hasVideo(strict)]);
  await pathLine(strict, 'Connected through the relay.');
  assert.equal((await chosenPath(strict)).local, 'relay');
  assert.equal(relay.minted.length, 3, 'asked for once, though both devices noticed');
  assert.match(await home.textContent('#with-you-text'), /Sarah is with you/);
  // Mary ends it; the credentials stop working.
  await home.click('#end');
  await strict.waitForSelector('#lobby:not([hidden])');
  await until(() => relay.revoked.length === 3, 'the visit’s credentials to be revoked');
  step(`a blocked network: the relay was asked for after ${(askedAfter / 1000).toFixed(1)} s and the visit connected through it`);

  // The same phone when the relay cannot be reached either: after 30 seconds
  // both sides are told plainly, and the home screen goes back to its clock.
  relay.down = true;
  await startVisit(strict);
  const startedAt = Date.now();
  await strict.waitForFunction(() => document.querySelector('#hint')?.textContent === 'The video couldn’t connect. Please try again in a moment.', null, { timeout: 45_000 });
  const gaveUpAfter = Date.now() - startedAt;
  assert.ok(gaveUpAfter > 25_000 && gaveUpAfter < 40_000, `gave up after about 30 seconds (${gaveUpAfter} ms)`);
  assert.equal(await strict.isVisible('#call'), false);
  await home.waitForFunction(() => !document.querySelector('#note').hidden);
  assert.equal(await home.textContent('#note'), 'The last visit couldn’t connect.');
  assert.equal(await home.isVisible('#call'), false);
  assert.equal(await home.isVisible('#idle'), true);
  assert.equal(await home.evaluate(() => document.querySelector('#local').srcObject), null, 'the camera is released');
  assert.equal(relay.minted.length, 3);
  await snapAll(home, '14-home-could-not-connect');
  await snapAll(strict, '15-visitor-could-not-connect');
  relay.down = false;
  step(`no way through: both sides were told after ${Math.round(gaveUpAfter / 1000)} s`);

  // The next knock clears the line on the home screen, and visits work again.
  await startVisit(strict);
  assert.equal(await home.isVisible('#note'), false);
  await Promise.all([hasVideo(home), hasVideo(strict)]);
  await home.click('#end');
  await strict.waitForSelector('#lobby:not([hidden])');
  await until(() => relay.revoked.length === relay.minted.length, 'every credential to be revoked');
  assert.equal(relay.minted.length, 4);
  await strictCtx.close();
  step('the next visit connected, and every relay credential made was revoked');

  // Without a relay the organizer page says so in plain words.
  relay.ready = false;
  await org.reload();
  await org.waitForFunction(() => document.querySelector('#relay-state')?.textContent.startsWith('Relay: not set up'));
  await org.click('#relay-test');
  await org.waitForFunction(() => document.querySelector('#relay-result').textContent.includes('not set up'));
  await org.locator('#relay-test').scrollIntoViewIfNeeded();
  await snapAll(org, '16-organizer-relay-off');
  relay.ready = true;
  step('organizer: “Relay: not set up” when there is no relay');

  // Sarah's own phone again, on its ordinary link.
  const visit2 = await visitCtx.newPage();
  await visit2.goto(visitLink);
  await visit2.waitForFunction(() => !document.querySelector('#visit').disabled);

  // Mary pauses visits.
  await home.click('#pause');
  await visit2.waitForFunction(() => document.querySelector('#state').textContent.includes('paused'));
  assert.equal(await visit2.isDisabled('#visit'), true);
  step('pausing stops visits');

  // The visitor page remembers its link: opening /visit without the # part
  // on the same phone still works, and puts the link back in the address bar.
  await visit2.goto(`${srv.url}/visit`);
  await visit2.waitForFunction(() => document.querySelector('#title')?.textContent.includes('Visit Mary'));
  assert.equal(new URL(visit2.url()).hash, new URL(visitLink).hash);
  // A different phone without the link is told the code is missing, with no button.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`${srv.url}/visit`);
  await stranger.waitForFunction(() => document.querySelector('#title')?.textContent.includes('missing its key'));
  assert.equal(await stranger.isVisible('#visit'), false);
  step('visitor link is remembered on the phone; a bare link shows no button');

  // ----- The new address -----
  const hasVideoOn = (...pages) => Promise.all(pages.map(hasVideo));
  const moved = await serverWithNewAddress((port) => `http://127.0.0.1:${port}`);
  const OLD = moved.old;
  const NEW = moved.canonicalOrigin;
  assert.notEqual(OLD, NEW);
  const arrives = (page, check) => page.waitForURL((url) => url.origin === NEW && check(url), { timeout: 10_000 });

  // Setting up from the old address: the page goes to the new one first, and
  // the links it makes are for the new one.
  const family = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const setup2 = await family.newPage();
  await setup2.goto(`${OLD}/setup`, { waitUntil: 'commit' });
  await arrives(setup2, (url) => url.pathname === '/setup');
  await setup2.fill('input[name=personName]', 'Rose');
  await setup2.fill('input[name=start]', '00:00');
  await setup2.fill('input[name=end]', '23:59');
  await setup2.click('button[type=submit]');
  await setup2.waitForSelector('#done:not([hidden])');
  const roseHomeLink = await setup2.textContent('#home-link');
  const roseOrgLink = await setup2.textContent('#org-link');
  assert.ok(roseHomeLink.startsWith(`${NEW}/home#`), 'the home screen link is for the new address');
  assert.ok(roseOrgLink.startsWith(`${NEW}/organize#`));
  assert.equal(await setup2.getAttribute('#org-open', 'href'), roseOrgLink);
  assert.match(await setup2.innerText('#done'), /Keeping the tablet ready/);
  assert.match(await setup2.innerText('#done'), /Auto-Lock to Never/);
  await snapAll(setup2, '17-setup-done-tablet-tips', '#done .link-box >> nth=1');
  step('new address: the setup page moved there, and its links point there');

  // The organizer's bookmark is for the old address. The page moves, with its
  // link, and says how the home screen can be moved.
  const org2 = await family.newPage();
  org2.on('dialog', (dialog) => dialog.accept());
  const orgSecret = new URL(roseOrgLink).hash;
  await org2.goto(`${OLD}/organize${orgSecret}`, { waitUntil: 'commit' });
  await arrives(org2, (url) => url.pathname === '/organize' && url.hash === orgSecret);
  await org2.waitForSelector('#content:not([hidden])');
  assert.equal(await org2.textContent('#title'), 'Rose’s home');
  assert.equal(await org2.isVisible('#moved-note'), true);
  assert.equal(await org2.textContent('#moved-note'), `Be There now lives at ${new URL(NEW).host}. The home screen keeps working where it is. To move it, make a new home screen link here and open it on the tablet when someone is with them; it will ask to use the camera and microphone once more.`);
  assert.match(await org2.innerText('.tips'), /Keeping the tablet ready/);
  await org2.fill('#invite input[name=name]', 'Tom');
  await org2.click('#invite button[type=submit]');
  await org2.waitForSelector('#new-link:not([hidden])');
  const tomLink = await org2.textContent('#new-url');
  assert.ok(tomLink.startsWith(`${NEW}/visit#`), 'a visitor link made now is for the new address');
  assert.equal(await org2.getAttribute('#new-open', 'href'), tomLink);
  const tomSecret = new URL(tomLink).hash;
  await snapAll(org2, '18-organizer-links-new-address', '#moved-note');
  step('new address: the organizer page moved with its link; its new links point there');

  // The home screen is opened at the old address, as the tablet has it today.
  // It stays there, and it does not so much as look at the new address.
  const tabletCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera', 'microphone'] });
  await tabletCtx.addInitScript(watchPeers);
  const tablet = await tabletCtx.newPage();
  const tabletAsked = [];
  tablet.on('request', (request) => tabletAsked.push(request.url()));
  tablet.on('websocket', (socket) => tabletAsked.push(socket.url()));
  const roseHomeSecret = new URL(roseHomeLink).hash;
  await tablet.goto(`${OLD}/home${roseHomeSecret}`);
  await tablet.waitForFunction(() => document.querySelector('#status')?.textContent === 'Visits are open');
  await tablet.click('#start');
  await tablet.waitForSelector('.person.pending');
  await tablet.waitForTimeout(1500);
  assert.equal(originOf(tablet), OLD, 'the home screen is still at the old address');
  assert.equal(new URL(tablet.url()).hash, roseHomeSecret);
  assert.ok(tabletAsked.length > 5);
  assert.deepEqual(tabletAsked.filter((url) => !url.startsWith(`${OLD}/`) && !url.startsWith(`${OLD.replace('http', 'ws')}/`)), [], 'everything the home screen asked for was at the old address');
  assert.ok(!tabletAsked.some((url) => url.includes('moved.js')), 'the home screen does not load the script that moves pages');
  await org2.reload();
  await org2.waitForFunction(() => document.querySelector('#online')?.textContent === 'Home screen is on');
  assert.equal(originOf(org2), NEW);
  step('new address: the home screen stayed at the old address and is on');

  // Tom opens his link at the old address, with its # part. His page moves to
  // the new address with the same secret, and connects there.
  const tomCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  await tomCtx.addInitScript(watchPeers);
  const tom = await tomCtx.newPage();
  await tom.goto(`${OLD}/visit${tomSecret}`, { waitUntil: 'commit' });
  await arrives(tom, (url) => url.pathname === '/visit' && url.hash === tomSecret);
  await tom.waitForFunction(() => document.querySelector('#state')?.textContent.includes('Waiting for them'));
  assert.equal(tom.url(), `${NEW}/visit${tomSecret}`);
  // Both addresses now remember the link on this phone: the old one was not cleared.
  assert.equal(await rememberedAt(tomCtx, NEW, 'bethere.visit'), tomSecret.slice(1));
  assert.equal(await rememberedAt(tomCtx, OLD, 'bethere.visit'), tomSecret.slice(1));
  step('new address: a visitor link opened at the old address arrived with its secret');

  // Rose says yes on her screen (old address); Tom (new address) knocks, and
  // they see each other: it is one server behind both names.
  await tablet.click('.person.pending .btn.yes');
  await tom.waitForFunction(() => !document.querySelector('#visit').disabled);
  await tom.click('#visit');
  await tablet.waitForSelector('#knock:not([hidden])');
  assert.match(await tablet.textContent('#knock-title'), /Tom is here to see you/);
  await tablet.click('#answer');
  await hasVideoOn(tablet, tom);
  assert.match(await tablet.textContent('#with-you-text'), /Tom is with you/);
  assert.equal(originOf(tablet), OLD);
  assert.equal(originOf(tom), NEW);
  await tablet.click('#end');
  await tom.waitForSelector('#lobby:not([hidden])');
  step('new address: a visit between a home screen at the old address and a visitor at the new one');

  // A phone that only remembers the link at the old address (a bookmark
  // without the # part): it arrives at the new address with the secret too.
  const bookmarkCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const seed = await bookmarkCtx.newPage();
  await seed.goto(`${OLD}/healthz`);
  await seed.evaluate((secret) => localStorage.setItem('bethere.visit', secret), tomSecret.slice(1));
  await seed.close();
  assert.equal(await rememberedAt(bookmarkCtx, NEW, 'bethere.visit'), null, 'the new address knows nothing of this phone yet');
  const bookmark = await bookmarkCtx.newPage();
  await bookmark.goto(`${OLD}/visit`, { waitUntil: 'commit' });
  await arrives(bookmark, (url) => url.pathname === '/visit' && url.hash === tomSecret);
  await bookmark.waitForFunction(() => document.querySelector('#title')?.textContent === 'Visit Rose');
  assert.equal(await rememberedAt(bookmarkCtx, OLD, 'bethere.visit'), tomSecret.slice(1));
  // What a link has before its # is kept as well ("?relay=1" tests the relay).
  await bookmark.goto(`${OLD}/visit?relay=1${tomSecret}`, { waitUntil: 'commit' });
  await arrives(bookmark, (url) => url.pathname === '/visit' && url.search === '?relay=1' && url.hash === tomSecret);
  // A phone with no link at all moves too, and is told the same as before.
  const nobody = await (await browser.newContext()).newPage();
  await nobody.goto(`${OLD}/visit`, { waitUntil: 'commit' });
  await arrives(nobody, (url) => url.pathname === '/visit' && url.hash === '');
  await nobody.waitForFunction(() => document.querySelector('#title')?.textContent.includes('missing its key'));
  await bookmarkCtx.close();
  step('new address: a remembered link without its # arrived with its secret');

  // Moving the home screen is done by the family: a new home screen link from
  // the organizer page, opened on the tablet.
  await org2.click('#new-home-link');
  await org2.waitForSelector('#home-link-box:not([hidden])');
  const movedHomeLink = await org2.textContent('#home-url');
  assert.ok(movedHomeLink.startsWith(`${NEW}/home#`), 'the new home screen link is for the new address');
  await tablet.waitForFunction(() => !document.querySelector('#problem').hidden);
  assert.equal(originOf(tablet), OLD, 'the old home screen says its link no longer works; it does not move');
  await tablet.goto(movedHomeLink);
  await tablet.waitForFunction(() => document.querySelector('#status')?.textContent === 'Visits are open');
  await tablet.click('#start');
  assert.equal(originOf(tablet), NEW);
  await tom.waitForFunction(() => { const b = document.querySelector('#visit'); return b && !b.hidden && !b.disabled; });
  await tom.click('#visit');
  await tablet.waitForSelector('#knock:not([hidden])');
  await tablet.click('#answer');
  await hasVideoOn(tablet, tom);
  await tom.click('#end');
  await tablet.waitForSelector('#idle:not([hidden])');
  // The organizer's own link, made again, is for the new address as well.
  await org2.click('#new-org-link');
  await org2.waitForSelector('#org-link-box:not([hidden])');
  const newOrgLink = await org2.textContent('#org-url');
  assert.ok(newOrgLink.startsWith(`${NEW}/organize#`));
  assert.equal(org2.url(), newOrgLink);
  await tabletCtx.close();
  await tomCtx.close();
  await family.close();
  step('new address: the home screen moved when its new link was opened on the tablet, and a visit worked there');

  // ----- When the new address does not answer -----
  // Its name leads nowhere: once to a port browsers will not talk to at all,
  // once to a port where nothing listens. Every page stays where it is and
  // works as before.
  const away = await serverWithNewAddress(() => 'http://127.0.0.1:9');
  const closedPort = await freeTcpPort();
  const shut = await serverWithNewAddress(() => `http://127.0.0.1:${closedPort}`);
  for (const [name, world] of [['a port browsers refuse to talk to', away], ['a port where nothing listens', shut]]) {
    const HERE = world.old;
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 820 }, permissions: ['camera', 'microphone'] });
    const setup3 = await ctx.newPage();
    await setup3.goto(`${HERE}/setup`);
    await setup3.fill('input[name=personName]', 'Ann');
    await setup3.fill('input[name=start]', '00:00');
    await setup3.fill('input[name=end]', '23:59');
    await setup3.click('button[type=submit]');
    await setup3.waitForSelector('#done:not([hidden])');
    assert.equal(originOf(setup3), HERE, `${name}: the setup page stayed`);
    // Links are for the new address from the day it is switched on, whether
    // or not this page could reach it just now.
    const annHome = new URL(await setup3.textContent('#home-link'));
    const annOrg = new URL(await setup3.textContent('#org-link'));
    assert.equal(annHome.origin, world.canonicalOrigin);
    assert.equal(annOrg.origin, world.canonicalOrigin);

    const org3 = await ctx.newPage();
    await org3.goto(`${HERE}/organize${annOrg.hash}`);
    await org3.waitForSelector('#content:not([hidden])');
    assert.equal(await org3.textContent('#title'), 'Ann’s home');
    assert.equal(originOf(org3), HERE, `${name}: the organizer page stayed`);
    assert.equal(new URL(org3.url()).hash, annOrg.hash);
    await org3.fill('#invite input[name=name]', 'Ben');
    await org3.click('#invite button[type=submit]');
    await org3.waitForSelector('#new-link:not([hidden])');
    const benLink = new URL(await org3.textContent('#new-url'));
    assert.equal(benLink.origin, world.canonicalOrigin);
    assert.equal(await org3.isVisible('#moved-note'), true);
    const benSecret = benLink.hash;

    const home3 = await ctx.newPage();
    await home3.goto(`${HERE}/home${annHome.hash}`);
    await home3.waitForSelector('.person.pending');
    await home3.click('#start');
    await home3.click('.person.pending .btn.yes');
    assert.equal(originOf(home3), HERE, `${name}: the home screen stayed`);

    const ben = await ctx.newPage();
    await ben.goto(`${HERE}/visit${benSecret}`);
    await ben.waitForFunction(() => { const b = document.querySelector('#visit'); return b && !b.hidden && !b.disabled; });
    assert.equal(ben.url(), `${HERE}/visit${benSecret}`, `${name}: the visitor page stayed, with its link`);
    await ben.click('#visit');
    await home3.waitForSelector('#knock:not([hidden])');
    await home3.click('#answer');
    await hasVideoOn(home3, ben);
    await ben.click('#end');
    await home3.waitForSelector('#idle:not([hidden])');
    for (const page of [setup3, org3, home3, ben]) assert.equal(originOf(page), HERE);
    await ctx.close();
  }
  step('new address not answering: every page stayed where it was, and a visit worked');

  // Two more ways the new address can be wrong, seen from the visitor's page:
  // a host that accepts the connection and then says nothing, and one that
  // serves web pages but has no live connection for visits. The page stays in
  // both cases, and the link's secret is never sent to that host.
  const heard = { silent: '', pagesOnly: '' };
  const held = new Set();
  const silent = net.createServer((socket) => {
    held.add(socket);
    socket.on('data', (chunk) => { heard.silent += chunk; });
    socket.on('error', () => {});
    socket.on('close', () => held.delete(socket));
  });
  const pagesOnly = http.createServer((req, res) => {
    heard.pagesOnly += `${req.method} ${req.url}\n`;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end('{"ok":true}');
  });
  pagesOnly.on('upgrade', (req, socket) => { heard.pagesOnly += `UPGRADE ${req.url}\n`; socket.destroy(); });
  for (const other of [silent, pagesOnly]) {
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    extras.push(() => new Promise((resolve) => { for (const socket of held) socket.destroy(); other.closeAllConnections?.(); other.close(resolve); }));
  }
  for (const [name, other, least, most] of [['silent', silent, 3500, 9000], ['pagesOnly', pagesOnly, 0, 3500]]) {
    const world = await serverWithNewAddress(() => `http://127.0.0.1:${other.address().port}`);
    const { home: annHome } = world.store.createHome({ personName: 'Ann', hours: { start: '00:00', end: '00:00' } });
    const { token } = world.store.addVisitor(annHome, { name: 'Ben' });
    const page = await (await browser.newContext()).newPage();
    const began = Date.now();
    await page.goto(`${world.old}/visit#${token}`);
    await page.waitForFunction(() => document.querySelector('#state')?.textContent.includes('Waiting for them'), null, { timeout: 15_000 });
    const took = Date.now() - began;
    assert.equal(page.url(), `${world.old}/visit#${token}`, `${name}: the page stayed, with its link`);
    assert.ok(took >= least && took <= most, `${name}: the page was ready after ${took} ms`);
    assert.doesNotMatch(heard[name], new RegExp(token), `${name}: the secret never reached the other host`);
    await page.context().close();
  }
  // All either host ever heard was the knock on the door for visits.
  assert.match(heard.silent, /^GET \/ws HTTP\/1\.1\r\n/);
  assert.equal(heard.pagesOnly, 'UPGRADE /ws\n');
  step('new address answering wrongly (silent, or pages only): the visitor page stayed after a short wait');

  console.log('E2E passed');
} catch (err) {
  failure = err;
  console.error(err);
} finally {
  await browser.close();
  await srv.close();
  for (const stop of extras) await stop().catch(() => {});
  turn.stop();
}
// The little relay server keeps timers of its own running for some minutes
// after a visit; don't wait for them.
process.exit(failure ? 1 : 0);
