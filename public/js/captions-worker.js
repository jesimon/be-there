// Live captions: the part that listens. It runs beside the page, so that
// working out the words never makes the picture stutter.
//
// The page (captions.js) hands it the visitor's sound in small blocks. Here a
// speech detector finds where each sentence starts and ends, and a small
// speech model (Moonshine tiny, English) writes the words. Both run on this
// device. The words go back to the page that asked, and nowhere else: this
// file sends nothing to any server and stores no words anywhere.
//
// The model and the library that runs it come from our own server
// (/captions-files/…, see lib/captions-files.js), and are kept on the device
// after the first time. Nothing is ever asked of any other site.
//
// Messages in:   { type: 'load' }
//                { type: 'audio', samples, rate, t }     t: when the page got the block
//                { type: 'transcribe', id, samples, rate }   (the check page only)
// Messages out:  { type: 'progress', percent, fetching }
//                { type: 'ready', loadMs, fetchedBytes }
//                { type: 'caption', kind: 'partial' | 'final', id, text, delayMs }
//                { type: 'paused' } and { type: 'resumed' }
//                { type: 'lag', ms }                      about once a second
//                { type: 'transcribed', id, text, ms, seconds }
//                { type: 'error', code: 'unavailable' | 'too_slow', message }
// Pages that are already open keep talking to newer versions of this file:
// add to these messages, never rename or remove.
import { RATE, CAPTION_FILES as FILES, createProgress, createResampler, createCaptioner, maxNewTokens, padToOneSecond, tidy } from './caption-text.js';

const origin = self.location.origin;
const filesAt = `${origin}${FILES.base}`;
// The device's own store for the files, named after their version. Only the
// model and what runs it ever go in it.
const KEPT = `bethere-captions-${FILES.base.split('/').filter(Boolean).pop()}`;
const clock = () => performance.timeOrigin + performance.now();
// The one way anything leaves this worker: a message to the page that made it.
const tell = (message) => self.postMessage(message);

let transcriber = null;     // the speech model
let detector = null;        // tells speech from quiet
let Tensor = null;
let progress = createProgress();
let fetching = false;       // something large is coming over the network
let fetchedBytes = 0;
let lastPercent = -1;

function report(percent) {
  if (percent === lastPercent) return;
  lastPercent = percent;
  tell({ type: 'progress', percent, fetching });
}

// Counts a file as it arrives, so the page can show how far a first download
// has got.
function counted(response, path) {
  if (!response.ok || !response.body || !(path in FILES.sizes) || typeof TransformStream !== 'function') return response;
  fetching = true;
  const through = new TransformStream({
    transform(chunk, controller) {
      fetchedBytes += chunk.byteLength;
      report(progress.add(path, chunk.byteLength));
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(through), { status: response.status, statusText: response.statusText, headers: response.headers });
}

// The library fetches the model through this and nothing else: our own files,
// from our own server. Anything else it might ask for is "not there".
async function ownFile(input) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input?.url ?? String(input), self.location.href); } catch { return new Response(null, { status: 404 }); }
  if (url.origin !== origin || !url.pathname.startsWith(FILES.base)) return new Response(null, { status: 404 });
  return counted(await fetch(url.href), url.pathname.slice(FILES.base.length));
}

async function openKept() {
  try {
    // An older version's files are of no use any more: free the room.
    for (const name of await caches.keys()) if (name.startsWith('bethere-captions-') && name !== KEPT) await caches.delete(name);
    return await caches.open(KEPT);
  } catch {
    return null;        // private browsing, or no room: fetch each time instead
  }
}

// The compiled code that runs the models: 14 MB, kept on the device after the
// first time, so that later visits ask the server for nothing.
async function runtimeBinary(kept) {
  const path = FILES.runtimeBinary;
  const url = `${filesAt}${path}`;
  const size = FILES.sizes[path];
  try {
    const saved = await kept?.match(url);
    const bytes = saved ? await saved.arrayBuffer() : null;
    if (bytes?.byteLength === size) { report(progress.done(path)); return bytes; }
  } catch { /* not kept after all */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The captions files are not there (${response.status}).`);
  const bytes = await counted(response, path).arrayBuffer();
  if (bytes.byteLength !== size) throw new Error('The captions files did not arrive whole.');
  try { await kept?.put(url, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(size) } })); } catch { /* no room: fetched again next time */ }
  return bytes;
}

async function load() {
  const started = performance.now();
  progress = createProgress();
  fetching = false;
  fetchedBytes = 0;
  lastPercent = -1;
  report(0);
  const kept = await openKept();
  // What is already on the device counts as arrived.
  if (kept) {
    for (const path of Object.keys(FILES.sizes)) {
      try { if (await kept.match(`${filesAt}${path}`)) progress.done(path); } catch { /* fetched below */ }
    }
    report(progress.percent());
  }

  const library = await import(`${filesAt}${FILES.library}`);
  report(progress.done(FILES.library));
  const { env, pipeline, AutoModel } = library;
  Tensor = library.Tensor;
  // Everything from our own server, and nothing from anywhere else.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = FILES.base;
  env.fetch = ownFile;
  env.cacheKey = KEPT;
  if (library.LogLevel) env.logLevel = library.LogLevel.ERROR;
  // The plain build of the runtime, on one thread, named outright. Left to
  // itself the library picks another build (which gets tabs killed on
  // iPhones and iPads) from another site, and loads it in a way our page
  // rules forbid.
  env.useWasmCache = false;
  const runtime = env.backends.onnx.wasm;
  runtime.wasmPaths = { mjs: `${filesAt}${FILES.runtime}`, wasm: `${filesAt}${FILES.runtimeBinary}` };
  runtime.numThreads = 1;
  runtime.proxy = false;
  runtime.wasmBinary = await runtimeBinary(kept);

  transcriber = await pipeline('automatic-speech-recognition', FILES.model, { device: 'wasm', dtype: 'q8' });
  report(progress.done(FILES.runtime));
  detector = await AutoModel.from_pretrained(FILES.detector, { config: { model_type: 'custom' }, dtype: 'fp32', device: 'wasm' });
  // The first run is slow (it sets things up): do it now, on a second of quiet.
  await transcriber(new Float32Array(RATE), { max_new_tokens: maxNewTokens(1) });
  newDetectorState();
  await speechProbability(new Float32Array(512));
  newDetectorState();
  for (const path of Object.keys(FILES.sizes)) progress.done(path);
  report(progress.percent());
  return Math.round(performance.now() - started);
}

// ----- Speech or quiet -----
let detectorRate = null;
let detectorState = null;
function newDetectorState() {
  detectorRate = new Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
  detectorState = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}
async function speechProbability(frame) {
  const { stateN, output } = await detector({ input: new Tensor('float32', frame, [1, frame.length]), sr: detectorRate, state: detectorState });
  detectorState = stateN;
  return output.data[0];
}

// ----- Listening -----
// The rules for turning sound into captions are in caption-text.js; here they
// are given the two models and the way back to the page.
async function write(clip, maxTokens) {
  const result = await transcriber(clip, { max_new_tokens: maxTokens });
  return result?.text;
}
let captioner = null;

// The check page's quick test: the words in one clip, and how long it took.
async function transcribe({ id, samples, rate }) {
  const sound = padToOneSecond(createResampler(rate, RATE).push(samples));
  const started = performance.now();
  const text = tidy(await write(sound, maxNewTokens(sound.length / RATE)));
  tell({ type: 'transcribed', id, text, ms: Math.round(performance.now() - started), seconds: sound.length / RATE });
}
const sayBroken = (err) => tell({ type: 'error', code: 'unavailable', message: String(err?.message || err).slice(0, 300) });

self.onmessage = (e) => {
  const message = e.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'load') {
    load().then((loadMs) => {
      captioner = createCaptioner({ speechProbability, write, resetDetector: newDetectorState, tell, clock });
      tell({ type: 'ready', loadMs, fetchedBytes });
    }).catch(sayBroken);
  } else if (message.type === 'audio') {
    // Sound that comes before the model is ready is not kept: it would be old
    // by the time it could be captioned.
    captioner?.push(message);
  } else if (message.type === 'transcribe') {
    if (transcriber) transcribe(message).catch(sayBroken);
  }
};
