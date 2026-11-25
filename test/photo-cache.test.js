// The browser's side of photos (public/js/photo.js), without a browser: when a
// photo is asked for and when it is not, with a pretend server and a clock the
// test moves by hand. Making the small square picture needs a real browser:
// that, and the real pages, are in test/e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPhotoCache, photoFetcher, showFace, createFaces, RETRY_AFTER, PHOTO_SIZE, photoCache, getPhotoUrl, cachedPhotoUrl } from '../public/js/photo.js';

const read = (file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// A cache with a pretend server behind it. `answer(key, etag, n)` says what
// the n-th request gets: 'ok', a status number, 'offline' (no answer at all),
// 'png' (not a JPEG), or a promise of one of those.
function setup(answer = () => 'ok') {
  const asked = [];           // [key, etag] of every request made
  const made = [];            // blob: addresses handed out
  const dropped = [];         // ...and given back
  const timers = [];          // { fn, ms } waiting on the clock
  const fetcher = async (key, etag) => {
    asked.push([key, etag]);
    const what = await answer(key, etag, asked.length);
    if (what === 'offline') throw new TypeError('Failed to fetch');
    if (typeof what === 'number') return { ok: false, status: what, blob: async () => ({ type: 'application/json' }) };
    // { body: promise }: the answer has begun, and the picture itself arrives when the promise is kept.
    return { ok: true, status: 200, blob: async () => { await what?.body; return { type: what === 'png' ? 'image/png' : 'image/jpeg', key, etag }; } };
  };
  const cache = createPhotoCache({
    makeUrl: (blob) => { const url = `blob:${blob.key}/${blob.etag}/${made.length + 1}`; made.push(url); return url; },
    dropUrl: (url) => dropped.push(url),
    later: (fn, ms) => timers.push({ fn, ms }),
  });
  // Lets the next waiting timer run, as the clock would.
  const tick = async () => { const next = timers.shift(); next.fn(); await flush(); return next.ms; };
  return { cache, fetcher, asked, made, dropped, timers, tick, get: (key, etag) => cache.getPhotoUrl(key, etag, fetcher) };
}

test('a photo is fetched once for each version, however often it is asked for', async () => {
  const s = setup();
  const first = await s.get('sarah', 'tag-1');
  assert.equal(first, 'blob:sarah/tag-1/1');
  assert.deepEqual(s.asked, [['sarah', 'tag-1']]);
  // Every redraw, knock and visit after that: the same address, and no request.
  for (let i = 0; i < 50; i += 1) assert.equal(await s.get('sarah', 'tag-1'), first);
  assert.equal(s.cache.cachedPhotoUrl('sarah'), first);
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.dropped, []);

  // Someone else's photo is its own request.
  assert.equal(await s.get('tom', 'tag-9'), 'blob:tom/tag-9/2');
  assert.deepEqual(s.asked, [['sarah', 'tag-1'], ['tom', 'tag-9']]);
  assert.equal(s.cache.cachedPhotoUrl('sarah'), first);
});

test('asking again while it is still on its way does not ask the server twice', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = setup(() => gate.then(() => 'ok'));
  const a = s.get('sarah', 'tag-1');
  const b = s.get('sarah', 'tag-1');
  const c = s.get('sarah', 'tag-1');
  await flush();
  assert.equal(s.asked.length, 1);
  assert.equal(s.cache.cachedPhotoUrl('sarah'), null, 'nothing to show yet');
  release();
  assert.deepEqual(await Promise.all([a, b, c]), ['blob:sarah/tag-1/1', 'blob:sarah/tag-1/1', 'blob:sarah/tag-1/1']);
  assert.equal(s.asked.length, 1);
  assert.equal(s.made.length, 1);
});

test('a changed photo is fetched once more, and the old one is let go of at once', async () => {
  let release;
  let gate = null;
  const s = setup(() => (gate ? gate.then(() => 'ok') : 'ok'));
  const old = await s.get('sarah', 'tag-1');
  gate = new Promise((resolve) => { release = resolve; });
  const changing = s.get('sarah', 'tag-2');
  // Before the new picture has even arrived, the old one is no longer shown.
  assert.deepEqual(s.dropped, [old]);
  assert.equal(s.cache.cachedPhotoUrl('sarah'), null);
  release();
  const fresh = await changing;
  assert.equal(fresh, 'blob:sarah/tag-2/2');
  assert.deepEqual(s.asked, [['sarah', 'tag-1'], ['sarah', 'tag-2']]);
  assert.equal(s.cache.cachedPhotoUrl('sarah'), fresh);
  for (let i = 0; i < 10; i += 1) await s.get('sarah', 'tag-2');
  assert.equal(s.asked.length, 2);
  // Back to the first picture counts as another change: it is asked for again.
  await s.get('sarah', 'tag-1');
  assert.equal(s.asked.length, 3);
  assert.deepEqual(s.dropped, [old, fresh]);
});

test('a removed photo is let go of without asking for anything', async () => {
  const s = setup();
  const url = await s.get('sarah', 'tag-1');
  for (const none of [null, undefined, '']) assert.equal(await s.get('sarah', none), null);
  assert.deepEqual(s.dropped, [url]);
  assert.equal(s.cache.cachedPhotoUrl('sarah'), null);
  assert.equal(s.asked.length, 1);
  assert.equal(await s.get('nobody', null), null);
  assert.equal(s.asked.length, 1);

  // People who are no longer on the list are let go of too.
  const a = await s.get('ann', 'tag-a');
  const b = await s.get('ben', 'tag-b');
  s.cache.keepOnlyPhotos(['ben', 'someone-new']);
  assert.deepEqual(s.dropped, [url, a]);
  assert.equal(s.cache.cachedPhotoUrl('ann'), null);
  assert.equal(s.cache.cachedPhotoUrl('ben'), b);
  s.cache.forgetPhoto('ben');
  s.cache.forgetPhoto('ben');
  assert.deepEqual(s.dropped, [url, a, b]);
  assert.equal(s.asked.length, 3);
});

test('a photo that was changed or removed while it was being fetched is never shown', async () => {
  const gates = [];
  const s = setup(() => new Promise((resolve) => { gates.push(() => resolve('ok')); }));
  const slow = s.get('sarah', 'tag-1');
  await flush();
  const newer = s.get('sarah', 'tag-2');
  await flush();
  gates[0]();       // the first answer arrives late
  assert.equal(await slow, null);
  assert.deepEqual(s.made, [], 'nothing was made from the out-of-date picture');
  gates[1]();
  assert.equal(await newer, 'blob:sarah/tag-2/1');

  const going = s.get('tom', 'tag-1');
  await flush();
  s.cache.keepOnlyPhotos([]);
  gates[2]();
  assert.equal(await going, null);
  assert.equal(s.cache.cachedPhotoUrl('tom'), null);
  assert.equal(s.made.length, 1);

  // The same when the answer had begun and the picture itself was still arriving.
  const bodies = [];
  const t = setup(() => ({ body: new Promise((resolve) => { bodies.push(resolve); }) }));
  const arriving = t.get('sarah', 'tag-1');
  await flush();
  assert.equal(bodies.length, 1, 'the server has answered; the picture is on its way');
  const replaced = t.get('sarah', 'tag-2');
  await flush();
  bodies[0]();
  assert.equal(await arriving, null);
  assert.deepEqual(t.made, [], 'nothing was made from the out-of-date picture');
  bodies[1]();
  assert.equal(await replaced, 'blob:sarah/tag-2/1');
  const leaving = t.get('tom', 'tag-1');
  await flush();
  t.cache.forgetPhoto('tom');
  bodies[2]();
  assert.equal(await leaving, null);
  assert.deepEqual(t.made, ['blob:sarah/tag-2/1']);
  assert.deepEqual(t.dropped, []);
});

test('“no photo” and “this link does not work” are not asked about again', async () => {
  for (const status of [404, 401, 403, 400]) {
    const s = setup(() => status);
    assert.equal(await s.get('sarah', 'tag-1'), null);
    for (let i = 0; i < 20; i += 1) assert.equal(await s.get('sarah', 'tag-1'), null);
    assert.equal(s.asked.length, 1, String(status));
    assert.deepEqual(s.timers, [], 'and no later try is planned');
    assert.equal(s.cache.cachedPhotoUrl('sarah'), null);
  }
  // Something that is not a JPEG is not shown, and not asked for again.
  const s = setup(() => 'png');
  assert.equal(await s.get('sarah', 'tag-1'), null);
  assert.equal(await s.get('sarah', 'tag-1'), null);
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.made, []);
  assert.deepEqual(s.timers, []);
});

test('a photo that could not be fetched is tried again by the clock alone, a few times', async () => {
  assert.deepEqual([...RETRY_AFTER], [60_000, 300_000, 1_800_000]);
  for (const failure of ['offline', 500, 502, 503, 429, 408]) {
    // Fails twice, then works.
    const s = setup((key, etag, n) => (n <= 2 ? failure : 'ok'));
    let result = 'waiting';
    s.get('sarah', 'tag-1').then((url) => { result = url; });
    await flush();
    assert.equal(s.asked.length, 1);
    assert.equal(s.timers.length, 1);
    // Meanwhile the page draws its list, people knock and visit: no request.
    for (let i = 0; i < 30; i += 1) s.get('sarah', 'tag-1');
    await flush();
    assert.equal(s.asked.length, 1, `${failure}: asking again does not hurry it`);
    assert.equal(s.timers.length, 1);
    assert.equal(s.cache.cachedPhotoUrl('sarah'), null);
    assert.equal(await s.tick(), 60_000);
    assert.equal(s.asked.length, 2);
    assert.equal(result, 'waiting');
    assert.equal(await s.tick(), 300_000);
    assert.equal(s.asked.length, 3);
    assert.equal(result, 'blob:sarah/tag-1/1', `${failure}: it arrived on the third try`);
    assert.equal(s.cache.cachedPhotoUrl('sarah'), 'blob:sarah/tag-1/1');
    assert.deepEqual(s.timers, []);
  }

  // It never works: four requests in all, then it is left alone.
  const s = setup(() => 'offline');
  let result = 'waiting';
  s.get('sarah', 'tag-1').then((url) => { result = url; });
  await flush();
  assert.deepEqual([await s.tick(), await s.tick(), await s.tick()], [60_000, 300_000, 1_800_000]);
  assert.equal(result, null);
  assert.equal(s.asked.length, 4);
  assert.deepEqual(s.timers, []);
  for (let i = 0; i < 20; i += 1) assert.equal(await s.get('sarah', 'tag-1'), null);
  assert.equal(s.asked.length, 4);
  // A new version starts afresh.
  s.get('sarah', 'tag-2');
  await flush();
  assert.equal(s.asked.length, 5);

  // A photo that changed or went while a later try was waiting is not tried.
  const t = setup(() => 'offline');
  t.get('tom', 'tag-1');
  await flush();
  t.cache.forgetPhoto('tom');
  await t.tick();
  assert.equal(t.asked.length, 1);
  assert.deepEqual(t.timers, []);
});

test('photos are asked for with the page’s link secret and never from the browser’s own cache', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => { calls.push([path, options]); return { ok: true, status: 200 }; });
  let token = 'first-secret';
  const fetcher = photoFetcher((id) => `/api/home/visitors/${encodeURIComponent(id)}/photo`, () => token);
  await fetcher('vis/1 ?', 'tag-1');
  token = 'second-secret';
  await fetcher('visBBBBBBBBB', 'tag-2');
  await photoFetcher(() => '/x', 'plain-secret')('k');
  assert.deepEqual(calls, [
    ['/api/home/visitors/vis%2F1%20%3F/photo', { headers: { Authorization: 'Bearer first-secret' }, cache: 'no-store' }],
    ['/api/home/visitors/visBBBBBBBBB/photo', { headers: { Authorization: 'Bearer second-secret' }, cache: 'no-store' }],
    ['/x', { headers: { Authorization: 'Bearer plain-secret' }, cache: 'no-store' }],
  ]);
  // The secret and the tag are never put in the address, where a host could log them.
  for (const [path] of calls) assert.doesNotMatch(path, /secret|tag-/);
});

// Just enough of a page for showFace(): elements with children, a dataset and listeners.
function pretendPage(t) {
  const element = (tag) => {
    const node = {
      tag, children: [], dataset: {}, className: '', listeners: {}, parent: null,
      replaceChildren(...kids) { node.children = []; node.append(...kids); },
      append(...kids) { for (const kid of kids) { if (kid && typeof kid === 'object') kid.parent = node; node.children.push(kid); } },
      remove() { node.parent.children = node.parent.children.filter((kid) => kid !== node); },
      addEventListener(type, fn) { node.listeners[type] = fn; },
    };
    return node;
  };
  const had = globalThis.document;
  globalThis.document = { createElement: element };
  t.after(() => { if (had === undefined) delete globalThis.document; else globalThis.document = had; });
  return element;
}

test('an avatar shows the photo over the initials, and the initials alone if it cannot be drawn', (t) => {
  const element = pretendPage(t);
  const node = element('div');
  showFace(node, 'SJ', null);
  assert.deepEqual(node.children, ['SJ']);

  showFace(node, 'SJ', 'blob:one');
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0], 'SJ', 'the initials stay underneath');
  const img = node.children[1];
  assert.deepEqual([img.tag, img.src, img.alt], ['img', 'blob:one', ''], 'the name is beside it, so the picture has no text of its own');

  // Drawn again with nothing changed: the element is left alone (no flicker).
  showFace(node, 'SJ', 'blob:one');
  assert.equal(node.children[1], img);

  // The picture cannot be drawn: it is taken away, and stays away.
  img.listeners.error();
  assert.deepEqual(node.children, ['SJ']);
  showFace(node, 'SJ', 'blob:one');
  assert.deepEqual(node.children, ['SJ']);

  // A new photo, a new name, no photo.
  showFace(node, 'SJ', 'blob:two');
  assert.equal(node.children[1].src, 'blob:two');
  showFace(node, 'TB', 'blob:two');
  assert.deepEqual([node.children[0], node.children[1].src], ['TB', 'blob:two']);
  showFace(node, 'TB', '');
  assert.deepEqual(node.children, ['TB']);

  // Beside "… is with you" there are no initials: with no photo it is empty.
  const small = element('span');
  showFace(small, '', null);
  assert.deepEqual(small.children, []);
  showFace(small, '', 'blob:one');
  assert.equal(small.children.length, 1);
  small.children[0].listeners.error();
  assert.deepEqual(small.children, []);
  assert.doesNotThrow(() => showFace(null, 'SJ', 'blob:one'), 'a page without that element is left alone');

  // In a list, each person keeps their one element from drawing to drawing.
  const faces = createFaces('avatar small');
  const sarah = faces.of('sarah', 'S', 'blob:one');
  assert.equal(sarah.className, 'avatar small');
  assert.equal(faces.of('sarah', 'S', 'blob:one'), sarah);
  assert.notEqual(faces.of('tom', 'T', null), sarah);
  faces.keepOnly(['tom']);
  assert.notEqual(faces.of('sarah', 'S', 'blob:one'), sarah);
});

test('photo.js stands alone, and each page uses it as it should', () => {
  const photo = read('js/photo.js');
  assert.doesNotMatch(photo, /^\s*import\s/m, 'photo.js imports nothing');
  assert.doesNotMatch(photo, /console\./);
  assert.equal(PHOTO_SIZE, 384);
  assert.match(photo, /const QUALITIES = \[0\.85, 0\.7, 0\.55\];/);
  assert.match(photo, /const SMALL_ENOUGH = 150 \* 1024;/);
  // The page's own cache is there, and is the same thing as the functions.
  assert.equal(getPhotoUrl, photoCache.getPhotoUrl);
  assert.equal(cachedPhotoUrl, photoCache.cachedPhotoUrl);

  // The home screen asks for photos in one place only, when it is told who
  // may visit. Knocks, answers and endings use what is in memory.
  const home = read('js/home.js');
  assert.equal(home.match(/getPhotoUrl\(/g).length, 1);
  assert.equal(home.match(/fetchPhoto/g).length, 2, 'made once, used once');
  assert.equal(home.match(/loadPhotos\(\)/g).length, 2, 'defined, and called for a “state” message only');
  assert.match(home, /case 'state':\s+home = msg\.home;\s+loadPhotos\(\);\s+render\(\);/);
  const afterList = home.slice(home.indexOf('// ----- Someone knocks -----'), home.indexOf('// ----- Messages from the server -----'));
  assert.ok(afterList.length > 1000);
  assert.doesNotMatch(afterList, /getPhotoUrl|fetchPhoto|loadPhotos|\/visitors\//, 'nothing between a knock and the end of a visit asks for a photo');
  assert.equal(home.match(/\/visitors\//g).length, 1, 'the photo address is written in one place: where it is fetched through the cache');
  assert.match(read('home.html'), /id="with-you-photo"/);

  // A visitor's page has nothing to do with photos.
  for (const file of ['js/visit.js', 'visit.html']) assert.doesNotMatch(read(file), /photo/i, file);
  // The organizer's page offers the camera and the photo library, and sends only the small copy.
  const page = read('organize.html');
  assert.match(page, /<input id="photo-take"[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="user"/);
  assert.match(page, /<input id="photo-choose"[^>]*type="file"[^>]*accept="image\/\*"/);
  assert.doesNotMatch(page.match(/<input id="photo-choose"[^>]*>/)[0], /capture/);
  const organize = read('js/organize.js');
  assert.match(organize, /await squarePhoto\(file\)/);
  assert.match(organize, /input\.value = ''/);
  assert.doesNotMatch(organize, /body: file\b/, 'the picture that was picked is never sent');
});
