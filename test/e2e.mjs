// A real visit in two browsers with fake cameras: the home screen and a
// visitor. Run with `npm run e2e` (needs Playwright and Chromium installed).
// Set SHOTS=<folder> to save screenshots along the way.
//
// It also checks the relay, with a small relay server of our own on this
// machine (node-turn) standing in for Cloudflare's: nothing here leaves the
// machine. Then the new address: one server reached by two names, as the real
// one is, and pages that move from the old name to the new one (or stay).
// Along the way, visitors' photos: the organizer adds, changes and removes
// one, the home screen shows it on the list, at the door and during the
// visit, and every request the home screen makes for a photo is counted.
// And live captions, when the files for them are on this machine (`npm run
// captions:fetch`): the visitor's browser is given a recording of clear speech
// as its microphone, captions are switched on at the home screen, and the
// words must appear there, on the tablet alone: everything the home screen
// sends during that visit is recorded and searched for them.
// It takes about two and a half minutes, part of it waiting for a visit that
// is meant not to connect.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import { createStore } from '../lib/store.js';
import { inspectJpeg } from '../lib/jpeg.js';
import { CAPTIONS_FILES, CAPTIONS_VERSION, captionsDirFrom, captionsStatus } from '../lib/captions-files.js';
import { parseWav, resample } from '../public/js/caption-text.js';

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

// ----- Captions -----
// Tried only when the files they need are on this machine, fetched and
// verified. The visitor's "microphone" is then a recording of clear speech
// (the sample that comes with the captions files: President Kennedy, 1961),
// which Chromium plays round and round. It wants a 48 kHz, one-channel,
// 16-bit WAV, made here in a folder of its own outside the repository.
const captionsDir = captionsDirFrom(process.env, { cwd: fileURLToPath(new URL('..', import.meta.url)) });
const captionsHere = captionsStatus(captionsDir) === 'ready';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'be-there-e2e-'));
function wavFile(file, samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), 44 + i * 2));
  fs.writeFileSync(file, out);
  return file;
}
let speech = null;
if (captionsHere) {
  const sample = parseWav(fs.readFileSync(path.join(captionsDir, 'jfk.wav')));
  speech = wavFile(path.join(scratch, 'speech-48k-mono.wav'), resample(sample.samples, sample.rate, 48_000), 48_000);
}

// The pages are told to ask the relay server on this machine for their own
// address too (it answers STUN as well), in place of Cloudflare's public STUN
// server, so that no browser here asks anyone outside for anything.
const env = { ICE_SERVERS: JSON.stringify([{ urls: `stun:127.0.0.1:${turnPort}` }]) };
const srv = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '', env, relay, captions: captionsHere ? { dir: captionsDir } : { off: true } });
// Every request that reaches this server, from any page, in the order it came.
const reached = [];
srv.server.on('request', (req) => reached.push(`${req.method} ${req.url}`));
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(speech ? [`--use-file-for-fake-audio-capture=${speech}`] : [])] });
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

// ----- Photos -----
// A picture for the organizer to pick, made here (nothing a camera took): a
// PNG wider than it is tall. Its middle square is teal on the left and orange
// on the right, with a face-coloured disc; the strips to the left and right
// of the square are magenta, and must be cut away. (The second photo, below,
// is taller than wide: between them both ways of cutting are tried.)
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(width, height, colourAt) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set(colourAt(x, y), y * (1 + width * 3) + 1 + x * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TEAL = [20, 140, 150];
const ORANGE = [235, 140, 30];
const MAGENTA = [230, 0, 230];
const firstPhoto = png(800, 600, (x, y) => {
  if (x < 100 || x >= 700) return MAGENTA;
  if ((x - 400) ** 2 + (y - 300) ** 2 < 150 ** 2) return [240, 200, 170];
  return x < 400 ? TEAL : ORANGE;
});
// The second photo is a file as a phone held upright makes it: stored on its
// side, with a note beside the picture saying which way up it goes. Upright,
// its corners are red, green, blue and yellow.
const sidewaysPhoto = fileURLToPath(new URL('./fixtures/sideways-320x240.jpg', import.meta.url));
const UPRIGHT = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 45);
// The picture an avatar on the page is showing: its size, where it comes
// from, and the colours of its four corners. Null if it shows none.
const faceIn = (page, selector) => page.evaluate((sel) => {
  const img = document.querySelector(`${sel} img`);
  if (!img || !img.complete || !img.naturalWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
  const w = canvas.width;
  const h = canvas.height;
  const shown = img.getBoundingClientRect();
  return { width: w, height: h, src: img.src, alt: img.getAttribute('alt'), shown: [Math.round(shown.width), Math.round(shown.height)], corners: [at(8, 8), at(w - 9, 8), at(8, h - 9), at(w - 9, h - 9)] };
}, selector);
const waitForFace = async (page, selector, not = '') => {
  await page.waitForFunction(([sel, old]) => { const img = document.querySelector(`${sel} img`); return img && img.complete && img.naturalWidth > 0 && img.src !== old; }, [selector, not]);
  return faceIn(page, selector);
};
// What an avatar shows when it has no photo: the initials, and no picture.
const initialsIn = (page, selector) => page.evaluate((sel) => { const node = document.querySelector(sel); return node.querySelector('img') ? null : node.textContent; }, selector);
const isPhotoRequest = (request) => /^\/api\/.*\/photo$/.test(new URL(request.url()).pathname);

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
  const server = await startServer({ port, store, setupPassword: '', env, relay: noRelay, canonicalOrigin, canonicalAllow: [canonicalOrigin], captions: { off: true } });
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
  // Sarah has no photo yet: her initial, and one button to add one.
  assert.equal(await initialsIn(org, '#visitors li .avatar'), 'S');
  assert.deepEqual(await org.locator('#visitors .photo-tools button').allTextContents(), ['Add a photo']);
  await snapAll(org, '2b-organizer-row-without-photo', '#visitors');
  step('invited Sarah');

  // The home screen (a tablet in landscape).
  const homeCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera', 'microphone'] });
  await homeCtx.addInitScript(watchPeers);
  await homeCtx.addInitScript(slowCamera);
  const home = await homeCtx.newPage();
  // Every request the home screen makes for a photo, from its first moment
  // to the end of this run.
  const homePhotoRequests = [];
  home.on('request', (request) => { if (isPhotoRequest(request)) homePhotoRequests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  // And, for captions: everything the home screen sends to anyone, from its
  // first moment on. Every request (its own and its workers'), with what it
  // carried, and every message on its live connection to the server.
  const homeRequests = [];
  const homeFrames = [];
  homeCtx.on('request', (request) => homeRequests.push({ method: request.method(), url: request.url(), body: request.postData() || '' }));
  home.on('websocket', (socket) => socket.on('framesent', (frame) => homeFrames.push(String(frame.payload))));
  await home.goto(homeLink);
  // The screen connects without a tap: the organizer sees it is on.
  await org.reload();
  await org.waitForFunction(() => document.querySelector('#online')?.textContent === 'Home screen is on');
  await home.click('#start');
  await home.waitForSelector('.person.pending');
  await snap(home, '3-home-asks-mary');
  assert.equal(await initialsIn(home, '.person.pending .avatar'), 'S', 'no photo yet: her initial');
  assert.deepEqual(homePhotoRequests, []);
  step('home screen shows Sarah waiting for a yes');

  // The organizer adds a photo of Sarah: "Add a photo", then "Choose a photo".
  // Only a small square JPEG made on the organizer's own device is sent.
  // (The page's own fetch is watched from inside the page: the browser does
  // not show a test the bytes of a picture on their way out.)
  await org.evaluate(() => {
    const real = window.fetch;
    window.photosSent = [];
    window.fetch = (address, options) => {
      if (options?.method === 'PUT') window.photosSent.push({ address: String(address), type: options.headers['Content-Type'], body: options.body });
      return real(address, options);
    };
  });
  const photosSent = async () => (await org.evaluate(() => Promise.all(window.photosSent.map(async (sent) => ({ ...sent, body: Array.from(new Uint8Array(await sent.body.arrayBuffer())) })))))
    .map((sent) => ({ ...sent, body: Buffer.from(sent.body) }));
  await org.click('#visitors .photo-tools button:has-text("Add a photo")');
  assert.deepEqual(await org.locator('#visitors .photo-pick button').allTextContents(), ['Take a photo', 'Choose a photo', 'Cancel']);
  await snapAll(org, '2c-organizer-adding-a-photo', '#visitors');
  const [chooser] = await Promise.all([org.waitForEvent('filechooser'), org.click('#visitors .photo-pick button:has-text("Choose a photo")')]);
  await chooser.setFiles({ name: 'sarah.png', mimeType: 'image/png', buffer: firstPhoto });
  const inList = await waitForFace(org, '#visitors li .avatar');
  assert.equal(await org.textContent('#visitors .photo-note'), 'Photo saved. Mary will see it beside Sarah’s name.');
  assert.deepEqual(await org.locator('#visitors .photo-tools button').allTextContents(), ['Change photo', 'Remove photo']);
  assert.equal(await org.inputValue('#photo-choose'), '', 'the file input is cleared after each pick');
  let uploads = await photosSent();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].type, 'image/jpeg');
  assert.match(uploads[0].address, /^\/api\/organize\/visitors\/[\w-]+\/photo$/);
  const sent = inspectJpeg(uploads[0].body);
  assert.deepEqual([sent.ok, sent.width, sent.height, sent.orientation], [true, 384, 384, 1], 'what was sent is a 384 px square JPEG');
  assert.ok(uploads[0].body.length < 150 * 1024 && !uploads[0].body.equals(firstPhoto), 'and not the picture that was picked');
  // The middle square of the picture: teal left, orange right, none of the magenta strips.
  const isFirst = (face) => face.width === 384 && face.height === 384 && near(face.corners[0], TEAL) && near(face.corners[1], ORANGE) && near(face.corners[2], TEAL) && near(face.corners[3], ORANGE);
  assert.ok(isFirst(inList), JSON.stringify(inList));
  await snapAll(org, '2d-organizer-row-with-photo', '#visitors');
  step('the organizer added a photo of Sarah: a 384 px square cut from the middle was sent');

  // It shows on the home screen straight away, on the card that asks Mary
  // whether Sarah may visit, with her name beside it as before.
  const onCard = await waitForFace(home, '.person.pending .avatar');
  assert.ok(isFirst(onCard), JSON.stringify(onCard));
  assert.equal(onCard.alt, '', 'the name is beside it, so the picture has no text of its own');
  assert.match(onCard.src, /^blob:/);
  assert.deepEqual(onCard.shown, [64, 64]);
  assert.equal(await home.textContent('.person.pending .person-name'), 'Sarah');
  assert.equal(homePhotoRequests.length, 1, 'fetched once');
  assert.match(homePhotoRequests[0], /^GET \/api\/home\/visitors\/[\w-]+\/photo$/);
  await snapAll(home, '3b-home-approval-card-with-photo');
  step('the home screen shows the photo on the card that asks Mary');

  // Sarah's phone.
  const visitCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  await visitCtx.addInitScript(watchPeers);
  const visit = await visitCtx.newPage();
  // A visitor's page is given nothing about photos, and asks for nothing.
  const visitorPhotoRequests = [];
  visitCtx.on('request', (request) => { if (/photo/i.test(request.url())) visitorPhotoRequests.push(request.url()); });
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
  // At the door: her photo, large, the very one already in memory.
  const atDoor = await waitForFace(home, '#knock-avatar');
  assert.equal(atDoor.src, onCard.src);
  assert.ok(isFirst(atDoor));
  assert.deepEqual(atDoor.shown, [200, 200], 'large on a tablet this size');
  for (const button of ['#answer', '#decline']) assert.ok(await home.locator(button).isVisible());
  const lowest = await home.locator('#decline').boundingBox();
  assert.ok(lowest.y + lowest.height <= 820, 'the two big buttons still fit on the tablet');
  await snapAll(home, '6b-home-knock-with-photo');
  await home.click('#answer');
  step('Sarah knocked (her photo is at the door) and Mary answered');

  // Both see and hear each other: video frames arrive on both sides.
  const hasVideo = (page) => page.waitForFunction(() => {
    const v = document.querySelector('#remote');
    return v && v.videoWidth > 0 && v.readyState >= 2 && v.srcObject?.getAudioTracks().length > 0;
  }, null, { timeout: 20_000 });
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  assert.match(await home.textContent('#with-you-text'), /Sarah is with you/);
  // Captions are there to be switched on (when this server has them), and
  // off until Mary does: nothing is listening, and nothing has been fetched.
  // (The page's own captions script is loaded when the screen opens; what
  // counts here is the worker, the listener, and the model's files.)
  const captionsAsked = () => homeRequests.filter((r) => /captions-(files|code)\/|captions-worker|pcm-worklet/.test(r.url)).map((r) => r.url);
  assert.equal(await home.isVisible('#captions-toggle'), captionsHere);
  if (captionsHere) {
    assert.equal(await home.textContent('#captions-toggle'), 'Captions off');
    assert.equal(await home.getAttribute('#captions-toggle', 'aria-pressed'), 'false');
  }
  assert.equal(await home.isVisible('#captions'), false);
  assert.equal(home.workers().length, 0);
  assert.deepEqual(captionsAsked(), []);
  // Beside the name, during the visit: the same photo, small.
  const inVisit = await waitForFace(home, '#with-you-photo');
  assert.equal(inVisit.src, onCard.src);
  assert.deepEqual(inVisit.shown, [44, 44]);
  assert.equal(await home.evaluate(() => { const label = document.querySelector('#with-you'); return [...label.children].map((node) => node.id || node.className).join(' '); }), 'live-dot with-you-photo with-you-text', 'red light, photo, name');
  assert.equal(await visit.locator('img').count(), 0, 'the visitor’s page shows no photo');
  // The photo takes room the name used to have. However long the name, the
  // red light, the photo and the whole name stay on the screen: a long one
  // goes onto a second line. Tried on a tablet held upright, with a name about
  // as long as a visitor can be given (59 letters of the 60 allowed); the
  // label's own words are put back after.
  await home.setViewportSize({ width: 810, height: 1080 });
  const label = await home.evaluate(() => {
    const text = document.querySelector('#with-you-text');
    const was = text.textContent;
    const measure = () => Object.fromEntries(['.live-dot', '#with-you-photo', '#with-you-text'].map((part) => {
      const box = document.querySelector(`#with-you ${part}`).getBoundingClientRect();
      return [part, { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height) }];
    }));
    const usual = measure();
    text.textContent = 'Great-grandmother Wilhelmina Featherstonehaugh-Cholmondeley is with you';
    const long = measure();
    text.textContent = was;
    return { usual, long, screen: window.innerWidth };
  });
  for (const [part, box] of Object.entries(label.long)) assert.ok(box.left >= 0 && box.right <= label.screen, `beside a very long name, ${part} is still on the screen: ${JSON.stringify(box)}`);
  assert.deepEqual([label.long['.live-dot'].width, label.long['#with-you-photo'].width], [18, 44], 'the red light and the photo are not squeezed');
  assert.ok(label.long['#with-you-text'].height > label.usual['#with-you-text'].height, 'the long name went onto a second line');
  await home.setViewportSize({ width: 1180, height: 820 });
  await home.waitForTimeout(800);
  await snap(home, '7-home-in-visit');
  await snap(visit, '8-visitor-in-visit');
  await snapAll(home, '7b-home-in-visit-with-photo');
  step('video and sound flow both ways; the home screen shows who is there, with their photo');

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
  assert.equal(await home.isVisible('#captions-toggle'), false);
  step('Mary ended the visit');

  // Invited, shown, approved, knocked, answered, ended, and the list drawn
  // again each time: the home screen asked for the photo once in all. A
  // request at the moment of a visit would tell the host when visits happen.
  await home.waitForTimeout(300);
  assert.equal(homePhotoRequests.length, 1, `one request for one photo: ${homePhotoRequests.join(', ')}`);
  assert.equal((await faceIn(home, '.person .avatar')).src, onCard.src, 'and the list still shows it');
  step('through all of that the home screen asked for the photo exactly once');

  // The organizer changes the photo, this time with "Take a photo". The file
  // is one a phone held upright makes: on its side, with a note saying so.
  await org.click('#visitors .photo-tools button:has-text("Change photo")');
  await org.setInputFiles('#photo-take', sidewaysPhoto);
  const isSecond = (face) => face.width === 384 && face.height === 384 && face.corners.every((corner, i) => near(corner, UPRIGHT[i]));
  const changedInList = await waitForFace(org, '#visitors li .avatar', inList.src);
  assert.ok(isSecond(changedInList), `upright in the organizer’s list: ${JSON.stringify(changedInList)}`);
  uploads = await photosSent();
  assert.equal(uploads.length, 2);
  assert.ok(fs.readFileSync(sidewaysPhoto).includes('SENTINEL-GPS-METHOD'), 'the file that was picked says where it was taken');
  assert.ok(!uploads[1].body.includes('Exif') && !uploads[1].body.includes('SENTINEL'), 'what is sent does not');
  assert.equal(inspectJpeg(uploads[1].body).width, 384);
  const changed = await waitForFace(home, '.person .avatar', onCard.src);
  assert.ok(isSecond(changed), `upright on the home screen: ${JSON.stringify(changed)}`);
  assert.equal(homePhotoRequests.length, 2, 'the new photo was fetched once');
  step('the organizer changed the photo: it came out upright, and the home screen fetched it exactly once more');

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
  assert.equal((await waitForFace(home, '#knock-avatar', onCard.src)).src, changed.src, 'the new photo is at the door');
  await snap(home, '9-home-dropin-notice');
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  assert.equal((await faceIn(home, '#with-you-photo')).src, changed.src);
  step('drop-in connected after the notice');
  await home.click('#end');
  await visit.waitForSelector('#lobby:not([hidden])');
  assert.equal(homePhotoRequests.length, 2, 'two more knocks and a visit, and no more requests for the photo');

  // A file this browser cannot read as a picture: plain words, and the photo stays.
  await org.click('#visitors .photo-tools button:has-text("Change photo")');
  await org.setInputFiles('#photo-choose', { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic not a picture this browser reads')]) });
  await org.waitForSelector('#visitors .photo-note.bad');
  assert.equal(await org.textContent('#visitors .photo-note'), 'This kind of photo can’t be read here. Please take a new one or choose a different picture.');
  assert.equal((await photosSent()).length, 2, 'nothing was sent');
  assert.equal((await faceIn(org, '#visitors li .avatar')).src, changedInList.src);
  await snapAll(org, '9b-organizer-photo-cannot-be-read', '#visitors');
  // A picture the server refuses. The page itself only ever sends a square,
  // so here the request is changed on its way: a picture that is not square
  // arrives, the server says no, and the page passes its words on.
  const anyPhotoRoute = '**/api/organize/visitors/*/photo';
  const notSquare = (route) => (route.request().method() === 'PUT' ? route.continue({ postData: fs.readFileSync(sidewaysPhoto) }) : route.continue());
  await org.route(anyPhotoRoute, notSquare);
  await org.setInputFiles('#photo-choose', { name: 'sarah.png', mimeType: 'image/png', buffer: firstPhoto });
  await org.waitForFunction(() => document.querySelector('#visitors .photo-note.bad')?.textContent === 'That picture couldn’t be used. Please try another photo.');
  await org.unroute(anyPhotoRoute, notSquare);
  assert.equal((await faceIn(org, '#visitors li .avatar')).src, changedInList.src);
  assert.equal((await faceIn(home, '.person .avatar')).src, changed.src);
  step('a file that cannot be read, and one the server refuses: plain words, and the photo stays as it was');

  // The organizer removes the photo: the initials are back everywhere, and
  // the home screen asks for nothing.
  org.once('dialog', (dialog) => dialog.accept());
  await org.click('#visitors .photo-tools button:has-text("Remove photo")');
  await org.waitForFunction(() => !document.querySelector('#visitors li .avatar img'));
  assert.equal(await initialsIn(org, '#visitors li .avatar'), 'S');
  assert.deepEqual(await org.locator('#visitors .photo-tools button').allTextContents(), ['Add a photo']);
  await home.waitForFunction(() => !document.querySelector('.person .avatar img'));
  assert.equal(await initialsIn(home, '.person .avatar'), 'S');
  await home.waitForTimeout(300);
  assert.equal(homePhotoRequests.length, 2, 'removing a photo is not a reason to ask for one');
  await snapAll(home, '9c-home-list-initials-again');
  step('the organizer removed the photo: the initials are back, and the home screen asked for nothing');
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
  await visit.waitForFunction(() => { const b = document.querySelector('#visit'); return b && !b.hidden && !b.disabled; });
  await visit.click('#visit');
  await home.waitForSelector('#knock:not([hidden])');
  // With no photo any more, the door shows her initial, as it always did.
  assert.equal(await initialsIn(home, '#knock-avatar'), 'S');
  await snapAll(home, '11a-home-knock-initials');
  await home.click('#answer');
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  assert.equal(await home.locator('#with-you-photo').isVisible(), false, 'and no empty circle beside her name');
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

  // Photos, at the end of all those visits: two versions, two requests.
  assert.equal(homePhotoRequests.length, 2, homePhotoRequests.join(', '));
  assert.deepEqual(visitorPhotoRequests, [], 'Sarah’s phone never asked for anything about a photo');
  step('photos: the home screen made one request for each version, and the visitor’s phone made none');

  // ----- Captions -----
  if (!captionsHere) {
    step('captions: SKIPPED (run npm run captions:fetch)');
  } else {
    // So far the switch was never touched: the home screen has fetched nothing
    // for captions and remembers nothing about them.
    assert.deepEqual(captionsAsked(), [], 'with the switch off, the home screen fetched nothing for captions');
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), null);
    assert.match(await org.innerText('#content'), /Captions \(trial\): check a device at \/captions-check/);
    assert.equal(await org.getAttribute('a[href="/captions-check"]', 'href'), '/captions-check');

    const NOTICES = [/^Getting captions ready…/, /^Captions are on\. They can contain mistakes\.$/, /^Captions paused, catching up$/, /^Captions can’t keep up on this tablet\.$/, /^Captions aren’t available on this tablet\.$/, /^Tap the screen to start captions\.$/];
    const isNotice = (line) => NOTICES.some((notice) => notice.test(line));
    // Every line the caption box ever shows is noted, inside the page.
    await home.evaluate(() => {
      window.captionLines = [];
      const box = document.querySelector('#captions');
      new MutationObserver(() => { for (const line of box.children) if (!window.captionLines.includes(line.textContent)) window.captionLines.push(line.textContent); }).observe(box, { childList: true });
    });
    const captionsShown = async () => (await home.evaluate(() => window.captionLines)).filter((line) => !isNotice(line));
    const wordsOn = (page, pattern, ms = 60_000) => page.waitForFunction((source) => [...document.querySelectorAll('#captions:not([hidden]):not(.is-status) p')].some((line) => new RegExp(source, 'i').test(line.textContent)), pattern, { timeout: ms });
    const boxIsEmpty = (page) => page.evaluate(() => { const box = document.querySelector('#captions'); return box.hidden && box.childElementCount === 0 && box.textContent === ''; });
    const toggleSays = async (text, pressed) => {
      assert.equal(await home.textContent('#captions-toggle'), text);
      assert.equal(await home.getAttribute('#captions-toggle', 'aria-pressed'), pressed);
    };
    const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const measure = () => home.evaluate(() => {
      const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const box = document.querySelector('#captions');
      const style = getComputedStyle(box);
      const lines = [...box.children].map((line) => { const r = line.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
      return {
        captions: rect('#captions'), toggle: rect('#captions-toggle'), end: rect('#end'), label: rect('#with-you'), self: rect('#local'), screen: { width: innerWidth, height: innerHeight }, lines,
        color: style.color, background: style.backgroundColor, weight: Number(style.fontWeight), size: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
      };
    });
    // How strongly two colours stand apart, as the accessibility guidelines measure it (7 or more is their highest grade).
    const contrast = (one, two) => {
      const light = (colour) => { const [r, g, b] = colour.match(/\d+/g).map((v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const [hi, lo] = [light(one), light(two)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };

    // Mary opens visits again, and Sarah comes in.
    await home.click('#pause');
    const first = { requests: homeRequests.length, frames: homeFrames.length, reached: reached.length };
    await startVisit(visit2);
    await Promise.all([hasVideo(home), hasVideo(visit2)]);
    await toggleSays('Captions off', 'false');
    assert.equal(await boxIsEmpty(home), true);
    // What the page and its messages hold before any caption: words found
    // here too cannot be told apart from captions, and are left out below.
    const before = `${homeFrames.join('\n')}\n${await home.evaluate(() => document.documentElement.outerHTML)}`.toLowerCase();

    // Mary switches captions on.
    const switchedOn = Date.now();
    await home.click('#captions-toggle');
    await toggleSays('Captions on', 'true');
    await home.waitForFunction(() => /^Getting captions ready…|^Captions are on\./.test(document.querySelector('#captions').textContent));
    await home.waitForFunction(() => document.querySelector('#captions.is-status')?.textContent === 'Captions are on. They can contain mistakes.', null, { timeout: 60_000 });
    const readyAfter = Date.now() - switchedOn;
    await snap(home, '20-home-captions-are-on');
    // The visitor's words appear on the home screen. (The recording says
    // "…ask what you can do for your country.")
    await wordsOn(home, 'country');
    const wordsAfter = Date.now() - switchedOn;
    assert.equal(home.workers().length, 1);
    assert.match(home.workers()[0].url(), /\/captions-code\/[0-9a-f]{32}\/captions-worker\.js$/);

    // Where they are, and how they look: above the two buttons, clear of the
    // name and red light, large, bold, white on near-black, three lines at most.
    const look = await measure();
    for (const other of ['toggle', 'end', 'label', 'self']) assert.equal(overlap(look.captions, look[other]), false, `the captions do not cover ${other}: ${JSON.stringify([look.captions, look[other]])}`);
    assert.equal(overlap(look.toggle, look.end), false);
    assert.ok(look.captions.bottom <= look.toggle.top && look.captions.bottom <= look.end.top, 'the captions are above the buttons');
    assert.ok(look.captions.top > look.label.bottom, 'and below the name');
    assert.equal(look.toggle.height, look.end.height, 'the switch is as tall as “End visit”');
    assert.ok(look.toggle.height >= 88);
    assert.ok(look.toggle.left <= 20 && look.toggle.bottom === look.end.bottom, 'the switch is in the bottom left corner');
    assert.ok(Math.abs((look.end.left + look.end.right) / 2 - look.screen.width / 2) <= 1, '“End visit” is still in the middle');
    assert.deepEqual([look.color, look.background], ['rgb(255, 255, 255)', 'rgb(17, 17, 17)']);
    assert.ok(contrast(look.color, look.background) >= 7, 'white on near-black');
    assert.ok(look.weight >= 700 && look.size >= 40, `large and bold: ${look.size}px, ${look.weight}`);
    // (Its edge is 0.35 of the letter size, above and below.)
    assert.ok(look.captions.height <= 3 * look.lineHeight + 0.7 * look.size + 1, 'three lines at most');
    for (const part of ['captions', 'toggle', 'end']) assert.ok(look[part].left >= 0 && look[part].right <= look.screen.width && look[part].bottom <= look.screen.height, `${part} is on the screen`);
    await home.waitForTimeout(5000);
    await snapAll(home, '21-home-captions-on');

    // The promise: the words stay on the tablet. Every line the box showed,
    // and each longer word in those lines, is searched for in everything the
    // home screen sent since the visit began.
    const shownLines = await captionsShown();
    assert.ok(shownLines.some((line) => /country/i.test(line)), shownLines.join(' | '));
    const said = [...new Set(shownLines.flatMap((line) => [line, ...line.split(/\s+/).map((word) => word.replace(/[^\p{L}']/gu, '')).filter((word) => word.length >= 5)]))]
      .map((text) => text.toLowerCase()).filter((text) => !before.includes(text));
    assert.ok(said.includes('country') && said.length >= 2, said.join(' | '));
    const carries = (text) => said.find((word) => String(text).toLowerCase().includes(word));
    const framesSent = homeFrames.slice(first.frames);
    assert.ok(framesSent.some((frame) => frame.includes('"answer"')) && framesSent.some((frame) => frame.includes('"signal"')), 'the visit’s own messages were recorded');
    for (const frame of framesSent) assert.equal(carries(frame), undefined, 'a message to the server carries caption words');
    const requestsSent = homeRequests.slice(first.requests);
    assert.ok(requestsSent.length >= 12, 'the captions files were fetched in this visit');
    for (const request of requestsSent) {
      // Only fetching: the scripts and the model, from this server, with nothing sent along.
      assert.equal(request.method, 'GET', request.url);
      assert.equal(request.body, '');
      assert.ok(request.url.startsWith(`${srv.url}/captions-code/`) || request.url.startsWith(`${srv.url}/captions-files/${CAPTIONS_VERSION}/`), request.url);
      assert.equal(carries(decodeURIComponent(request.url)), undefined);
    }
    // And nothing is stored but the switch itself; what the tablet keeps for
    // captions is the model's own files.
    const kept = await home.evaluate(async () => ({
      local: Object.fromEntries(Object.entries(localStorage)),
      session: Object.keys(sessionStorage),
      databases: ((await indexedDB.databases?.()) || []).map((database) => database.name),
      cookies: document.cookie,
      caches: Object.fromEntries(await Promise.all((await caches.keys()).map(async (name) => [name, (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)]))),
    }));
    assert.deepEqual(Object.keys(kept.local).sort(), ['bethere.captions', 'bethere.home']);
    assert.equal(kept.local['bethere.captions'], 'on');
    assert.equal(kept.local['bethere.home'], new URL(homeLink).hash.slice(1), 'the home screen’s own link, as before');
    assert.deepEqual([kept.session, kept.databases, kept.cookies], [[], [], '']);
    assert.deepEqual(Object.keys(kept.caches), [`bethere-captions-${CAPTIONS_VERSION}`]);
    const listed = CAPTIONS_FILES.map((f) => `/captions-files/${CAPTIONS_VERSION}/${f.path}`);
    assert.ok(kept.caches[`bethere-captions-${CAPTIONS_VERSION}`].length >= 9);
    for (const pathname of kept.caches[`bethere-captions-${CAPTIONS_VERSION}`]) assert.ok(listed.includes(pathname), `kept on the tablet: ${pathname}`);
    assert.equal((await homeCtx.cookies()).length, 0);

    // Mary ends the visit: the words are gone, and so is the worker.
    await home.click('#end');
    await visit2.waitForSelector('#lobby:not([hidden])');
    assert.equal(await boxIsEmpty(home), true);
    assert.equal(await home.isVisible('#captions-toggle'), false);
    await until(() => home.workers().length === 0, 'the captions worker to be ended');
    assert.equal(carries(await home.evaluate(() => document.documentElement.outerHTML)), undefined, 'no caption words are left anywhere on the page');
    for (const frame of homeFrames.slice(first.frames)) assert.equal(carries(frame), undefined);
    step(`captions: switched on at the home screen, ready after ${(readyAfter / 1000).toFixed(1)} s, the visitor’s words on the screen after ${(wordsAfter / 1000).toFixed(1)} s (“${shownLines.find((line) => /country/i.test(line))}”)`);
    step(`captions: none of ${said.length} caption words or lines is in any of the ${framesSent.length} messages or ${requestsSent.length} requests the home screen sent; nothing stored but the switch; box empty and worker gone after “End visit”`);

    // The next visit: Mary's choice is remembered, with no tap. And now that
    // the tablet has the files, the visit asks the server for nothing at all.
    const second = { requests: homeRequests.length, frames: homeFrames.length, reached: reached.length };
    await startVisit(visit2);
    await home.waitForSelector('#call:not([hidden])');
    await toggleSays('Captions on', 'true');
    await Promise.all([hasVideo(home), hasVideo(visit2)]);
    await wordsOn(home, 'country');
    const askedOfServer = reached.slice(second.reached).filter((request) => request !== 'GET /api/organize');
    assert.deepEqual(askedOfServer, [], 'a captioned visit, once the tablet has the files, asks the server for nothing');
    for (const frame of homeFrames.slice(second.frames)) assert.equal(carries(frame), undefined);
    // Mary switches them off in the middle of the visit: the words and the
    // worker go at once, the choice is remembered, and the visit carries on.
    await home.click('#captions-toggle');
    await toggleSays('Captions off', 'false');
    assert.equal(await boxIsEmpty(home), true);
    await until(() => home.workers().length === 0, 'the captions worker to be ended');
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'off');
    const playedTo = await home.evaluate(() => document.querySelector('#remote').currentTime);
    await home.waitForTimeout(700);
    assert.ok(await home.evaluate(() => document.querySelector('#remote').currentTime) > playedTo, 'the visit carries on');
    assert.equal(await visit2.isVisible('#call'), true);
    // And on again.
    await home.click('#captions-toggle');
    await toggleSays('Captions on', 'true');
    await wordsOn(home, '\\w');
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'on');
    await home.click('#end');
    await visit2.waitForSelector('#lobby:not([hidden])');
    await until(() => home.workers().length === 0, 'the captions worker to be ended');
    assert.equal(await boxIsEmpty(home), true);
    step('captions: remembered on the next visit, which asked the server for nothing; switched off and on again mid-visit without disturbing it');

    // What Mary sees when captions have something to say about themselves,
    // and when they fail. For this the real worker is put aside for one that
    // says what the test tells it to; the page around it is the real one.
    await home.evaluate(() => {
      window.RealWorker = window.Worker;
      window.Worker = class { constructor(url) { this.url = url; this.heard = []; window.pretendWorker = this; } postMessage(message) { this.heard.push(message.type); } terminate() { this.ended = true; } };
    });
    const pretend = (message) => home.evaluate((m) => window.pretendWorker.onmessage({ data: m }), message);
    const boxSays = (text, ms = 10_000) => home.waitForFunction((t) => { const box = document.querySelector('#captions'); return !box.hidden && box.textContent === t; }, text, { timeout: ms });
    await startVisit(visit2);
    await Promise.all([hasVideo(home), hasVideo(visit2)]);
    await boxSays('Getting captions ready…');
    await pretend({ type: 'progress', percent: 42, fetching: true });
    await boxSays('Getting captions ready… 42%');
    await snapAll(home, '22a-home-captions-getting-ready');
    await pretend({ type: 'ready', loadMs: 1, fetchedBytes: 0 });
    await boxSays('Captions are on. They can contain mistakes.');
    await snapAll(home, '22b-home-captions-notice');
    // More words than three lines hold: the newest stay in view, whole, and
    // the oldest leave from the top.
    await pretend({ type: 'caption', kind: 'final', id: 1, text: 'Hello Mary, it is Sarah. I thought I would look in on you before lunch today.' });
    await pretend({ type: 'caption', kind: 'final', id: 2, text: 'The children send their love, and Tom says he will telephone on Sunday afternoon.' });
    await pretend({ type: 'caption', kind: 'partial', id: 3, text: 'Shall I bring the photographs when I come on Thursday' });
    const full = await measure();
    assert.ok(full.captions.height <= 3 * full.lineHeight + 0.7 * full.size + 1, `three lines at most: ${full.captions.height}px of ${full.lineHeight}px lines`);
    assert.ok(full.captions.height >= 3 * full.lineHeight, 'and all three are used');
    assert.equal(full.lines.length, 3);
    assert.ok(full.lines.at(-1).bottom <= full.captions.bottom && full.lines.at(-1).top >= full.captions.top, 'the newest line is in view');
    assert.ok(full.lines[0].top < full.captions.top, 'the oldest words have left from the top');
    for (const other of ['toggle', 'end', 'label', 'self']) assert.equal(overlap(full.captions, full[other]), false, `full of words, the captions still do not cover ${other}`);
    await snapAll(home, '22c-home-captions-three-lines');
    // Other screens: tablets held upright (three sizes of iPad) and on their
    // side, a small tablet, and a phone both ways. Nothing sits on top of
    // anything else, everything is on the screen, and the switch keeps its
    // words on one line, as tall as "End visit".
    const fitsEveryScreen = async (what) => {
      for (const [width, height] of [[810, 1080], [768, 1024], [744, 1133], [1024, 768], [600, 960], [390, 844], [844, 390], [667, 375]]) {
        await home.setViewportSize({ width, height });
        const at = await measure();
        const where = `${what} at ${width}x${height}`;
        for (const [a, b] of [['captions', 'toggle'], ['captions', 'end'], ['captions', 'label'], ['captions', 'self'], ['toggle', 'end'], ['toggle', 'self'], ['end', 'self'], ['label', 'toggle'], ['label', 'end']]) assert.equal(overlap(at[a], at[b]), false, `${where}: ${a} and ${b}`);
        for (const part of ['captions', 'toggle', 'end', 'label']) assert.ok(at[part].left >= 0 && at[part].right <= at.screen.width && at[part].top >= 0 && at[part].bottom <= at.screen.height, `${where}: ${part} is on the screen`);
        assert.equal(at.toggle.height, at.end.height, `${where}: the switch is as tall as “End visit”`);
      }
      await home.setViewportSize({ width: 1180, height: 820 });
    };
    await fitsEveryScreen('three lines of captions');
    // Should the captions ever reach them all the same (a tablet set to very
    // large letters, say), the name with its red light and the buttons are on top.
    assert.deepEqual(await home.evaluate(() => ['#with-you', '.call-bar', '#captions'].map((selector) => getComputedStyle(document.querySelector(selector)).zIndex)), ['1', '1', 'auto']);
    // Fallen behind: the old words go, and a plain line says why.
    await pretend({ type: 'paused' });
    await boxSays('Captions paused, catching up');
    await fitsEveryScreen('a line about captions');
    await snapAll(home, '22d-home-captions-paused');
    // Caught up: the line stays until there are words again.
    await pretend({ type: 'resumed' });
    await home.waitForTimeout(300);
    assert.equal(await home.textContent('#captions'), 'Captions paused, catching up');
    await pretend({ type: 'caption', kind: 'partial', id: 4, text: 'There you are' });
    await boxSays('There you are');
    // It cannot keep up: captions stop themselves, the switch goes off by
    // itself, a plain line says so for a while, and the visit is untouched.
    await pretend({ type: 'error', code: 'too_slow', message: 'Fell too far behind the sound, three times.' });
    await boxSays('Captions can’t keep up on this tablet.');
    await toggleSays('Captions off', 'false');
    assert.equal(await home.evaluate(() => window.pretendWorker.ended), true);
    assert.deepEqual(await home.evaluate(() => [...new Set(window.pretendWorker.heard)]), ['load', 'audio'], 'the worker was only ever sent the request to load, and sound');
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'on', 'her choice is still remembered');
    await snapAll(home, '22e-home-captions-cannot-keep-up');
    assert.equal(await home.isVisible('#call'), true);
    assert.equal(await visit2.isVisible('#call'), true);
    const stillPlaying = await home.evaluate(() => document.querySelector('#remote').currentTime);
    await home.waitForFunction(() => document.querySelector('#captions').hidden, null, { timeout: 12_000 });
    assert.ok(await home.evaluate(() => document.querySelector('#remote').currentTime) > stillPlaying, 'the visit carries on');
    assert.match(await home.textContent('#with-you-text'), /Sarah is with you/);
    await home.click('#end');
    await visit2.waitForSelector('#lobby:not([hidden])');
    // And a tablet on which captions cannot even start.
    await startVisit(visit2);
    await Promise.all([hasVideo(home), hasVideo(visit2)]);
    await boxSays('Getting captions ready…');
    await home.evaluate(() => window.pretendWorker.onerror({ message: 'could not be loaded', preventDefault() {} }));
    await boxSays('Captions aren’t available on this tablet.');
    await toggleSays('Captions off', 'false');
    await snapAll(home, '22f-home-captions-not-available');
    assert.equal(await visit2.isVisible('#call'), true);
    await visit2.click('#end');
    await home.waitForSelector('#idle:not([hidden])');
    assert.equal(await boxIsEmpty(home), true);
    step('captions: “getting ready”, the notice, three lines at most, “paused”, “can’t keep up” and “aren’t available” each said in plain words; the visit went on every time; nothing covers anything on eight sizes of screen');

    // A tablet that cannot bear captions may close the page outright while
    // they are getting ready, and the visit with it. "On" is put aside until
    // they are running, so that the next visit does not start them, and end,
    // the same way. (The pretend worker never gets ready; reloading the page
    // stands in for the tablet closing it, and brings the real worker back.)
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'on');
    await startVisit(visit2);
    await Promise.all([hasVideo(home), hasVideo(visit2)]);
    await boxSays('Getting captions ready…');
    await toggleSays('Captions on', 'true');
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'off', '“on” is put aside while captions get ready');
    await home.reload();
    await visit2.waitForSelector('#lobby:not([hidden])');
    await home.click('#start');
    await home.waitForSelector('.person');
    const workersMade = () => home.evaluate(() => window.workersMade);
    await home.evaluate(() => {
      const Real = window.Worker;
      window.workersMade = 0;
      window.Worker = class extends Real { constructor(...args) { super(...args); if (args[0] !== 'http://[') window.workersMade += 1; } };
    });
    await startVisit(visit2);
    await Promise.all([hasVideo(home), hasVideo(visit2)]);
    await toggleSays('Captions off', 'false');
    assert.equal(await boxIsEmpty(home), true);
    await home.waitForTimeout(500);
    assert.equal(await workersMade(), 0, 'captions did not start by themselves after the page died of them');
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'off');
    // A visit that ends in the ordinary way while captions are getting ready
    // keeps the choice: the page is still standing.
    await home.click('#captions-toggle');
    await toggleSays('Captions on', 'true');
    await home.click('#end');
    await visit2.waitForSelector('#lobby:not([hidden])');
    assert.equal(await workersMade(), 1);
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'on');
    await until(() => home.workers().length === 0, 'the captions worker to be ended');
    // And when they do get ready, "on" is remembered from then on.
    await startVisit(visit2);
    await home.waitForSelector('#call:not([hidden])');
    await toggleSays('Captions on', 'true');
    await home.waitForFunction(() => document.querySelector('#captions.is-status')?.textContent === 'Captions are on. They can contain mistakes.' || document.querySelector('#captions:not(.is-status) p'), null, { timeout: 60_000 });
    assert.equal(await home.evaluate(() => localStorage.getItem('bethere.captions')), 'on');
    await visit2.click('#end');
    await home.waitForSelector('#idle:not([hidden])');
    await until(() => home.workers().length === 0, 'the captions worker to be ended');
    assert.deepEqual(await home.evaluate(() => Object.keys(localStorage).sort()), ['bethere.captions', 'bethere.home'], 'still nothing kept but the switch and the screen’s own link');
    // All through, the home screen asked only this server for anything.
    // (A photo it already holds in memory is shown from a "blob:" address of its own.)
    assert.deepEqual(homeRequests.filter((request) => !request.url.startsWith(`${srv.url}/`) && !request.url.startsWith(`blob:${srv.url}/`)).map((request) => request.url), []);
    step('captions: a page that closes while they get ready does not start them by itself next time; a visit that ends in the ordinary way keeps the choice');

    // ----- The captions check page -----
    // What a family opens on the tablet before relying on captions. Here on
    // a phone-sized screen, with a 20-second long test instead of two minutes.
    const checkCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const checkAsked = [];
    checkCtx.on('request', (request) => checkAsked.push(request.url()));
    const check = await checkCtx.newPage();
    await check.goto(`${srv.url}/captions-check?seconds=20`);
    await check.waitForFunction(() => !document.querySelector('#step1').disabled);
    assert.equal(await check.isDisabled('#step2'), true);
    assert.equal(await check.isDisabled('#step3'), true);
    assert.equal(await check.textContent('#verdict'), 'Not tried yet.');
    await snapAll(check, '23-captions-check-start');
    await check.click('#step1');
    await check.waitForFunction(() => /^Ready\.|could not/.test(document.querySelector('#result1').textContent), null, { timeout: 60_000 });
    assert.match(await check.textContent('#result1'), /^Ready\. It took [\d.]+ seconds, and 48\.6 MB were fetched\.$/);
    await check.click('#step2');
    await check.waitForFunction(() => /^It wrote|could not/.test(document.querySelector('#result2').textContent), null, { timeout: 60_000 });
    const quick = await check.textContent('#result2');
    assert.match(quick, /^It wrote: “[^”]*country[^”]*” That took [\d.]+ seconds for 11 seconds of speech: fast enough\.$/i);
    assert.match(await check.textContent('#verdict'), /^This device can show captions\. \(That is from the quick test/);
    await snapAll(check, '24-captions-check-after-quick-test');
    await check.click('#step3');
    await wordsOn(check, '\\w');
    await snap(check, '25-captions-check-long-test-running');
    await check.waitForFunction(() => /^Done\.|stopped|could not/.test(document.querySelector('#result3').textContent), null, { timeout: 90_000 });
    assert.match(await check.textContent('#result3'), /^Done\. Words appeared about [\d.]+ seconds after they were spoken \([\d.]+ at worst\)\. Captions ran [\d.]+ seconds behind the sound \([\d.]+ at worst\), and never had to pause to catch up\.$/);
    assert.equal(await check.textContent('#verdict'), 'This device can show captions.');
    const numbers = await check.textContent('#numbers');
    assert.match(numbers, /^Got ready in [\d.]+ s \(48\.6 MB fetched\)\nQuick test: [\d.]+ s for 11\.0 s of speech \(0\.\d\d of its length\)\nIt wrote: .*country.*\nLong test: 20 s, \d+ sentences, 0 pauses to catch up\nWords after speech: usually [\d.]+ s, at worst [\d.]+ s\nBehind the sound: usually [\d.]+ s, at worst [\d.]+ s\nSound: \d+ Hz, \d+ blocks heard, loudest 0\.\d+\nBrowser: Mozilla.*$/i);
    await until(() => check.workers().length === 0, 'the check page’s worker to be ended');
    assert.equal(await boxIsEmpty(check), true);
    assert.deepEqual(checkAsked.filter((url) => !url.startsWith(`${srv.url}/`)), [], 'the check page asked only this server for anything');
    assert.deepEqual(await check.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
    await snapAll(check, '26-captions-check-done');
    const line = (start) => numbers.split('\n').find((text) => text.startsWith(start));
    step(`the captions check page: ${line('Quick test')}; ${line('Words after speech')}; ${line('Behind the sound')}; no pauses`);
    await checkCtx.close();

    // A browser that cannot make the sound link from the page to itself: the
    // long test says so, and that this says nothing about captions in a
    // visit. It is not counted as captions failing, and can be tried again.
    const noLinkCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await noLinkCtx.addInitScript(() => { RTCPeerConnection.prototype.addIceCandidate = async () => {}; });
    const noLink = await noLinkCtx.newPage();
    await noLink.goto(`${srv.url}/captions-check?seconds=5`);
    await noLink.waitForFunction(() => !document.querySelector('#step1').disabled);
    await noLink.click('#step1');
    await noLink.waitForFunction(() => /^Ready\.|could not/.test(document.querySelector('#result1').textContent), null, { timeout: 60_000 });
    await noLink.click('#step3');
    await noLink.waitForFunction(() => /^Done\.|No words|stopped|could not/.test(document.querySelector('#result3').textContent), null, { timeout: 40_000 });
    assert.equal(await noLink.textContent('#result3'), 'The two-minute test could not be run: this page could not make a sound link to itself. That says nothing about captions in a visit.');
    assert.equal(await noLink.textContent('#verdict'), 'Not tried yet.');
    assert.match(await noLink.textContent('#numbers'), /\nLong test not run: this page could not make a sound link to itself\.\n/);
    assert.equal(await noLink.isDisabled('#step1'), false);
    assert.equal(await noLink.isDisabled('#step3'), false);
    assert.equal(noLink.workers().length, 0);
    assert.equal(await boxIsEmpty(noLink), true);
    step('the captions check page: when the page cannot link to itself, it says the long test was not run, and blames nothing on captions');
    await noLinkCtx.close();
  }

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
  fs.rmSync(scratch, { recursive: true, force: true });
}
// The little relay server keeps timers of its own running for some minutes
// after a visit; don't wait for them.
process.exit(failure ? 1 : 0);
