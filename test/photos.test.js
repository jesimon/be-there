// Where photos are kept (lib/photos.js) and how the store looks after them
// (lib/store.js). Everything that touches the disk does so in a folder of its
// own under the system's temporary folder, never in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { photoPath, photosInFolder, photosInMemory, validId } from '../lib/photos.js';
import { createStore } from '../lib/store.js';
import { homeView, visitorView, photoTag } from '../lib/rules.js';
import { acceptPhoto } from '../lib/jpeg.js';

const fx = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const picture = acceptPhoto(fx('canvas-384.jpg'));
const other = acceptPhoto(fx('grey-256.jpg'));
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-there-photos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// Every file under a folder, as paths from it.
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort() : []);

const HOME = 'homeAAAAAAAA';
const VISITOR = 'visBBBBBBBBB';
const BAD_IDS = ['../../etc', '..', '.', '', 'a/b', 'short', 'x'.repeat(33), 'vis%2e%2e%2f', 'vis\0BBBBBBBB', 'vis BBBBBBBB', 'visBBBBBBBB.', 'visBBBBBBBB/', '/etc/passwd00', 'C:\\windows00', undefined, null, 12345678, {}, ['visBBBBBBBBB']];

test('a photo’s file name is made only from our own ids, and stays inside the folder', (t) => {
  const dir = tmp(t);
  assert.equal(photoPath(dir, HOME, VISITOR), path.join(dir, HOME, `${VISITOR}.jpg`));
  assert.equal(photoPath(dir, '-_AZaz09-_AZ', '-_AZaz09-_AZ'), path.join(dir, '-_AZaz09-_AZ', '-_AZaz09-_AZ.jpg'));
  for (const bad of BAD_IDS) {
    assert.equal(validId(bad), false, String(bad));
    assert.equal(photoPath(dir, bad, VISITOR), null, `home ${String(bad)}`);
    assert.equal(photoPath(dir, HOME, bad), null, `visitor ${String(bad)}`);
  }
  // The ids the app makes are the kind that is allowed.
  const store = createStore(':memory:');
  const { home } = store.createHome({ personName: 'Mary' });
  const { visitor } = store.addVisitor(home, { name: 'Sarah' });
  assert.ok(validId(home.id) && validId(visitor.id));
});

test('photos in a folder: one file for each visitor, written whole, removed for good', (t) => {
  const dir = path.join(tmp(t), 'photos');
  const photos = photosInFolder(dir);
  assert.equal(photos.get(HOME, VISITOR), null, 'nothing yet, and no folder is needed to ask');
  assert.equal(fs.existsSync(dir), false);

  photos.put(HOME, VISITOR, picture.bytes);
  const file = path.join(dir, HOME, `${VISITOR}.jpg`);
  assert.ok(fs.readFileSync(file).equals(picture.bytes));
  assert.ok(photos.get(HOME, VISITOR).equals(picture.bytes));
  assert.deepEqual(filesIn(dir), [path.join(HOME, `${VISITOR}.jpg`)], 'no temporary file is left');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only the app itself may read the file');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'or look in its folder');
  }

  // A new photo takes the old one's place: no history.
  photos.put(HOME, VISITOR, other.bytes);
  assert.ok(photos.get(HOME, VISITOR).equals(other.bytes));
  assert.deepEqual(filesIn(dir), [path.join(HOME, `${VISITOR}.jpg`)]);

  // Other visitors and other homes are kept apart.
  photos.put(HOME, 'visCCCCCCCCC', picture.bytes);
  photos.put('homeDDDDDDDD', VISITOR, picture.bytes);
  photos.remove(HOME, VISITOR);
  assert.equal(photos.get(HOME, VISITOR), null);
  photos.remove(HOME, VISITOR);     // again: nothing to do, nothing thrown
  assert.deepEqual(filesIn(dir), [path.join(HOME, 'visCCCCCCCCC.jpg'), path.join('homeDDDDDDDD', `${VISITOR}.jpg`)].sort());
  photos.removeHome(HOME);
  assert.equal(fs.existsSync(path.join(dir, HOME)), false, 'the home’s folder is gone');
  assert.deepEqual(filesIn(dir), [path.join('homeDDDDDDDD', `${VISITOR}.jpg`)]);
  photos.removeHome(HOME);
});

test('photos in a folder: an id that is not ours reaches nothing outside it', (t) => {
  const root = tmp(t);
  const dir = path.join(root, 'photos');
  const outside = path.join(root, 'precious.txt');
  fs.writeFileSync(outside, 'keep me');
  fs.mkdirSync(path.join(root, 'other-folder'));
  fs.writeFileSync(path.join(root, 'other-folder', `${VISITOR}.jpg`), 'keep me too');
  const photos = photosInFolder(dir);
  photos.put(HOME, VISITOR, picture.bytes);
  for (const bad of BAD_IDS) {
    assert.throws(() => photos.put(bad, VISITOR, picture.bytes), /cannot be kept/, String(bad));
    assert.throws(() => photos.put(HOME, bad, picture.bytes), /cannot be kept/, String(bad));
    assert.equal(photos.get(bad, VISITOR), null);
    assert.equal(photos.get(HOME, bad), null);
    photos.remove(bad, VISITOR);
    photos.remove(HOME, bad);
    photos.removeHome(bad);
  }
  photos.removeHome('../other-folder');
  photos.remove('../other-folder', VISITOR);
  assert.throws(() => photos.put(HOME, VISITOR, 'not bytes'), /cannot be kept/);
  assert.deepEqual(filesIn(root), ['other-folder/visBBBBBBBBB.jpg', `photos/${HOME}/${VISITOR}.jpg`, 'precious.txt'].map((f) => path.normalize(f)).sort());
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
});

test('photos in memory behave the same, and hand out copies', () => {
  const photos = photosInMemory();
  assert.equal(photos.get(HOME, VISITOR), null);
  photos.put(HOME, VISITOR, picture.bytes);
  photos.put(HOME, 'visCCCCCCCCC', other.bytes);
  photos.put('homeDDDDDDDD', VISITOR, other.bytes);
  assert.equal(photos.size, 3);
  const got = photos.get(HOME, VISITOR);
  assert.ok(got.equals(picture.bytes));
  got.fill(0);
  assert.ok(photos.get(HOME, VISITOR).equals(picture.bytes), 'what is kept cannot be changed from outside');
  photos.remove(HOME, VISITOR);
  assert.equal(photos.get(HOME, VISITOR), null);
  photos.removeHome(HOME);
  assert.equal(photos.size, 1);
  assert.ok(photos.get('homeDDDDDDDD', VISITOR).equals(other.bytes));
  for (const bad of BAD_IDS) {
    assert.throws(() => photos.put(bad, VISITOR, picture.bytes), /cannot be kept/);
    assert.equal(photos.get(HOME, bad), null);
    photos.remove(bad, VISITOR);
    photos.removeHome(bad);
  }
  assert.equal(photos.size, 1);
});

test('the store keeps photos beside the data file, and the record holds only the tag', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'db.json');
  const store = createStore(file);
  const { home } = store.createHome({ personName: 'Mary' });
  const { visitor: sarah } = store.addVisitor(home, { name: 'Sarah' });
  const { visitor: tom } = store.addVisitor(home, { name: 'Tom' });
  assert.equal(store.photoBytes(home, sarah.id), null);
  assert.equal(homeView(home).visitors[0].photo, null);

  assert.equal(store.setPhoto(home, sarah.id, picture.bytes, picture.etag), sarah);
  const photoFile = path.join(dir, 'photos', home.id, `${sarah.id}.jpg`);
  assert.ok(fs.readFileSync(photoFile).equals(picture.bytes));
  assert.ok(store.photoBytes(home, sarah.id).equals(picture.bytes));
  assert.equal(store.photoBytes(home, tom.id), null);
  assert.deepEqual(Object.keys(sarah.photo).sort(), ['etag', 'updatedAt']);
  assert.equal(sarah.photo.etag, picture.etag);
  assert.ok(!Number.isNaN(Date.parse(sarah.photo.updatedAt)));
  assert.deepEqual(homeView(home).visitors.map((v) => v.photo), [picture.etag, null]);
  // The data file names the tag; the picture itself is not in it.
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, new RegExp(picture.etag));
  assert.ok(saved.length < 3000);
  assert.deepEqual(filesIn(dir), ['db.json', path.join('photos', home.id, `${sarah.id}.jpg`)]);

  // Started again from the same folder, it is all still there.
  const again = createStore(file);
  const sameHome = again.getHome(home.id);
  assert.deepEqual(homeView(sameHome).visitors.map((v) => v.photo), [picture.etag, null]);
  assert.ok(again.photoBytes(sameHome, sarah.id).equals(picture.bytes));

  // Changed: the one file is replaced. Removed: file and tag both go.
  store.setPhoto(home, sarah.id, other.bytes, other.etag);
  assert.ok(fs.readFileSync(photoFile).equals(other.bytes));
  assert.equal(homeView(home).visitors[0].photo, other.etag);
  assert.equal(store.removePhoto(home, sarah.id), sarah);
  assert.equal(fs.existsSync(photoFile), false);
  assert.equal('photo' in sarah, false);
  assert.equal(store.photoBytes(home, sarah.id), null);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /photo/);
  assert.equal(store.removePhoto(home, sarah.id), sarah, 'removing what is not there is fine');

  // Nobody who is not a visitor of this home.
  assert.equal(store.setPhoto(home, 'no-such-visitor', picture.bytes, picture.etag), null);
  assert.equal(store.removePhoto(home, 'no-such-visitor'), null);
  assert.equal(store.photoBytes(home, 'no-such-visitor'), null);
  assert.deepEqual(filesIn(path.join(dir, 'photos')), []);
});

test('removing a visitor removes their photo, and deleting a home removes its folder', (t) => {
  const dir = tmp(t);
  const store = createStore(path.join(dir, 'db.json'));
  const { home } = store.createHome({ personName: 'Mary' });
  const { home: next } = store.createHome({ personName: 'Joe' });
  const { visitor: sarah } = store.addVisitor(home, { name: 'Sarah' });
  const { visitor: tom } = store.addVisitor(home, { name: 'Tom' });
  const { visitor: ann } = store.addVisitor(next, { name: 'Ann' });
  store.setPhoto(home, sarah.id, picture.bytes, picture.etag);
  store.setPhoto(home, tom.id, other.bytes, other.etag);
  store.setPhoto(next, ann.id, picture.bytes, picture.etag);
  const photosDir = path.join(dir, 'photos');
  assert.equal(filesIn(photosDir).length, 3);

  store.removeVisitor(home, sarah.id);
  assert.deepEqual(filesIn(photosDir), [path.join(home.id, `${tom.id}.jpg`), path.join(next.id, `${ann.id}.jpg`)].sort());
  assert.equal('photo' in sarah, false);
  assert.equal(store.photoBytes(home, sarah.id), null);
  // A removed visitor cannot be given a photo again.
  assert.equal(store.setPhoto(home, sarah.id, picture.bytes, picture.etag), null);
  assert.equal(filesIn(photosDir).length, 2);

  store.deleteHome(home);
  assert.equal(fs.existsSync(path.join(photosDir, home.id)), false);
  assert.deepEqual(filesIn(photosDir), [path.join(next.id, `${ann.id}.jpg`)], 'the other home is untouched');
  assert.ok(store.photoBytes(next, ann.id).equals(picture.bytes));
  // Nor can anyone in a home that has been deleted, by a caller that still
  // holds it: the folder is gone, and nothing would clear the file away again.
  assert.equal(store.setPhoto(home, tom.id, other.bytes, other.etag), null);
  assert.equal(fs.existsSync(path.join(photosDir, home.id)), false);
  assert.deepEqual(filesIn(photosDir), [path.join(next.id, `${ann.id}.jpg`)]);
  assert.equal(store.photoBytes(home, tom.id), null, 'and nothing is given out for it');
});

test('a photo that cannot be written leaves the record as it was; one that cannot be cleared away stops nothing', () => {
  let broken = false;
  const inner = photosInMemory();
  const photos = {
    put: (...args) => { if (broken) throw new Error('disk full'); inner.put(...args); },
    get: (...args) => inner.get(...args),
    remove: () => { if (broken) throw new Error('disk gone'); },
    removeHome: () => { if (broken) throw new Error('disk gone'); },
  };
  const store = createStore(':memory:', { photos });
  const { home } = store.createHome({ personName: 'Mary' });
  const { visitor } = store.addVisitor(home, { name: 'Sarah' });
  store.setPhoto(home, visitor.id, picture.bytes, picture.etag);
  broken = true;
  assert.throws(() => store.setPhoto(home, visitor.id, other.bytes, other.etag), /disk full/);
  assert.equal(visitor.photo.etag, picture.etag, 'the tag still names the picture that is there');
  assert.ok(store.photoBytes(home, visitor.id).equals(picture.bytes));
  // Removing still works as far as anyone can tell: the tag goes, so the picture is never given out.
  assert.equal(store.removePhoto(home, visitor.id), visitor);
  assert.equal(store.photoBytes(home, visitor.id), null);
  assert.equal(homeView(home).visitors[0].photo, null);
  assert.equal(store.removeVisitor(home, visitor.id), visitor);
  store.deleteHome(home);
  assert.equal(store.getHome(home.id), null);
});

test('a store in memory keeps photos in memory: nothing is written anywhere', (t) => {
  const dir = tmp(t);
  const was = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(was));
  const store = createStore(':memory:');
  const { home } = store.createHome({ personName: 'Mary' });
  const { visitor } = store.addVisitor(home, { name: 'Sarah' });
  store.setPhoto(home, visitor.id, picture.bytes, picture.etag);
  assert.ok(store.photoBytes(home, visitor.id).equals(picture.bytes));
  store.removeVisitor(home, visitor.id);
  store.deleteHome(home);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('data written before there were photos still loads, and odd values count as no photo', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'db.json');
  const old = { homes: [{ id: 'homeAAAAAAAA', name: 'Mary’s home', personName: 'Mary', timeZone: 'UTC', hours: { start: '08:00', end: '21:00' }, paused: false, homeHash: 'x', organizerHash: 'y', createdAt: '2026-11-01T00:00:00.000Z',
    visitors: [{ id: 'visBBBBBBBBB', name: 'Sarah', relation: 'Granddaughter', mode: 'knock', approved: true, hash: 'z', createdAt: '2026-11-01T00:00:00.000Z' }] }] };
  fs.writeFileSync(file, JSON.stringify(old));
  const store = createStore(file);
  const home = store.getHome('homeAAAAAAAA');
  assert.deepEqual(homeView(home).visitors, [{ id: 'visBBBBBBBBB', name: 'Sarah', relation: 'Granddaughter', approved: true, mode: 'knock', photo: null }]);
  assert.equal(store.photoBytes(home, 'visBBBBBBBBB'), null);
  store.setPhoto(home, 'visBBBBBBBBB', picture.bytes, picture.etag);
  assert.equal(homeView(home).visitors[0].photo, picture.etag);

  for (const odd of [undefined, null, '', 'abc', 7, true, [], {}, { etag: 7 }, { etag: '' }, { etag: 'too-short' }, { etag: `${picture.etag}"` }, { etag: 'has spaces in it 123456' }, { etag: '<script>alert(1)</script>' }]) {
    assert.equal(photoTag({ photo: odd }), null, JSON.stringify(odd));
  }
  assert.equal(photoTag(undefined), null);
  assert.equal(photoTag({ photo: { etag: picture.etag } }), picture.etag);
});

test('what a visitor is told about the home never mentions photos', () => {
  const store = createStore(':memory:');
  const { home } = store.createHome({ personName: 'Mary' });
  const { visitor: sarah } = store.addVisitor(home, { name: 'Sarah' });
  const { visitor: tom } = store.addVisitor(home, { name: 'Tom' });
  const before = JSON.stringify(visitorView(home, sarah, { online: true, busyWith: null }));
  store.setPhoto(home, sarah.id, picture.bytes, picture.etag);
  store.setPhoto(home, tom.id, other.bytes, other.etag);
  for (const v of [sarah, tom]) {
    const view = JSON.stringify(visitorView(home, v, { online: true, busyWith: null }));
    assert.doesNotMatch(view, /photo|etag/i);
    assert.ok(!view.includes(picture.etag) && !view.includes(other.etag));
  }
  assert.equal(JSON.stringify(visitorView(home, sarah, { online: true, busyWith: null })), before, 'exactly what it was before there were photos');
  assert.deepEqual(Object.keys(visitorView(home, sarah, {})).sort(), ['canVisit', 'homeName', 'hours', 'personName', 'status', 'statusText', 'timeZone', 'you']);
  assert.deepEqual(Object.keys(visitorView(home, sarah, {}).you).sort(), ['approved', 'mode', 'name']);
});
