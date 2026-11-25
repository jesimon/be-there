// Live captions: the page's side.
//
// During a visit the home screen can show, in large letters, what the visitor
// is saying. This file listens in on the sound the tablet is already playing,
// hands it to a worker on the same device (captions-worker.js), and gives the
// words it writes to the page to show. That is all the further they go:
// nothing here sends a word of them anywhere, and nothing here stores them.
// When captions stop, the worker is ended and the words are gone.
//
// Captions are a trial, in English only, and they make mistakes. They are off
// until the person at home switches them on; the one thing remembered on the
// tablet is that choice.
import { NO_CAPTIONS, addCaption, linesToShow, typicalAndWorst } from './caption-text.js';

// How long things may take, in milliseconds.
export const CAPTION_TIMES = Object.freeze({
  loadLimit: 90_000,        // not ready this long after switching on: off for this visit
  downloadGrace: 30_000,    // …unless a first download is still arriving: then this long after its last progress
  notice: 5_000,            // "Captions are on. They can contain mistakes." stays this long, or until the first words
  pausedLine: 4_000,        // "Captions paused, catching up" stays this long after catching up, or until the next words
});

const WORKER = 'captions-worker.js';
const WORKLET = 'pcm-worklet.js';

// ----- Can this browser do it, and does the person want it -----

// Does this browser know workers that are modules? Asking for one at an
// address that is no address reads the answer and starts nothing.
function moduleWorkers(scope) {
  let asked = false;
  try { new scope.Worker('http://[', { get type() { asked = true; return 'module'; } }).terminate(); } catch { /* as expected */ }
  return asked;
}

export function captionsSupported(scope = globalThis) {
  try {
    return typeof scope.Worker === 'function' && typeof scope.AudioWorkletNode === 'function'
      && typeof scope.WebAssembly === 'object' && typeof scope.WebAssembly.instantiate === 'function'
      && typeof scope.MediaStream === 'function' && moduleWorkers(scope);
  } catch {
    return false;
  }
}

// The person at home's choice, remembered on this tablet: 'on' or 'off', and
// nothing else, ever.
export const CAPTIONS_KEY = 'bethere.captions';
export function captionsRemembered(storage) {
  try { return (storage || localStorage).getItem(CAPTIONS_KEY) === 'on'; } catch { return false; }
}
export function rememberCaptions(on, storage) {
  try { (storage || localStorage).setItem(CAPTIONS_KEY, on ? 'on' : 'off'); } catch { /* not remembered: they can switch it on again */ }
}

// Where the scripts captions run from are. The server gives them an address
// that names their content (`code`, from /api/config), which a browser may
// keep for good: once a tablet has them, starting captions asks the server
// for nothing. Without it, their ordinary address.
export function captionsCodeAt(code) {
  return typeof code === 'string' && /^[a-f0-9]{16,64}$/.test(code) ? `/captions-code/${code}` : '/js';
}

// ----- The words on the screen -----

// What the caption box says when it is not showing captions.
export function captionWords(state, percent) {
  switch (state) {
    case 'loading': return typeof percent === 'number' ? `Getting captions ready… ${percent}%` : 'Getting captions ready…';
    case 'notice': return 'Captions are on. They can contain mistakes.';
    case 'needs_tap': return 'Tap the screen to start captions.';
    case 'paused': return 'Captions paused, catching up';
    case 'too_slow': return 'Captions can’t keep up on this tablet.';
    case 'unavailable': return 'Captions aren’t available on this tablet.';
    default: return '';
  }
}

// Fills a caption box: a line about the captions themselves, or else the
// captions. With nothing to say the box is hidden, so it covers no more of
// the picture than it must.
export function showCaptions(box, { state = 'off', percent, lines = [] } = {}) {
  if (!box) return;
  const words = captionWords(state, percent);
  const rows = words ? [words] : state === 'on' ? lines : [];
  const key = `${words ? 'status' : 'words'}\n${rows.join('\n')}`;
  if (box.dataset.shown === key) return;
  box.dataset.shown = key;
  box.classList.toggle('is-status', !!words);
  box.replaceChildren(...rows.map((row) => {
    const line = document.createElement('p');
    line.textContent = row;
    return line;
  }));
  box.hidden = rows.length === 0;
}

// ----- The worker -----

// Starts the worker and has it load the model. `onMessage` gets everything it
// says after that. Used by a visit (below) and by the check page.
//   ready    resolves with { loadMs, fetchedBytes } when it can take sound
//   failed   resolves with { code, message } if it never can, or breaks later
export function openCaptionsWorker({ codeAt = '/js', onProgress, onMessage, deps = {} } = {}) {
  const Make = deps.Worker || globalThis.Worker;
  let worker = null;
  let over = false;
  let isReady = false;
  let whenReady;
  let whenFailed;
  const ready = new Promise((resolve) => { whenReady = resolve; });
  const failed = new Promise((resolve) => { whenFailed = resolve; });
  const fail = (code, message = '') => { if (!over) whenFailed({ code, message: String(message || '') }); };
  try {
    worker = new Make(`${codeAt}/${WORKER}`, { type: 'module' });
    worker.onmessage = (e) => {
      const message = e.data;
      if (over || !message || typeof message !== 'object') return;
      if (message.type === 'progress') onProgress?.(message);
      else if (message.type === 'ready') { isReady = true; whenReady(message); }
      else if (message.type === 'error') fail(message.code === 'too_slow' ? 'too_slow' : 'unavailable', message.message);
      else onMessage?.(message);
    };
    // The script could not be loaded, or it broke.
    worker.onerror = (e) => { e?.preventDefault?.(); fail('unavailable', e?.message); };
    worker.postMessage({ type: 'load' });
  } catch (err) {
    fail('unavailable', err?.message);
  }
  return {
    ready,
    failed,
    get isReady() { return isReady && !over; },
    send(message, transfer) { if (!over && worker) worker.postMessage(message, transfer || []); },
    close() {
      if (over) return;
      over = true;
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
      worker = null;
    },
  };
}

// ----- Captions for one visit -----

// An AudioContext of our own, for when the page has none to lend. Made once.
let ownContext = null;
function contextOfOurOwn(scope) {
  const Context = scope.AudioContext || scope.webkitAudioContext;
  ownContext ||= new Context();
  return ownContext;
}
// Each AudioContext learns the listening module once.
const taught = new WeakMap();
function teach(context, codeAt) {
  if (!taught.has(context)) {
    const learning = context.audioWorklet.addModule(`${codeAt}/${WORKLET}`);
    learning.catch(() => taught.delete(context));
    taught.set(context, learning);
  }
  return taught.get(context);
}

// Starts captions.
//   remoteStream  the visitor's picture and sound, once it is playing in the
//                 page's <video> (or give it later, with listenTo)
//   audioContext  the page's AudioContext, if it has one (the chime's)
//   onUpdate      called with the lines to show (an empty list: nothing)
//   onStatus      called with (state, { percent }):
//                   'loading'      getting ready (percent only during a first download)
//                   'notice'       ready; say that captions can contain mistakes
//                   'on'           showing captions
//                   'needs_tap'    the browser wants a tap before it lets us listen
//                   'paused'       fell behind; catching up
//                   'too_slow'     cannot keep up: stopped for this visit
//                   'unavailable'  cannot run here: stopped for this visit
//                   'off'          stopped
//   codeAt        where the worker's scripts are (captionsCodeAt)
// Returns { stop, listenTo, nudge, numbers }. Nothing here ever throws into
// the visit: whatever goes wrong ends as 'unavailable'.
export function startCaptions({ remoteStream = null, audioContext = null, onUpdate, onStatus, codeAt = '/js', deps = {} } = {}) {
  const scope = deps.scope || globalThis;
  const later = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout || ((id) => clearTimeout(id));
  const now = deps.now || (() => performance.timeOrigin + performance.now());

  let stopped = false;
  let state = '';
  let lines = NO_CAPTIONS;
  let shown = [];
  let context = null;
  let source = null;
  let tap = null;
  let mute = null;
  let heard = null;           // the sound track we are listening to
  let wanted = remoteStream;
  let engine = null;
  let loadTimer = null;
  let noticeTimer = null;
  let pausedTimer = null;     // set while the "paused" line stays up after catching up
  let ready = false;
  let paused = false;
  const numbers = { lags: [], delays: [], pauses: 0, captions: 0, loadMs: 0, fetchedBytes: 0, rate: 0, blocks: 0, loudest: 0 };

  const status = (next, info = {}) => {
    if (stopped && next !== 'off') return;
    if (next === state && next !== 'loading') return;
    state = next;
    try { onStatus?.(next, info); } catch { /* the page's own trouble */ }
  };
  const update = (next) => {
    lines = next;
    const rows = linesToShow(lines);
    if (rows.length === shown.length && rows.every((row, i) => row === shown[i])) return;
    shown = rows;
    try { onUpdate?.(rows); } catch { /* the page's own trouble */ }
  };

  function letGo() {
    cancel(loadTimer);
    cancel(noticeTimer);
    cancel(pausedTimer);
    engine?.close();
    engine = null;
    try { if (tap) { tap.port.onmessage = null; tap.port.postMessage('stop'); tap.port.close?.(); } } catch { /* already gone */ }
    for (const node of [source, tap, mute]) { try { node?.disconnect(); } catch { /* already gone */ } }
    if (context && onContextChange) { try { context.removeEventListener?.('statechange', onContextChange); } catch { /* ignore */ } }
    source = null;
    tap = null;
    mute = null;
    heard = null;
  }

  // Ends captions: stops listening, ends the worker, and takes the words away.
  function stop(why = 'off') {
    if (stopped) return;
    letGo();
    update(NO_CAPTIONS);
    status(why);
    stopped = true;
  }

  // What to say now that something has changed.
  function settle() {
    if (stopped || !ready) return;
    if (paused || pausedTimer) return status('paused');
    if (context && context.state !== 'running') return status('needs_tap');
    if (noticeTimer && !shown.length) return status('notice');
    status('on');
  }
  const onContextChange = () => settle();
  // The notice has done its job once there are words, or trouble, to show.
  const endNotice = () => { cancel(noticeTimer); noticeTimer = null; };

  // Gives the worker `ms` more to get ready before we call it a day.
  function allow(ms) {
    cancel(loadTimer);
    loadTimer = later(() => { loadTimer = null; if (!ready) stop('unavailable'); }, ms);
  }

  function fromWorker(message) {
    if (stopped) return;
    if (message.type === 'caption') {
      if (paused) return;
      endNotice();
      cancel(pausedTimer);
      pausedTimer = null;
      if (typeof message.delayMs === 'number') numbers.delays.push(message.delayMs);
      if (message.kind === 'final') numbers.captions += 1;
      update(addCaption(lines, message));
      settle();
    } else if (message.type === 'paused') {
      paused = true;
      endNotice();
      cancel(pausedTimer);
      pausedTimer = null;
      numbers.pauses += 1;
      // What was on the screen is seconds old, and words were missed.
      update(NO_CAPTIONS);
      settle();
    } else if (message.type === 'resumed') {
      paused = false;
      // Catching up takes a moment; the line that says words were missed
      // stays long enough to be read: until the next words, or a few seconds.
      cancel(pausedTimer);
      pausedTimer = later(() => { pausedTimer = null; settle(); }, CAPTION_TIMES.pausedLine);
      settle();
    } else if (message.type === 'lag') {
      if (typeof message.ms === 'number') numbers.lags.push(message.ms);
    }
  }

  // Listens to the sound of `stream` (again, if its sound track has changed).
  function listenTo(stream) {
    if (stopped) return;
    wanted = stream || wanted;
    const track = wanted?.getAudioTracks?.()[0] || null;
    if (!track || !tap || track === heard) return;
    try {
      source?.disconnect();
      source = context.createMediaStreamSource(new scope.MediaStream([track]));
      source.connect(tap);
      heard = track;
    } catch {
      stop('unavailable');
    }
  }

  // A tap on the page: some browsers let sound be listened to only after one.
  function nudge() {
    if (stopped || !context || context.state === 'running') return;
    try { Promise.resolve(context.resume()).catch(() => {}); } catch { /* still waiting for a tap */ }
  }

  async function begin() {
    context = audioContext || contextOfOurOwn(scope);
    numbers.rate = context.sampleRate;
    nudge();
    context.addEventListener?.('statechange', onContextChange);
    await teach(context, codeAt);
    if (stopped) return;
    // The sound goes: visitor -> our listener -> a volume of nothing -> out.
    // The last two steps keep the browser passing sound through the listener
    // without playing it a second time.
    tap = new scope.AudioWorkletNode(context, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    mute = context.createGain();
    mute.gain.value = 0;
    tap.connect(mute);
    mute.connect(context.destination);
    tap.port.onmessage = (e) => {
      const block = e.data;
      if (stopped || !block?.samples) return;
      // For the check page: was there any sound at all? (Some browsers hand
      // a page silence in place of a visitor's voice.)
      numbers.blocks += 1;
      for (let i = 0; i < block.samples.length; i += 16) numbers.loudest = Math.max(numbers.loudest, Math.abs(block.samples[i]));
      // Until the model is ready there is nobody to hear it.
      if (!engine?.isReady) return;
      engine.send({ type: 'audio', samples: block.samples, rate: block.rate, t: now() }, [block.samples.buffer]);
    };
    listenTo(wanted);
  }

  status('loading');
  allow(CAPTION_TIMES.loadLimit);
  const startedAt = now();
  engine = openCaptionsWorker({
    codeAt,
    deps,
    onProgress: ({ percent, fetching }) => {
      if (stopped || ready) return;
      // A first download that is still arriving is not a tablet that cannot
      // do it: give it time for as long as it keeps moving.
      if (fetching) {
        const left = CAPTION_TIMES.loadLimit - (now() - startedAt);
        if (left < CAPTION_TIMES.downloadGrace) allow(CAPTION_TIMES.downloadGrace);
      }
      status('loading', fetching && typeof percent === 'number' ? { percent } : {});
    },
    onMessage: fromWorker,
  });
  engine.failed.then(({ code }) => stop(code === 'too_slow' ? 'too_slow' : 'unavailable'));
  engine.ready.then((info) => {
    if (stopped) return;
    ready = true;
    cancel(loadTimer);
    loadTimer = null;
    numbers.loadMs = info?.loadMs || 0;
    numbers.fetchedBytes = info?.fetchedBytes || 0;
    noticeTimer = later(() => { noticeTimer = null; settle(); }, CAPTION_TIMES.notice);
    settle();
  });
  begin().catch(() => stop('unavailable'));

  return {
    stop: () => stop('off'),
    listenTo,
    nudge,
    // For the check page: how it went, in numbers only.
    numbers: () => ({
      lag: typicalAndWorst(numbers.lags), delay: typicalAndWorst(numbers.delays), pauses: numbers.pauses, captions: numbers.captions,
      loadMs: numbers.loadMs, fetchedBytes: numbers.fetchedBytes, rate: numbers.rate,
      heard: { blocks: numbers.blocks, loudest: Math.round(numbers.loudest * 1000) / 1000 },
    }),
  };
}
