// The files live captions need, and how they get onto this server.
//
// Captions are worked out on the home screen's own tablet, from the sound it
// is already playing. For that the tablet needs a speech model and the
// library that runs it: about 49 MB in all. Those files are not in the
// repository and are not an npm dependency. They are listed here, each with
// the exact address it comes from (a pinned version or revision, never
// "latest"), its size and its SHA-256. The server fetches them once, checks
// every byte against this list, and from then on serves them itself: a tablet
// never asks any other site for anything.
//
// Nothing here does I/O on import, and nothing is logged. fetch, the folder
// and the waits are passed in, so the tests can fake them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Part of the address the files are served at (/captions-files/<version>/…).
// Browsers are told to keep them for good, so any change to the list below
// needs a new version here.
export const CAPTIONS_VERSION = 'v1';

const NPM = 'https://cdn.jsdelivr.net/npm';
// The exact build of ONNX Runtime Web that transformers.js 4.3.2 is made for.
const RUNTIME = `${NPM}/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist`;
const MOONSHINE = 'onnx-community/moonshine-tiny-ONNX';
const MOONSHINE_AT = `https://huggingface.co/${MOONSHINE}/resolve/a6da1241cd305dcd64eab1edbd615f2bb9aabb95`;
const VAD = 'onnx-community/silero-vad';
const VAD_AT = `https://huggingface.co/${VAD}/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec`;
const SAMPLE_AT = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/542437c29cc5273cfd29e25c77696f2b349badd7';

const file = (filePath, url, bytes, sha256) => Object.freeze({ path: filePath, url, bytes, sha256 });

export const CAPTIONS_FILES = Object.freeze([
  // The library (transformers.js, Apache-2.0).
  file('transformers.min.js', `${NPM}/@huggingface/transformers@4.3.2/dist/transformers.min.js`, 587_917, '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb'),
  // What runs the models (ONNX Runtime Web, MIT). The plain build only: the
  // "asyncify" build the library would pick by itself gets tabs killed on
  // iPhones and iPads.
  file('ort-wasm-simd-threaded.mjs', `${RUNTIME}/ort-wasm-simd-threaded.mjs`, 24_381, 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f'),
  file('ort-wasm-simd-threaded.wasm', `${RUNTIME}/ort-wasm-simd-threaded.wasm`, 14_264_838, '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3'),
  // The speech model (Moonshine tiny, English, MIT).
  file(`${MOONSHINE}/config.json`, `${MOONSHINE_AT}/config.json`, 921, '558e1e02069137c796ace1e50c48d8fe451f04a295929138e6bea885517f0edb'),
  file(`${MOONSHINE}/generation_config.json`, `${MOONSHINE_AT}/generation_config.json`, 147, 'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44'),
  file(`${MOONSHINE}/preprocessor_config.json`, `${MOONSHINE_AT}/preprocessor_config.json`, 128, 'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679'),
  file(`${MOONSHINE}/tokenizer_config.json`, `${MOONSHINE_AT}/tokenizer_config.json`, 135_735, 'edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15'),
  file(`${MOONSHINE}/tokenizer.json`, `${MOONSHINE_AT}/tokenizer.json`, 3_761_754, '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f'),
  file(`${MOONSHINE}/onnx/encoder_model_quantized.onnx`, `${MOONSHINE_AT}/onnx/encoder_model_quantized.onnx`, 7_937_661, 'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a'),
  file(`${MOONSHINE}/onnx/decoder_model_merged_quantized.onnx`, `${MOONSHINE_AT}/onnx/decoder_model_merged_quantized.onnx`, 20_243_286, 'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367'),
  // What tells speech from quiet (Silero VAD, MIT).
  file(`${VAD}/onnx/model.onnx`, `${VAD_AT}/onnx/model.onnx`, 2_243_022, 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808'),
  // Eleven seconds of clear English speech for the check page and the tests
  // (President Kennedy, 1961; public domain).
  file('jfk.wav', `${SAMPLE_AT}/jfk.wav`, 1_940_478, 'aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8'),
]);

// How each kind of file is sent. The server also sends "nosniff", so a
// browser will only run or compile a file sent as what it is.
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.wav': 'audio/wav',
};
export const captionsType = (filePath) => TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

// Where the files are kept: CAPTIONS_DIR, or a "captions/<version>" folder
// beside the data file (on Render that is the disk, which survives deploys).
export function captionsDirFrom(env = {}, { cwd = process.cwd(), version = CAPTIONS_VERSION } = {}) {
  const asked = String(env.CAPTIONS_DIR ?? '').trim();
  if (asked) return path.resolve(cwd, asked);
  const dataFile = String(env.DATA_FILE ?? '').trim() || path.join(cwd, 'data', 'db.json');
  return path.join(path.dirname(path.resolve(cwd, dataFile)), 'captions', version);
}

// CAPTIONS=off switches captions off altogether: nothing is fetched or served.
export const captionsSwitchedOff = (env = {}) => String(env.CAPTIONS ?? '').trim().toLowerCase() === 'off';

const VERIFIED = 'verified.json';
const PART = '.part';

// The place on disk for one file of the list, or null for anything that is
// not on the list. Only ever called with a path from the list itself; the
// check that it stays inside the folder is a second lock on the same door.
export function captionsFilePath(dir, filePath, files = CAPTIONS_FILES) {
  if (typeof dir !== 'string' || !dir || !files.some((f) => f.path === filePath)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, filePath);
  return full.startsWith(root + path.sep) ? full : null;
}

function readVerified(dir) {
  try {
    const noted = JSON.parse(fs.readFileSync(path.join(dir, VERIFIED), 'utf8'));
    return noted && typeof noted === 'object' && noted.files && typeof noted.files === 'object' ? noted : null;
  } catch {
    return null;
  }
}

const sizeOf = (full) => { try { const stat = fs.statSync(full); return stat.isFile() ? stat.size : -1; } catch { return -1; } };

// 'ready' only when every file of the list is there with the right size, and
// the note written after every checksum was verified names exactly this list.
// Anything else is 'missing'. Cheap enough to ask at every start: it reads
// one small file and looks at the sizes of the rest.
export function captionsStatus(dir, { files = CAPTIONS_FILES, version = CAPTIONS_VERSION } = {}) {
  if (typeof dir !== 'string' || !dir) return 'missing';
  const noted = readVerified(dir);
  if (!noted || noted.version !== version) return 'missing';
  for (const f of files) {
    const full = captionsFilePath(dir, f.path, files);
    if (!full || noted.files[f.path] !== f.sha256 || sizeOf(full) !== f.bytes) return 'missing';
  }
  return 'ready';
}

function sha256OfFile(full) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(full);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Is the file already here, whole and exactly as listed?
async function alreadyGood(full, f) {
  return sizeOf(full) === f.bytes && (await sha256OfFile(full)) === f.sha256;
}

// Clears away what an interrupted run left behind (files under a temporary
// name; never anything under a final name).
function removeParts(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeParts(full);
    else if (entry.name.endsWith(PART)) fs.rmSync(full, { force: true });
  }
}

const write = (stream, chunk) => new Promise((resolve, reject) => { stream.write(chunk, (err) => (err ? reject(err) : resolve())); });
const finish = (stream) => new Promise((resolve, reject) => { stream.on('error', reject); stream.end(resolve); });

// Downloads one file under a temporary name, checks it, and only then gives
// it its real name. Returns null when all is well, or a short reason.
async function fetchOne(full, f, { fetchImpl, signal, stallMs, onBytes }) {
  const tmp = `${full}.${crypto.randomBytes(6).toString('hex')}${PART}`;
  const stop = new AbortController();
  const outside = () => stop.abort();
  if (signal?.aborted) return 'stopped';
  signal?.addEventListener('abort', outside, { once: true });
  // A download that stops moving must not hold everything up for ever.
  let timer = null;
  let stalled = false;
  const watch = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; stop.abort(); }, stallMs); };
  let out = null;
  try {
    watch();
    const res = await fetchImpl(f.url, { signal: stop.signal, redirect: 'follow' });
    if (!res.ok || !res.body) {
      try { await res.body?.cancel(); } catch { /* nothing to let go of */ }
      return `http_${res.status}`;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    out = fs.createWriteStream(tmp, { mode: 0o644 });
    const hash = crypto.createHash('sha256');
    let got = 0;
    for await (const chunk of res.body) {
      watch();
      got += chunk.length;
      // More than the list says: not our file. Stop before the disk fills.
      if (got > f.bytes) { stop.abort(); return 'wrong_size'; }
      hash.update(chunk);
      await write(out, chunk);
      onBytes?.(chunk.length);
    }
    await finish(out);
    out = null;
    if (got !== f.bytes) return 'wrong_size';
    if (hash.digest('hex') !== f.sha256) return 'wrong_checksum';
    fs.renameSync(tmp, full);
    return null;
  } catch {
    return stalled ? 'stalled' : signal?.aborted ? 'stopped' : 'network';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', outside);
    if (out) await new Promise((resolve) => { out.on('close', resolve); out.destroy(); });
    fs.rmSync(tmp, { force: true });
  }
}

// Brings the folder to the state of the list. Safe to run again at any time:
// a file that is already there and passes its checksum is kept, and only the
// rest is downloaded. A file is never left half-written, or wrong, under its
// final name. The note that makes the folder 'ready' is written last, after
// every file has been verified.
//   onProgress({ path, loaded, total })  bytes of the whole list so far
// Never throws: { ok: true } or { ok: false, failed: [{ path, reason }] }.
export async function fetchCaptionsFiles(dir, {
  fetchImpl = globalThis.fetch, onProgress, signal, stallMs = 60_000, files = CAPTIONS_FILES, version = CAPTIONS_VERSION,
} = {}) {
  const failed = [];
  const fetched = [];
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  let loaded = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    removeParts(dir);
    for (const f of files) {
      const full = captionsFilePath(dir, f.path, files);
      if (!full) { failed.push({ path: f.path, reason: 'bad_path' }); continue; }
      if (await alreadyGood(full, f)) {
        loaded += f.bytes;
        onProgress?.({ path: f.path, loaded, total });
        continue;
      }
      // Something is missing or wrong, so the folder is not 'ready' while we
      // work, and a wrong file does not keep its name.
      fs.rmSync(path.join(dir, VERIFIED), { force: true });
      fs.rmSync(full, { force: true });
      const before = loaded;
      const reason = await fetchOne(full, f, { fetchImpl, signal, stallMs, onBytes: (n) => { loaded += n; onProgress?.({ path: f.path, loaded, total }); } });
      if (reason) {
        loaded = before;
        failed.push({ path: f.path, reason });
        if (reason === 'stopped') break;
      } else {
        fetched.push(f.path);
      }
    }
    if (failed.length) return { ok: false, failed, fetched };
    // Nothing had to be fetched and the note is already there: leave it be.
    if (!fetched.length && captionsStatus(dir, { files, version }) === 'ready') return { ok: true, failed, fetched };
    const note = { version, verifiedAt: new Date().toISOString(), files: Object.fromEntries(files.map((f) => [f.path, f.sha256])) };
    const tmp = path.join(dir, `${VERIFIED}.${crypto.randomBytes(6).toString('hex')}${PART}`);
    fs.writeFileSync(tmp, JSON.stringify(note, null, 2));
    fs.renameSync(tmp, path.join(dir, VERIFIED));
    return { ok: true, failed, fetched };
  } catch {
    // The disk is full, or the folder cannot be written.
    return { ok: false, failed: [...failed, { path: '', reason: 'disk' }], fetched };
  }
}

// What the server does when it starts and the files are not there: fetch
// them, and if that fails try again a few times, each after a longer wait.
// Then it gives up until the next start. Resolves true when the folder is
// ready. `sleep(ms, signal)` and the waits can be replaced by the tests.
export const CAPTIONS_RETRY_WAITS = Object.freeze([30_000, 2 * 60_000, 10 * 60_000]);
const napFor = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  timer.unref?.();
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});
export async function prepareCaptionsFiles(dir, { waits = CAPTIONS_RETRY_WAITS, sleep = napFor, signal, ...options } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) return false;
    const result = await fetchCaptionsFiles(dir, { ...options, signal });
    if (result.ok) return captionsStatus(dir, options) === 'ready';
    if (signal?.aborted || attempt >= waits.length) return false;
    await sleep(waits[attempt], signal);
  }
}

// ----- The scripts captions run from -----
// Three small files of our own (public/js). A tablet that asked for them at
// the start of each visit would be telling the host when visits happen, so
// they are also served under an address that names their content, which a
// browser may keep for good: once it has them, it asks for nothing.
export const CAPTIONS_CODE = Object.freeze(['captions-worker.js', 'caption-text.js', 'pcm-worklet.js']);
// Reads them from `folder`, once. `id` changes whenever any of them does.
export function captionsCodeFrom(folder, names = CAPTIONS_CODE) {
  const files = new Map();
  const hash = crypto.createHash('sha256');
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(folder, name));
    files.set(name, bytes);
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return { id: hash.digest('hex').slice(0, 32), files };
}
