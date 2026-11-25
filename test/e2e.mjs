// A real visit in two browsers with fake cameras: the home screen and a
// visitor. Run with `npm run e2e` (needs Playwright and Chromium installed).
// Set SHOTS=<folder> to save screenshots along the way.
//
// It also checks the relay, with a small relay server of our own on this
// machine (node-turn) standing in for Cloudflare's: nothing here leaves the
// machine. It takes about a minute, half of it waiting for a visit that is
// meant not to connect.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
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
// The same screen at tablet and phone size, in light and dark.
const SIZES = { tablet: { width: 1180, height: 820 }, phone: { width: 390, height: 844 } };
const snapAll = async (page, name) => {
  if (!shots) return;
  const was = page.viewportSize();
  for (const [size, viewport] of Object.entries(SIZES)) {
    for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
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

const srv = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '', env: {}, relay });
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
  await snap(org, '2-organizer');
  step('invited Sarah');

  // The home screen (a tablet in landscape).
  const homeCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera', 'microphone'] });
  await homeCtx.addInitScript(watchPeers);
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

  console.log('E2E passed');
} catch (err) {
  failure = err;
  console.error(err);
} finally {
  await browser.close();
  await srv.close();
  turn.stop();
}
// The little relay server keeps timers of its own running for some minutes
// after a visit; don't wait for them.
process.exit(failure ? 1 : 0);
