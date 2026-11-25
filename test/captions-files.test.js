// The files live captions need (lib/captions-files.js) and how the server
// hands them out: the list itself, fetching them with every byte checked,
// what is served and what never is, what /api/config says, and the one change
// to the page rules. Fetching is always a pretend one here, into a folder of
// its own outside the repository: nothing in these tests asks any other site
// for anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import { createStore } from '../lib/store.js';
import {
  CAPTIONS_FILES, CAPTIONS_VERSION, CAPTIONS_CODE, CAPTIONS_RETRY_WAITS, captionsDirFrom, captionsSwitchedOff, captionsStatus, captionsFilePath,
  captionsType, fetchCaptionsFiles, prepareCaptionsFiles, captionsCodeFrom,
} from '../lib/captions-files.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
// Everything in the repository but what is installed, git's own, and the
// folder a developer's own data and fetched captions files live in.
function repositoryFiles() {
  const found = {};
  const look = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) look(full);
      else { const stat = fs.statSync(full); found[path.relative(repository, full)] = `${stat.size} bytes, written ${stat.mtimeMs}`; }
    }
  };
  look(repository);
  return found;
}
const repositoryBefore = repositoryFiles();

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// A folder of its own for one test, outside the repository, cleared away after.
function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-there-captions-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Every file under a folder, as "relative/path": size.
function listing(dir) {
  const found = {};
  const look = (at) => {
    for (const entry of fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }) : []) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) look(full); else found[path.relative(dir, full).split(path.sep).join('/')] = fs.statSync(full).size;
    }
  };
  look(dir);
  return found;
}

// A small list in the shape of the real one, and a pretend site that has its
// files. `wrong` says what the site does differently for a path:
//   'checksum' | 'short' | 'long' | 404 | 'offline' | 'cut' | 'stall'
const BODIES = {
  'library.min.js': Buffer.from('export const env = {};\n'.repeat(40)),
  'runtime.mjs': Buffer.from('export default 1;\n'),
  'runtime.wasm': Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), crypto.randomBytes(5000)]),
  'some-model/config.json': Buffer.from('{"model_type":"pretend"}'),
  'some-model/onnx/model.onnx': crypto.randomBytes(70_000),
  'sample.wav': Buffer.concat([Buffer.from('RIFF'), crypto.randomBytes(900)]),
};
const VERSION = 'vtest';
const FILES = Object.entries(BODIES).map(([p, body]) => ({ path: p, url: `https://files.example/${VERSION}/${p}`, bytes: body.length, sha256: sha256(body) }));
const LIST = { files: FILES, version: VERSION };
const TOTAL = FILES.reduce((sum, f) => sum + f.bytes, 0);

function site(wrong = {}) {
  const asked = [];
  const fetchImpl = async (url, options = {}) => {
    asked.push(url);
    const f = FILES.find((x) => x.url === url);
    const how = f ? wrong[f.path] : 404;
    if (how === 'offline') throw new TypeError('fetch failed');
    if (typeof how === 'number') return new Response('nope', { status: how });
    let body = BODIES[f.path];
    if (how === 'checksum') { body = Buffer.from(body); body[body.length - 1] ^= 0xff; }
    if (how === 'short') body = body.subarray(0, body.length - 1);
    if (how === 'long') body = Buffer.concat([body, Buffer.alloc(200_000, 7)]);
    if (how === 'cut' || how === 'stall') {
      // Half the file arrives; then the connection breaks, or simply goes quiet.
      const half = body.subarray(0, Math.floor(body.length / 2));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(half));
          if (how === 'cut') setTimeout(() => controller.error(new TypeError('terminated')), 5);
          else options.signal?.addEventListener('abort', () => controller.error(options.signal.reason || new Error('aborted')));
        },
      });
      return new Response(stream, { status: 200 });
    }
    // In small pieces, as a real download comes.
    const stream = new ReadableStream({
      start(controller) {
        for (let at = 0; at < body.length; at += 16_384) controller.enqueue(new Uint8Array(body.subarray(at, at + 16_384)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  return { fetchImpl, asked };
}
const noParts = (dir) => assert.deepEqual(Object.keys(listing(dir)).filter((p) => p.endsWith('.part')), [], 'nothing is left under a temporary name');

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

test('the list: twelve files, each from a pinned address, with its size and SHA-256', () => {
  assert.equal(CAPTIONS_VERSION, 'v1');
  assert.deepEqual(CAPTIONS_FILES.map((f) => f.path), [
    'transformers.min.js',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
    'onnx-community/moonshine-tiny-ONNX/config.json',
    'onnx-community/moonshine-tiny-ONNX/generation_config.json',
    'onnx-community/moonshine-tiny-ONNX/preprocessor_config.json',
    'onnx-community/moonshine-tiny-ONNX/tokenizer_config.json',
    'onnx-community/moonshine-tiny-ONNX/tokenizer.json',
    'onnx-community/moonshine-tiny-ONNX/onnx/encoder_model_quantized.onnx',
    'onnx-community/moonshine-tiny-ONNX/onnx/decoder_model_merged_quantized.onnx',
    'onnx-community/silero-vad/onnx/model.onnx',
    'jfk.wav',
  ]);
  assert.ok(Object.isFrozen(CAPTIONS_FILES) && CAPTIONS_FILES.every(Object.isFrozen), 'the list cannot be changed while the server runs');
  for (const f of CAPTIONS_FILES) {
    assert.deepEqual(Object.keys(f), ['path', 'url', 'bytes', 'sha256']);
    assert.match(f.path, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, f.path);
    assert.ok(!f.path.split('/').some((part) => part === '' || part.startsWith('.')), f.path);
    assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
    assert.ok(Number.isInteger(f.bytes) && f.bytes > 0, f.path);
    // Pinned: an exact npm version, or a full commit of the repository. Never "latest" or a branch.
    const url = new URL(f.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(['cdn.jsdelivr.net', 'huggingface.co'].includes(url.hostname), f.url);
    if (url.hostname === 'cdn.jsdelivr.net') assert.match(url.pathname, /^\/npm\/(@huggingface\/transformers@4\.3\.2|onnxruntime-web@1\.31\.0-dev\.20260914-8d85527a0)\/dist\/[\w.-]+$/);
    else assert.match(url.pathname, /^\/(datasets\/)?[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/[\w./-]+$/);
    assert.doesNotMatch(f.url, /latest|\/main\/|\/master\//);
    assert.ok(f.url.endsWith(`/${f.path.split('/').pop()}`), 'the file keeps its own name');
  }
  assert.equal(new Set(CAPTIONS_FILES.map((f) => f.path)).size, 12);
  assert.equal(new Set(CAPTIONS_FILES.map((f) => f.sha256)).size, 12);
  // About 49 MB for a tablet to fetch once, and a 2 MB sample for the check page.
  const total = CAPTIONS_FILES.reduce((sum, f) => sum + f.bytes, 0);
  assert.equal(total, 51_140_268);
  assert.equal(total - CAPTIONS_FILES.at(-1).bytes, 49_199_790);
  // The runtime is the plain build: the "asyncify" one gets tabs killed on iPhones and iPads.
  assert.ok(!CAPTIONS_FILES.some((f) => /asyncify|jsep|jspi|webgpu/i.test(f.url)));
});

test('the list: the files on this machine, when it has them, are exactly the ones listed', async (t) => {
  // Only where they have been fetched (`npm run captions:fetch`); elsewhere
  // there is nothing to compare. Nothing is fetched here.
  const dir = captionsDirFrom({}, { cwd: repository });
  if (captionsStatus(dir) !== 'ready') return t.diagnostic('the captions files are not on this machine: their checksums were not compared');
  for (const f of CAPTIONS_FILES) {
    const bytes = fs.readFileSync(path.join(dir, f.path));
    assert.equal(bytes.length, f.bytes, f.path);
    assert.equal(sha256(bytes), f.sha256, f.path);
  }
  // The runtime really is WebAssembly, and the sample really is a WAV.
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'ort-wasm-simd-threaded.wasm')).subarray(0, 4)], [0, 0x61, 0x73, 0x6d]);
  assert.equal(fs.readFileSync(path.join(dir, 'jfk.wav')).subarray(0, 4).toString(), 'RIFF');
});

test('the list: each kind of file is sent as what it is', () => {
  assert.equal(captionsType('ort-wasm-simd-threaded.wasm'), 'application/wasm');
  assert.equal(captionsType('ort-wasm-simd-threaded.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(captionsType('transformers.min.js'), 'text/javascript; charset=utf-8');
  assert.equal(captionsType('a/b/config.json'), 'application/json; charset=utf-8');
  assert.equal(captionsType('a/onnx/model.onnx'), 'application/octet-stream');
  assert.equal(captionsType('jfk.wav'), 'audio/wav');
  assert.equal(captionsType('MODEL.ONNX'), 'application/octet-stream');
  assert.equal(captionsType('page.html'), 'application/octet-stream', 'nothing else is ever sent as a page or a script');
});

test('where the files are kept, and the switch that turns captions off', () => {
  const cwd = path.join(os.tmpdir(), 'somewhere');
  assert.equal(captionsDirFrom({}, { cwd }), path.join(cwd, 'data', 'captions', 'v1'), 'beside the default data file');
  assert.equal(captionsDirFrom({ DATA_FILE: '/var/data/db.json' }, { cwd }), '/var/data/captions/v1', 'on the host’s disk, which outlives a deploy');
  assert.equal(captionsDirFrom({ DATA_FILE: 'store/db.json' }, { cwd }), path.join(cwd, 'store', 'captions', 'v1'));
  assert.equal(captionsDirFrom({ DATA_FILE: '/var/data/db.json', CAPTIONS_DIR: ' /srv/captions ' }, { cwd }), '/srv/captions', 'CAPTIONS_DIR is used as it is');
  assert.equal(captionsDirFrom({ CAPTIONS_DIR: 'files' }, { cwd }), path.join(cwd, 'files'));
  assert.equal(captionsDirFrom({ DATA_FILE: '/var/data/db.json' }, { cwd, version: 'v2' }), '/var/data/captions/v2');
  for (const off of ['off', 'OFF', ' Off\n']) assert.equal(captionsSwitchedOff({ CAPTIONS: off }), true, JSON.stringify(off));
  for (const on of [undefined, '', 'on', '0', 'false', 'no', 'offline']) assert.equal(captionsSwitchedOff({ CAPTIONS: on }), false, JSON.stringify(on));
  assert.equal(captionsSwitchedOff(), false);
});

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

test('fetching: a good download becomes “ready”, every byte as listed', async (t) => {
  const dir = path.join(folder(t), 'captions', VERSION);
  assert.equal(captionsStatus(dir, LIST), 'missing', 'a folder that is not there');
  const s = site();
  const progress = [];
  const result = await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: s.fetchImpl, onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, { ok: true, failed: [], fetched: FILES.map((f) => f.path) });
  assert.equal(captionsStatus(dir, LIST), 'ready');
  assert.deepEqual(s.asked, FILES.map((f) => f.url), 'each file asked for once, at its listed address');
  for (const f of FILES) assert.ok(fs.readFileSync(path.join(dir, f.path)).equals(BODIES[f.path]), f.path);
  assert.deepEqual(Object.keys(listing(dir)).sort(), [...FILES.map((f) => f.path), 'verified.json'].sort());
  noParts(dir);
  // The note that makes it "ready" names every file and its checksum.
  const note = JSON.parse(fs.readFileSync(path.join(dir, 'verified.json'), 'utf8'));
  assert.equal(note.version, VERSION);
  assert.deepEqual(note.files, Object.fromEntries(FILES.map((f) => [f.path, f.sha256])));
  // Progress only ever goes up, and ends at the whole.
  assert.ok(progress.length >= FILES.length);
  for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i].loaded >= progress[i - 1].loaded);
  assert.deepEqual([progress.at(-1).loaded, progress.at(-1).total], [TOTAL, TOTAL]);
});

test('fetching: run again, it keeps what is there and asks for nothing', async (t) => {
  const dir = folder(t);
  await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site().fetchImpl });
  const before = fs.statSync(path.join(dir, 'verified.json')).mtimeMs;
  const again = site();
  const result = await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: again.fetchImpl });
  assert.deepEqual(result, { ok: true, failed: [], fetched: [] });
  assert.deepEqual(again.asked, []);
  assert.equal(fs.statSync(path.join(dir, 'verified.json')).mtimeMs, before, 'the note is left as it was');
  assert.equal(captionsStatus(dir, LIST), 'ready');
});

for (const [how, reason] of [['checksum', 'wrong_checksum'], ['short', 'wrong_size'], ['long', 'wrong_size'], [404, 'http_404'], [500, 'http_500'], ['offline', 'network'], ['cut', 'network']]) {
  test(`fetching: a file that is wrong (${how}) is refused, nothing wrong is kept, and the next run carries on`, async (t) => {
    const dir = folder(t);
    const bad = 'some-model/onnx/model.onnx';
    const s = site({ [bad]: how });
    const result = await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: s.fetchImpl });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, [{ path: bad, reason }]);
    assert.equal(captionsStatus(dir, LIST), 'missing');
    const kept = listing(dir);
    assert.equal(kept[bad], undefined, 'nothing under the file’s real name');
    assert.equal(kept['verified.json'], undefined, 'and no note saying the folder is ready');
    noParts(dir);
    // The good files are kept, so the next run only fetches what is missing.
    assert.deepEqual(Object.keys(kept).sort(), FILES.map((f) => f.path).filter((p) => p !== bad).sort());
    if (how === 'long') assert.ok(Object.values(kept).every((size) => size < 100_000), 'the too-long file was cut off, not written out');
    const good = site();
    const second = await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: good.fetchImpl });
    assert.deepEqual(second, { ok: true, failed: [], fetched: [bad] });
    assert.deepEqual(good.asked, [`https://files.example/${VERSION}/${bad}`]);
    assert.equal(captionsStatus(dir, LIST), 'ready');
    assert.ok(fs.readFileSync(path.join(dir, bad)).equals(BODIES[bad]));
  });
}

test('fetching: a download that stops moving is given up, and one that is told to stop, stops', async (t) => {
  const dir = folder(t);
  const stalled = await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site({ 'runtime.wasm': 'stall' }).fetchImpl, stallMs: 40 });
  assert.deepEqual(stalled.failed, [{ path: 'runtime.wasm', reason: 'stalled' }]);
  assert.deepEqual(stalled.fetched.sort(), FILES.map((f) => f.path).filter((p) => p !== 'runtime.wasm').sort(), 'the files after it were still fetched');
  noParts(dir);
  assert.equal(listing(dir)['runtime.wasm'], undefined);

  // Told to stop (the server is shutting down) while a file is on its way.
  const other = folder(t);
  const stop = new AbortController();
  const s = site({ 'runtime.wasm': 'stall' });
  const running = fetchCaptionsFiles(other, { ...LIST, fetchImpl: (url, options) => { if (url.endsWith('runtime.wasm')) setTimeout(() => stop.abort(), 10); return s.fetchImpl(url, options); }, signal: stop.signal });
  const stopped = await running;
  assert.equal(stopped.ok, false);
  assert.deepEqual(stopped.failed, [{ path: 'runtime.wasm', reason: 'stopped' }]);
  assert.deepEqual(s.asked.length, 3, 'nothing more was asked for after that');
  noParts(other);
  assert.equal(captionsStatus(other, LIST), 'missing');
  // Already told to stop before it began: nothing is asked for at all.
  const never = site();
  const none = await fetchCaptionsFiles(folder(t), { ...LIST, fetchImpl: never.fetchImpl, signal: stop.signal });
  assert.equal(none.ok, false);
  assert.deepEqual(never.asked, []);
});

test('fetching: what an interrupted run left under a temporary name is cleared away', async (t) => {
  const dir = folder(t);
  fs.mkdirSync(path.join(dir, 'some-model', 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'some-model', 'onnx', 'model.onnx.0a1b2c3d4e5f.part'), 'half a file');
  fs.writeFileSync(path.join(dir, 'runtime.wasm.ffffffffffff.part'), 'half a file');
  assert.equal(captionsStatus(dir, LIST), 'missing');
  const result = await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site().fetchImpl });
  assert.equal(result.ok, true);
  noParts(dir);
  assert.equal(captionsStatus(dir, LIST), 'ready');
});

test('“ready” means every file is there at its listed size, with the note for exactly this list', async (t) => {
  const dir = folder(t);
  await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site().fetchImpl });
  assert.equal(captionsStatus(dir, LIST), 'ready');
  const model = path.join(dir, 'some-model', 'onnx', 'model.onnx');
  const whole = fs.readFileSync(model);

  // A file cut short, grown, gone, or replaced by a folder.
  for (const spoil of [() => fs.writeFileSync(model, whole.subarray(0, 100)), () => fs.appendFileSync(model, 'x'), () => fs.rmSync(model), () => { fs.rmSync(model); fs.mkdirSync(model); }]) {
    spoil();
    assert.equal(captionsStatus(dir, LIST), 'missing');
    fs.rmSync(model, { recursive: true, force: true });
    fs.writeFileSync(model, whole);
    assert.equal(captionsStatus(dir, LIST), 'ready');
  }
  // The note gone, unreadable, for another version, or for other bytes.
  const notePath = path.join(dir, 'verified.json');
  const note = fs.readFileSync(notePath, 'utf8');
  for (const other of [null, '', '{', 'null', '[]', '{"version":"vtest"}', note.replace(VERSION, 'v0'), note.replace(FILES[1].sha256, '0'.repeat(64))]) {
    if (other === null) fs.rmSync(notePath); else fs.writeFileSync(notePath, other);
    assert.equal(captionsStatus(dir, LIST), 'missing', String(other).slice(0, 30));
  }
  fs.writeFileSync(notePath, note);
  assert.equal(captionsStatus(dir, LIST), 'ready');
  // A list with one more file, or a new version: this folder is not ready for that.
  assert.equal(captionsStatus(dir, { files: [...FILES, { path: 'new.bin', url: 'https://files.example/new.bin', bytes: 3, sha256: sha256('abc') }], version: VERSION }), 'missing');
  assert.equal(captionsStatus(dir, { files: FILES, version: 'v-next' }), 'missing');
  // The real list is not this folder's either.
  assert.equal(captionsStatus(dir), 'missing');
  for (const nowhere of ['', null, undefined, 42, path.join(dir, 'no-such-folder')]) assert.equal(captionsStatus(nowhere, LIST), 'missing');

  // A file that changed without changing size is caught the next time the
  // files are fetched: it loses its name at once, and the folder is not
  // "ready" again until the right bytes are back.
  const spoilt = Buffer.from(whole);
  spoilt[0] ^= 0xff;
  fs.writeFileSync(model, spoilt);
  const failed = await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site({ 'some-model/onnx/model.onnx': 'offline' }).fetchImpl });
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(model), false);
  assert.equal(captionsStatus(dir, LIST), 'missing');
  assert.equal((await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site().fetchImpl })).ok, true);
  assert.ok(fs.readFileSync(model).equals(whole));
  assert.equal(captionsStatus(dir, LIST), 'ready');
});

test('a place on the disk is given only for a name on the list', (t) => {
  const dir = folder(t);
  assert.equal(captionsFilePath(dir, 'runtime.wasm', FILES), path.join(dir, 'runtime.wasm'));
  assert.equal(captionsFilePath(dir, 'some-model/onnx/model.onnx', FILES), path.join(dir, 'some-model', 'onnx', 'model.onnx'));
  for (const name of ['verified.json', '../verified.json', 'runtime.wasm/', '/runtime.wasm', 'RUNTIME.WASM', 'some-model', 'some-model/onnx/../../runtime.wasm', '', '.', '..', '/etc/passwd', null, undefined, 7]) {
    assert.equal(captionsFilePath(dir, name, FILES), null, String(name));
  }
  // Even a list that names something outside the folder gets nothing for it.
  const sly = [{ path: '../outside.txt' }, { path: '/etc/passwd' }, { path: '.' }];
  for (const f of sly) assert.equal(captionsFilePath(dir, f.path, sly), null, f.path);
  assert.equal(captionsFilePath('', 'runtime.wasm', FILES), null);
  assert.equal(captionsFilePath(null, 'runtime.wasm', FILES), null);
});

test('when the files cannot be fetched: a few more tries, each after a longer wait, then no more', async (t) => {
  assert.deepEqual([...CAPTIONS_RETRY_WAITS], [30_000, 120_000, 600_000]);
  // Fails twice, works the third time.
  const dir = folder(t);
  let tries = 0;
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const flaky = (url, options) => (url.endsWith('runtime.mjs') && (tries += 1) <= 2 ? Promise.reject(new TypeError('fetch failed')) : site().fetchImpl(url, options));
  assert.equal(await prepareCaptionsFiles(dir, { ...LIST, fetchImpl: flaky, sleep }), true);
  assert.deepEqual(slept, [30_000, 120_000]);
  assert.equal(captionsStatus(dir, LIST), 'ready');

  // Never works: one try and three more, then it gives up.
  const never = folder(t);
  const down = site(Object.fromEntries(FILES.map((f) => [f.path, 'offline'])));
  const waited = [];
  assert.equal(await prepareCaptionsFiles(never, { ...LIST, fetchImpl: down.fetchImpl, sleep: async (ms) => { waited.push(ms); } }), false);
  assert.deepEqual(waited, [30_000, 120_000, 600_000]);
  assert.equal(down.asked.length, 4 * FILES.length);
  assert.equal(captionsStatus(never, LIST), 'missing');

  // Told to stop while waiting for the next try: it stops there.
  const stop = new AbortController();
  const stopping = site(Object.fromEntries(FILES.map((f) => [f.path, 500])));
  const began = Date.now();
  setTimeout(() => stop.abort(), 30);
  const result = await prepareCaptionsFiles(folder(t), { ...LIST, fetchImpl: stopping.fetchImpl, signal: stop.signal, waits: [60_000] });
  assert.equal(result, false);
  assert.ok(Date.now() - began < 5000, 'it did not sit out the wait');
  assert.equal(stopping.asked.length, FILES.length, 'and did not try again');
});

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

// One request, with the path sent exactly as written (fetch would tidy ".." away).
function raw(server, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${server.url}`, { method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}
async function serverWith(t, captions, more = {}) {
  const server = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '', env: {}, ...more, captions });
  let closed = false;
  server.stop = async () => { if (!closed) { closed = true; await server.close(); } };
  t.after(server.stop);
  server.config = async () => (await fetch(`${server.url}/api/config`)).json();
  return server;
}
async function readyFolder(t) {
  const dir = folder(t);
  assert.equal((await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site().fetchImpl })).ok, true);
  return dir;
}
const at = (p) => `/captions-files/${VERSION}/${p}`;

test('server: the files are served only from the list, each as what it is, to be kept for good', async (t) => {
  const dir = await readyFolder(t);
  const server = await serverWith(t, { dir, ...LIST });
  assert.equal(server.captions, 'ready');
  assert.equal((await server.config()).captions, 'ready');
  const types = {
    'library.min.js': 'text/javascript; charset=utf-8', 'runtime.mjs': 'text/javascript; charset=utf-8', 'runtime.wasm': 'application/wasm',
    'some-model/config.json': 'application/json; charset=utf-8', 'some-model/onnx/model.onnx': 'application/octet-stream', 'sample.wav': 'audio/wav',
  };
  for (const f of FILES) {
    const res = await raw(server, at(f.path));
    assert.equal(res.status, 200, f.path);
    assert.ok(res.bytes.equals(BODIES[f.path]), f.path);
    assert.equal(res.headers['content-type'], types[f.path], f.path);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', f.path);
    assert.equal(res.headers['content-length'], String(f.bytes));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin', 'no other site can use this server as its own store of models');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.headers['set-cookie'], undefined);
    // Asked about without the body, and a part of it (a download taken up again).
    const head = await raw(server, at(f.path), { method: 'HEAD' });
    assert.deepEqual([head.status, head.bytes.length, head.headers['content-length'], head.headers['cache-control']], [200, 0, String(f.bytes), 'public, max-age=31536000, immutable']);
    const part = await raw(server, at(f.path), { headers: { Range: 'bytes=2-9' } });
    assert.equal(part.status, 206);
    assert.ok(part.bytes.equals(BODIES[f.path].subarray(2, 10)));
    assert.equal(part.headers['content-type'], types[f.path]);
  }
});

test('server: anything not on the list is “not found”: the note, other names, other versions, and every way out of the folder', async (t) => {
  const base = folder(t);
  const dir = path.join(base, 'captions', VERSION);
  assert.equal((await fetchCaptionsFiles(dir, { ...LIST, fetchImpl: site().fetchImpl })).ok, true);
  // Things beside and inside the folder that must never be handed out.
  fs.writeFileSync(path.join(base, 'db.json'), '{"homes":[{"homeHash":"SECRET-HASH"}]}');
  fs.writeFileSync(path.join(base, 'captions', 'secret.txt'), 'SECRET');
  fs.writeFileSync(path.join(dir, 'extra.js'), 'SECRET');
  fs.writeFileSync(path.join(dir, '.hidden'), 'SECRET');
  const server = await serverWith(t, { dir, ...LIST });
  assert.equal((await raw(server, at('runtime.wasm'))).status, 200);
  const tries = [
    at('verified.json'), at('extra.js'), at('.hidden'), at(''), at('some-model'), at('some-model/'), at('some-model/onnx'),
    at('runtime.wasm/'), at('RUNTIME.WASM'), at('runtime.wasm%00'), at('runtime.wasm%00.js'), at('./runtime.wasm'), at('some-model//config.json'),
    '/captions-files', '/captions-files/', `/captions-files/${VERSION}`, '/captions-files/v0/runtime.wasm', '/captions-files/runtime.wasm', `/captions-files/${VERSION.toUpperCase()}/runtime.wasm`,
    at('../secret.txt'), at('../../db.json'), at('..%2fsecret.txt'), at('%2e%2e/secret.txt'), at('%2e%2e%2f%2e%2e%2fdb.json'), at('..\\secret.txt'), at('some-model/../../secret.txt'),
    at('some-model/../runtime.wasm'), at('some-model/%2e%2e/runtime.wasm'), `/captions-files/${VERSION}/../${VERSION}/runtime.wasm`, `/captions-files//${VERSION}/runtime.wasm`,
    at('....//....//db.json'), at('%252e%252e/secret.txt'), '/captions-files/%2e%2e/%2e%2e/package.json', '/captions-files/../../../../etc/passwd', at('/etc/passwd'),
  ];
  for (const pathname of tries) {
    const res = await raw(server, pathname);
    assert.equal(res.status, 404, pathname);
    assert.doesNotMatch(res.bytes.toString(), /SECRET|homeHash|root:/, pathname);
    assert.equal(res.headers['cache-control'], undefined, `${pathname}: a “not found” is not to be kept`);
  }
  // Only reading: every other way of asking is "not found" too, and changes nothing.
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await raw(server, at('runtime.wasm'), { method })).status, 404, method);
  assert.ok(fs.readFileSync(path.join(dir, 'runtime.wasm')).equals(BODIES['runtime.wasm']));
  // The one normalised form a browser might send still works: a query after the name.
  assert.equal((await raw(server, `${at('runtime.wasm')}?x=1`)).status, 200);
});

test('server: /api/config says “off”, “preparing” or “ready”, and nothing is served until it is “ready”', async (t) => {
  const everything = async (server) => Promise.all(FILES.map(async (f) => (await raw(server, at(f.path))).status));
  const none = FILES.map(() => 404);

  // Not there, and nobody fetching: off. The server does not make the folder, let alone fetch.
  const empty = path.join(folder(t), 'captions', VERSION);
  const without = await serverWith(t, { dir: empty, ...LIST });
  assert.equal(without.captions, 'off');
  assert.equal((await without.config()).captions, 'off');
  assert.deepEqual(await everything(without), none);
  assert.equal(await without.captionsSettled, 'off');
  assert.equal(fs.existsSync(empty), false);

  // There and verified, but switched off: off, and nothing is served.
  const dir = await readyFolder(t);
  const switchedOff = await serverWith(t, { dir, off: true, ...LIST });
  assert.equal((await switchedOff.config()).captions, 'off');
  assert.deepEqual(await everything(switchedOff), none);
  const byEnv = await serverWith(t, undefined, { env: { CAPTIONS: 'off', CAPTIONS_DIR: dir } });
  assert.equal((await byEnv.config()).captions, 'off');
  const byEnvOn = await serverWith(t, { ...LIST }, { env: { CAPTIONS_DIR: dir } });
  assert.equal((await byEnvOn.config()).captions, 'ready', 'CAPTIONS_DIR says where the files are');

  // Being fetched: preparing, and nothing is served, not even the files that
  // have already arrived whole. Then ready.
  const fresh = folder(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = site();
  const slow = async (url, options) => { if (url.endsWith('sample.wav')) await gate; return s.fetchImpl(url, options); };
  const fetching = await serverWith(t, { dir: fresh, autoFetch: true, fetchImpl: slow, ...LIST });
  assert.equal(fetching.captions, 'preparing', 'starting did not wait for the files');
  assert.equal((await fetching.config()).captions, 'preparing');
  for (let i = 0; i < 200 && !fs.existsSync(path.join(fresh, 'some-model', 'onnx', 'model.onnx')); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(path.join(fresh, 'runtime.wasm')), 'some files are already there, whole');
  assert.deepEqual(await everything(fetching), none);
  release();
  assert.equal(await fetching.captionsSettled, 'ready');
  assert.equal((await fetching.config()).captions, 'ready');
  assert.deepEqual(await everything(fetching), FILES.map(() => 200));
  assert.deepEqual(s.asked, FILES.map((f) => f.url), 'one fetch of each file, no more');
});

test('server: files that fail their check are refused and nothing is served; after a few tries it is “off” until the next start', async (t) => {
  for (const how of ['checksum', 'short', 'long']) {
    const dir = folder(t);
    const s = site({ 'runtime.wasm': how });
    const slept = [];
    const server = await serverWith(t, { dir, autoFetch: true, fetchImpl: s.fetchImpl, sleep: async (ms) => { slept.push(ms); }, waits: [5, 10], ...LIST });
    assert.equal(server.captions, 'preparing');
    assert.equal(await server.captionsSettled, 'off');
    assert.deepEqual(slept, [5, 10], 'it tried three times in all');
    assert.equal((await server.config()).captions, 'off');
    for (const f of FILES) assert.equal((await raw(server, at(f.path))).status, 404, `${how}: ${f.path}`);
    assert.equal(listing(dir)['runtime.wasm'], undefined, 'the wrong file was not kept');
    noParts(dir);
    await server.stop();
    // The next start, with the site put right, fetches only what was missing.
    const good = site();
    const next = await serverWith(t, { dir, autoFetch: true, fetchImpl: good.fetchImpl, ...LIST });
    assert.equal(await next.captionsSettled, 'ready');
    assert.deepEqual(good.asked, [`https://files.example/${VERSION}/runtime.wasm`]);
    assert.equal((await raw(next, at('runtime.wasm'))).status, 200);
  }
});

test('server: stopping gives up a fetch that is under way, and leaves nothing half-written', async (t) => {
  const dir = folder(t);
  const s = site({ 'some-model/onnx/model.onnx': 'stall' });
  const server = await serverWith(t, { dir, autoFetch: true, fetchImpl: s.fetchImpl, ...LIST });
  for (let i = 0; i < 200 && s.asked.length < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await server.config()).captions, 'preparing');
  const began = Date.now();
  await server.stop();
  assert.ok(Date.now() - began < 3000, 'it did not wait for the download');
  assert.equal(await server.captionsSettled, 'off');
  noParts(dir);
  assert.equal(captionsStatus(dir, LIST), 'missing');
});

test('server: the page rules gain exactly one thing, the permission to compile WebAssembly', async (t) => {
  const server = await serverWith(t, { dir: path.join(folder(t), 'none'), ...LIST });
  const before = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  for (const pathname of ['/healthz', '/home', '/visit', '/organize', '/captions-check', '/js/captions-worker.js', '/api/config', at('runtime.wasm'), '/captions-code/x/captions-worker.js']) {
    const csp = (await raw(server, pathname)).headers['content-security-policy'];
    assert.equal(csp, before.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"), pathname);
    assert.equal(csp.match(/'wasm-unsafe-eval'/g).length, 1, pathname);
    // Still no eval, no inline script, no script or connection from another site, no blob: scripts.
    assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'|https?:|\*|script-src[^;]*blob:/, pathname);
  }
});

test('server: the check page is served like every other page, and says nothing about any home', async (t) => {
  const server = await serverWith(t, { dir: path.join(folder(t), 'none'), ...LIST });
  for (const pathname of ['/captions-check', '/captions-check.html']) {
    const res = await raw(server, pathname);
    assert.equal(res.status, 200, pathname);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    const page = res.bytes.toString();
    assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(page, /<script type="module" src="\/js\/captions-check\.js"><\/script>/);
    assert.doesNotMatch(page, /<script(?![^>]*src=)|style=|onclick=|https?:\/\//, 'no inline script or style, and nothing from any other site');
  }
  for (const script of ['captions.js', 'captions-check.js', 'captions-worker.js', 'caption-text.js', 'pcm-worklet.js']) {
    const res = await raw(server, `/js/${script}`);
    assert.equal(res.status, 200, script);
    assert.match(res.headers['content-type'], /javascript/);
    assert.equal(res.headers['cache-control'], 'no-cache', script);
  }
});

test('server: whose work the captions files are is handed out with them, and matches the list', async (t) => {
  const server = await serverWith(t, { dir: path.join(folder(t), 'none'), ...LIST });
  const res = await raw(server, '/third-party');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  const page = res.bytes.toString();
  assert.equal(page, fs.readFileSync(path.join(repository, 'THIRD_PARTY.md'), 'utf8'));
  for (const licence of ['Apache-2.0', 'MIT', 'Public domain']) assert.ok(page.includes(licence), licence);
  for (const holder of ['Hugging Face', 'Microsoft Corporation', 'Useful Sensors', 'Silero Team']) assert.ok(page.includes(holder), holder);
  assert.match(page, /The above copyright notice and this permission notice shall be included/);
  // Every version and revision in the real list is the one named on the page.
  const pinned = new Set(CAPTIONS_FILES.map((f) => (/@([^/]+)\/dist\//.exec(f.url) || /\/resolve\/([0-9a-f]{40})\//.exec(f.url))[1]));
  assert.equal(pinned.size, 5);
  for (const version of pinned) assert.ok(page.includes(version), `${version} is on the page`);
  // Nothing about the owners, any home, or any secret is on it.
  assert.doesNotMatch(page, /Simon|Jeremy|Suzanne|gladspring|onrender|TURN_|SETUP_PASSWORD/i);
  assert.match(fs.readFileSync(path.join(repository, 'public', 'captions-check.html'), 'utf8'), /<a href="\/third-party">/);
});

test('server: the scripts captions run from, under an address that names their content', async (t) => {
  const server = await serverWith(t, { dir: path.join(folder(t), 'none'), ...LIST });
  const code = captionsCodeFrom(path.join(repository, 'public', 'js'));
  assert.deepEqual([...CAPTIONS_CODE], ['captions-worker.js', 'caption-text.js', 'pcm-worklet.js']);
  assert.match(code.id, /^[0-9a-f]{32}$/);
  assert.equal((await server.config()).captionsCode, code.id, '/api/config names them, whether or not captions are ready');
  for (const name of CAPTIONS_CODE) {
    const source = fs.readFileSync(path.join(repository, 'public', 'js', name));
    const res = await raw(server, `/captions-code/${code.id}/${name}`);
    assert.equal(res.status, 200, name);
    assert.ok(res.bytes.equals(source), `${name} is the file in public/js`);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', 'a browser keeps it, and does not ask again');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    // A page still open from before an update asks under the old name: today's script, not to be kept.
    const old = await raw(server, `/captions-code/${'0'.repeat(32)}/${name}`);
    assert.equal(old.status, 200);
    assert.ok(old.bytes.equals(source));
    assert.equal(old.headers['cache-control'], 'no-store');
  }
  // Those three and nothing else.
  for (const pathname of ['captions.js', 'home.js', 'common.js', '../home.js', '%2e%2e%2fhome.js', 'captions-worker.js/', 'CAPTIONS-WORKER.JS', '']) {
    assert.equal((await raw(server, `/captions-code/${code.id}/${pathname}`)).status, 404, pathname);
  }
  assert.equal((await raw(server, `/captions-code/${code.id}`)).status, 404);
  assert.equal((await raw(server, `/captions-code/${code.id}/captions-worker.js`, { method: 'POST' })).status, 404);

  // The name changes when any one of the three files does, and only then.
  const copy = folder(t);
  for (const name of CAPTIONS_CODE) fs.copyFileSync(path.join(repository, 'public', 'js', name), path.join(copy, name));
  assert.equal(captionsCodeFrom(copy).id, code.id);
  for (const name of CAPTIONS_CODE) {
    const was = fs.readFileSync(path.join(copy, name));
    fs.appendFileSync(path.join(copy, name), '\n');
    assert.notEqual(captionsCodeFrom(copy).id, code.id, name);
    fs.writeFileSync(path.join(copy, name), was);
    assert.equal(captionsCodeFrom(copy).id, code.id);
  }
  // The worker asks for its helper beside itself, so both come under the same name.
  assert.match(fs.readFileSync(path.join(repository, 'public', 'js', 'captions-worker.js'), 'utf8'), /from '\.\/caption-text\.js';/);
});

test('server: nothing about the captions files is logged, whatever is asked for', async (t) => {
  const written = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) t.mock.method(console, method, (...args) => written.push(args));
  const dir = await readyFolder(t);
  const server = await serverWith(t, { dir, ...LIST });
  for (const pathname of [at('runtime.wasm'), at('nothing'), at('../../db.json'), at('%00'), at('%'), at('%zz/%e0%a4%a'), '/captions-code/x/y', '/captions-check', '/api/config']) await raw(server, pathname);
  // A file that vanished after the server started: "not found", and no noise.
  fs.rmSync(path.join(dir, 'sample.wav'));
  assert.equal((await raw(server, at('sample.wav'))).status, 404);
  await server.stop();
  // A fetch that fails every time, and one that works.
  const failing = await serverWith(t, { dir: folder(t), autoFetch: true, fetchImpl: site({ 'runtime.wasm': 'offline' }).fetchImpl, sleep: async () => {}, waits: [1], ...LIST });
  assert.equal(await failing.captionsSettled, 'off');
  const working = await serverWith(t, { dir: folder(t), autoFetch: true, fetchImpl: site().fetchImpl, ...LIST });
  assert.equal(await working.captionsSettled, 'ready');
  assert.deepEqual(written, []);
});

test('these tests wrote nothing into the repository', () => {
  assert.deepEqual(repositoryFiles(), repositoryBefore);
});
