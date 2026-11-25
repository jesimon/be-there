// Live captions: the thinking, without the machinery.
//
// During a visit the home screen can show, in large letters, what the visitor
// is saying, for someone who finds it hard to hear. The words are worked out
// on the tablet itself, from the sound it is already playing. This file holds
// the rules for that and nothing else:
//
//   - where one sentence ends and the next begins (from how likely each
//     moment of sound is to be speech),
//   - which words of a sentence still being spoken are safe to show,
//   - what to do when the tablet cannot keep up,
//   - how many words the speech model may write for a clip,
//   - bringing sound to the rate the model wants,
//   - which lines are on the screen.
//
// It is pure: no page, no network, no storage, no clock of its own. The
// worker (captions-worker.js), the page (captions.js) and the tests all use
// it as it is. Caption text passes through here and is never kept.

export const RATE = 16_000;      // the speech model's sample rate
export const FRAME = 512;        // the speech detector looks at this many samples at a time (32 ms)

// Where the server keeps the model and the library (lib/captions-files.js),
// and how large each file is, to show how far a first download has got.
// A test holds this to the server's own list.
export const CAPTION_FILES = Object.freeze({
  base: '/captions-files/v1/',
  library: 'transformers.min.js',
  runtime: 'ort-wasm-simd-threaded.mjs',
  runtimeBinary: 'ort-wasm-simd-threaded.wasm',
  model: 'onnx-community/moonshine-tiny-ONNX',
  detector: 'onnx-community/silero-vad',
  sample: 'jfk.wav',
  sizes: Object.freeze({
    'transformers.min.js': 587_917,
    'ort-wasm-simd-threaded.mjs': 24_381,
    'ort-wasm-simd-threaded.wasm': 14_264_838,
    'onnx-community/moonshine-tiny-ONNX/config.json': 921,
    'onnx-community/moonshine-tiny-ONNX/generation_config.json': 147,
    'onnx-community/moonshine-tiny-ONNX/preprocessor_config.json': 128,
    'onnx-community/moonshine-tiny-ONNX/tokenizer_config.json': 135_735,
    'onnx-community/moonshine-tiny-ONNX/tokenizer.json': 3_761_754,
    'onnx-community/moonshine-tiny-ONNX/onnx/encoder_model_quantized.onnx': 7_937_661,
    'onnx-community/moonshine-tiny-ONNX/onnx/decoder_model_merged_quantized.onnx': 20_243_286,
    'onnx-community/silero-vad/onnx/model.onnx': 2_243_022,
  }),
});

// How much of the files has arrived, as a whole number of percent that never
// goes down and reaches 100 only when every file is in.
export function createProgress(sizes = CAPTION_FILES.sizes) {
  const total = Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0);
  const got = new Map();
  let shown = 0;
  const percent = () => {
    let bytes = 0;
    for (const n of got.values()) bytes += n;
    const all = got.size === Object.keys(sizes).length && bytes >= total;
    shown = Math.max(shown, all ? 100 : Math.min(99, Math.floor((bytes / total) * 100)));
    return shown;
  };
  return {
    total,
    // `bytes` more of the file at `path` have arrived.
    add(path, bytes) {
      if (path in sizes && bytes > 0) got.set(path, Math.min(sizes[path], (got.get(path) || 0) + bytes));
      return percent();
    },
    // The whole of the file at `path` is here (it was kept from last time).
    done(path) {
      if (path in sizes) got.set(path, sizes[path]);
      return percent();
    },
    percent,
  };
}

// ----- Sound at the rate the model wants -----

// Changes the sample rate of sound that arrives a block at a time. Going
// down (a tablet plays at 44,100 or 48,000 samples a second; the model wants
// 16,000) each new sample is the average of the stretch of old ones it
// covers, which also keeps high notes from turning into noise. Going up, it
// draws a straight line between neighbours. Blocks join without a seam.
export function createResampler(fromRate, toRate = RATE) {
  if (!(fromRate > 0) || !(toRate > 0) || !Number.isFinite(fromRate) || !Number.isFinite(toRate)) throw new RangeError('A sample rate must be a positive number.');
  if (fromRate === toRate) return { push: (block) => block };
  const step = fromRate / toRate;       // old samples for each new one
  let carry = new Float32Array(0);      // old samples not used up yet
  let offset = 0;                       // where in `carry` the next new sample starts
  const join = (block) => {
    if (!carry.length) return block;
    const joined = new Float32Array(carry.length + block.length);
    joined.set(carry);
    joined.set(block, carry.length);
    return joined;
  };
  const keep = (x, used) => {
    const from = Math.min(x.length, Math.floor(used));
    carry = x.slice(from);
    offset = used - from;
  };
  if (step > 1) {
    return {
      push(block) {
        const x = join(block);
        const n = Math.max(0, Math.floor((x.length - offset) / step + 1e-9));
        const out = new Float32Array(n);
        for (let k = 0; k < n; k += 1) {
          const a = offset + k * step;
          const b = Math.min(x.length, a + step);
          let sum = 0;
          for (let i = Math.floor(a); i < b; i += 1) sum += x[i] * (Math.min(b, i + 1) - Math.max(a, i));
          out[k] = sum / step;
        }
        keep(x, offset + n * step);
        return out;
      },
    };
  }
  return {
    push(block) {
      const x = join(block);
      // A new sample needs the old one after it as well.
      let n = Math.max(0, Math.ceil((x.length - 1 - offset) / step));
      while (n > 0 && Math.floor(offset + (n - 1) * step) + 1 >= x.length) n -= 1;
      const out = new Float32Array(n);
      for (let k = 0; k < n; k += 1) {
        const at = offset + k * step;
        const i = Math.floor(at);
        const part = at - i;
        out[k] = x[i] * (1 - part) + x[i + 1] * part;
      }
      keep(x, offset + n * step);
      return out;
    },
  };
}

// The whole of a clip at once.
export function resample(samples, fromRate, toRate = RATE) {
  return createResampler(fromRate, toRate).push(samples);
}

// Cuts sound into the fixed-size frames the speech detector wants, keeping
// what is left over for next time.
export function createFramer(size = FRAME) {
  let carry = new Float32Array(0);
  return {
    push(block) {
      const x = new Float32Array(carry.length + block.length);
      x.set(carry);
      x.set(block, carry.length);
      const frames = [];
      let at = 0;
      for (; at + size <= x.length; at += size) frames.push(x.slice(at, at + size));
      carry = x.slice(at);
      return frames;
    },
    reset() { carry = new Float32Array(0); },
  };
}

// Reads a WAV file (16-bit, as the sample clip is) into one channel of
// numbers between -1 and 1. Throws a plain Error for anything else.
export function parseWav(bytes) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes?.buffer?.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44) throw new Error('This is not a sound file we can read.');
  const view = new DataView(buffer);
  const tag = (at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('This is not a sound file we can read.');
  let format = null;
  for (let at = 12; at + 8 <= view.byteLength;) {
    const name = tag(at);
    const length = view.getUint32(at + 4, true);
    const start = at + 8;
    if (name === 'fmt ' && length >= 16) {
      format = { kind: view.getUint16(start, true), channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), bits: view.getUint16(start + 14, true) };
    } else if (name === 'data') {
      if (!format || format.kind !== 1 || format.bits !== 16 || format.channels < 1 || !(format.rate > 0)) throw new Error('This is not a sound file we can read.');
      const width = format.channels * 2;
      const count = Math.floor(Math.min(length, view.byteLength - start) / width);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        let sum = 0;
        for (let c = 0; c < format.channels; c += 1) sum += view.getInt16(start + i * width + c * 2, true);
        samples[i] = sum / format.channels / 32_768;
      }
      return { rate: format.rate, samples };
    }
    at = start + length + (length % 2);
  }
  throw new Error('This is not a sound file we can read.');
}

// ----- Where a sentence starts and ends -----

// All times in milliseconds of sound.
export const SEGMENT = Object.freeze({
  speechOn: 0.5,          // this sure that it is speech: a sentence starts
  speechOff: 0.35,        // below this it counts as quiet
  preRollMs: 300,         // sound kept from just before the start, so the first word is whole
  endQuietMs: 700,        // this much quiet ends a sentence
  shortSpeechMs: 1500,    // a sentence with less speech than this…
  shortHoldMs: 1400,      // …waits this long, so a short phrase can join what follows
  softMaxMs: 8000,        // after this long…
  softQuietMs: 250,       // …a short pause is enough to end it
  hardMaxMs: 14_000,      // never let one sentence run longer than this
  minSpeechMs: 100,       // less speech than this was a click: nothing to caption
  partialEveryMs: 800,    // look again at a sentence in progress after this much new sound…
  partialSpacing: 1.5,    // …and no sooner than this many times the last look took…
  partialMaxLagMs: 350,   // …and only when we are this close to the live sound
});

const samplesIn = (ms) => Math.round((ms / 1000) * RATE);

function joined(frames, length) {
  const audio = new Float32Array(length);
  let at = 0;
  for (const frame of frames) { audio.set(frame, at); at += frame.length; }
  return audio;
}

// Give it each frame of sound with how likely it is to be speech (0 to 1),
// and it says when there is something to caption:
//   { type: 'partial', id, audio, ... }  the sentence so far, to look at
//   { type: 'final', id, audio, sameAsPartial, ... }  the whole sentence
//   null                                  nothing to do
// `sameAsPartial` is true when nobody has spoken since the last partial, so
// its words can be used again without working them out twice.
// `lagMs` is how far behind the live sound we are; `lastInferMs` how long the
// model took last time. `speechEndsAt` and `endsAt` count samples since the
// segmenter was made.
export function createSegmenter(options = {}) {
  const o = { ...SEGMENT, ...options };
  const preRoll = samplesIn(o.preRollMs);
  const endQuiet = samplesIn(o.endQuietMs);
  const shortSpeech = samplesIn(o.shortSpeechMs);
  const shortHold = samplesIn(o.shortHoldMs);
  const softMax = samplesIn(o.softMaxMs);
  const softQuiet = samplesIn(o.softQuietMs);
  const hardMax = samplesIn(o.hardMaxMs);
  const minSpeech = samplesIn(o.minSpeechMs);
  const partialEvery = samplesIn(o.partialEveryMs);

  let position = 0;         // samples seen so far
  let speaking = false;
  let before = [];          // the last few quiet frames
  let beforeLength = 0;
  let frames = [];          // the sentence so far
  let length = 0;
  let quiet = 0;            // samples of quiet at its end
  let startsAt = 0;
  let speechStartsAt = 0;   // position of the first frame of speech
  let speechEndsAt = 0;     // position just after the last frame of speech
  let partialAt = 0;        // length when the last partial was taken
  let speechAtPartial = -1; // speechEndsAt when it was taken
  let id = 0;

  const forget = () => {
    speaking = false;
    frames = [];
    length = 0;
    quiet = 0;
    before = [];
    beforeLength = 0;
    speechAtPartial = -1;
  };

  return {
    get speaking() { return speaking; },
    get position() { return position; },
    push(frame, probability, { lagMs = 0, lastInferMs = 0 } = {}) {
      position += frame.length;
      if (!speaking) {
        if (probability >= o.speechOn) {
          speaking = true;
          id += 1;
          frames = [...before, frame];
          length = beforeLength + frame.length;
          startsAt = position - length;
          quiet = 0;
          speechStartsAt = position - frame.length;
          speechEndsAt = position;
          partialAt = length;
          speechAtPartial = -1;
          before = [];
          beforeLength = 0;
        } else {
          before.push(frame);
          beforeLength += frame.length;
          while (beforeLength - before[0].length >= preRoll) beforeLength -= before.shift().length;
        }
        return null;
      }
      frames.push(frame);
      length += frame.length;
      if (probability >= o.speechOff) { quiet = 0; speechEndsAt = position; } else quiet += frame.length;
      // How much was said: from the first sound of speech to the last.
      const spoken = speechEndsAt - speechStartsAt;
      const needed = spoken < shortSpeech ? Math.max(endQuiet, shortHold) : endQuiet;
      const ended = quiet >= needed || (length >= softMax && quiet >= softQuiet) || length >= hardMax;
      const about = { id, startsAt, speechEndsAt, endsAt: position, seconds: length / RATE };
      if (ended) {
        const event = spoken >= minSpeech
          ? { type: 'final', ...about, audio: joined(frames, length), sameAsPartial: speechAtPartial === speechEndsAt }
          : null;
        forget();
        return event;
      }
      const due = length - partialAt >= Math.max(partialEvery, o.partialSpacing * (lastInferMs / 1000) * RATE);
      // Only when somebody has spoken since the last look, and never when we
      // are behind: a slow tablet shows fewer partials, not later ones.
      if (due && spoken >= minSpeech && speechEndsAt !== speechAtPartial && lagMs < o.partialMaxLagMs) {
        partialAt = length;
        speechAtPartial = speechEndsAt;
        return { type: 'partial', ...about, audio: joined(frames, length) };
      }
      return null;
    },
    // Drops the sentence in progress (after falling behind).
    reset: forget,
  };
}

// ----- Which words of a sentence in progress to show -----

export const wordsOf = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);
// The same word, whatever its capitals or the comma after it.
const bare = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

// The model's first tries at a sentence often change: a word it wrote is
// gone the next time it looks. For someone reading large letters across a
// room, words that rewrite themselves are worse than words that come a little
// later. So of a sentence still being spoken we show only the words two
// looks in a row agree on, from the start of the sentence. Words once shown
// are never changed or taken back; the finished sentence replaces the line.
export function createStableWords() {
  let last = [];      // the words of the look before this one
  let shown = [];     // what is on the screen: only ever added to
  return {
    // `text` is the model's newest try. Returns the words to show.
    add(text) {
      const now = wordsOf(text);
      let agreed = 0;
      while (agreed < last.length && agreed < now.length && bare(last[agreed]) === bare(now[agreed])) agreed += 1;
      let same = 0;
      while (same < shown.length && same < agreed && bare(shown[same]) === bare(now[same])) same += 1;
      // What is shown must be the start of what they agree on; then the rest
      // of what they agree on is added. Otherwise the line waits as it is.
      if (same === shown.length && agreed > shown.length) shown = [...shown, ...now.slice(shown.length, agreed)];
      last = now;
      return shown.join(' ');
    },
    get text() { return shown.join(' '); },
    reset() { last = []; shown = []; },
  };
}

// ----- When the tablet cannot keep up -----

export const LAG = Object.freeze({
  limitMs: 3000,      // further behind the sound than this: stop, drop what is waiting, start afresh
  caughtUpMs: 500,    // sound this fresh is where captions start again
  maxPauses: 3,       // the third time in one visit, captions are switched off for that visit
});

// Captions that arrive many seconds late are worse than none. Ask this what
// to do with each block of sound when its turn comes, giving how old it is:
//   'use'      caption it
//   'pause'    we have fallen behind: drop it, and say "paused"
//   'drop'     still catching up: drop it
//   'resume'   caught up: caption it, and say so
//   'give_up'  fell behind once too often: no more captions this visit
export function createLagGuard(options = {}) {
  const o = { ...LAG, ...options };
  let pauses = 0;
  let dropping = false;
  let gaveUp = false;
  return {
    get pauses() { return pauses; },
    next(lagMs) {
      if (gaveUp) return 'give_up';
      if (dropping) {
        if (lagMs > o.caughtUpMs) return 'drop';
        dropping = false;
        return 'resume';
      }
      if (!(lagMs > o.limitMs)) return 'use';
      pauses += 1;
      if (pauses >= o.maxPauses) { gaveUp = true; return 'give_up'; }
      dropping = true;
      return 'pause';
    },
  };
}

// ----- How much the model may write -----

// The model stops after a set number of word-pieces. The library's own limit
// (6 for each whole second) is nothing at all under a second, and cuts fast
// talkers short. A much higher one makes it repeat itself. So: 7 a second,
// and never fewer than 8.
export const maxNewTokens = (seconds) => Math.max(8, Math.ceil(seconds * 7));

// The model wants at least a second of sound: shorter clips get quiet added.
export function padToOneSecond(samples) {
  if (samples.length >= RATE) return samples;
  const padded = new Float32Array(RATE);
  padded.set(samples);
  return padded;
}

// What the model wrote, tidied: one line, no stray spaces.
export const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// ----- Sound in, captions out -----

// Puts the rules above together. The worker gives it the two models and a way
// to speak to the page; the tests give it pretend ones.
//   speechProbability(frame)  how likely this frame is speech, 0 to 1
//   write(clip, maxTokens)    the words in a clip of sound
//   resetDetector()           the speech detector starts afresh
//   tell(message)             a message for the page:
//                               { type: 'caption', kind, id, text, delayMs }
//                               { type: 'paused' } / { type: 'resumed' }
//                               { type: 'lag', ms }     about once a second
//                               { type: 'error', code: 'too_slow' | 'unavailable', message }
//   clock()                   the time now, in milliseconds
// Blocks of sound are dealt with strictly one at a time, in the order they
// came. Words are handed to `tell` and to nothing else, and are not kept
// once the sentence they belong to is finished.
export function createCaptioner({ speechProbability, write, resetDetector = () => {}, tell, clock }) {
  const waiting = [];           // blocks of sound not dealt with yet
  let working = null;           // the promise of the loop below, while it runs
  let stopped = false;          // gave up, or something broke: no more captions
  const guard = createLagGuard();
  const segmenter = createSegmenter();
  const framer = createFramer();
  const stable = createStableWords();
  let resampler = null;
  let resamplerRate = 0;
  let look = { id: 0, text: '', endsAt: 0 };   // the last look at the sentence in progress
  let shown = '';
  let lastInferMs = 0;
  let fed = 0;                  // samples given to the detector so far
  const arrivals = [];          // [samples fed after a block, when that block reached the page]
  let sinceLagNote = 0;

  // When the sound at `position` reached the page.
  function arrivedAt(position) {
    for (const [after, t] of arrivals) if (after >= position) return t - ((after - position) / RATE) * 1000;
    return arrivals.length ? arrivals[arrivals.length - 1][1] : clock();
  }

  async function wordsIn(audio) {
    const clip = padToOneSecond(audio);
    const started = clock();
    const text = tidy(await write(clip, maxNewTokens(clip.length / RATE)));
    lastInferMs = clock() - started;
    return text;
  }

  // After falling behind: forget the sentence in progress and start afresh.
  function startAfresh() {
    segmenter.reset();
    framer.reset();
    stable.reset();
    resampler = null;
    look = { id: 0, text: '', endsAt: 0 };
    shown = '';
    resetDetector();
  }

  async function hear(block) {
    if (block.rate !== resamplerRate || !resampler) { resampler = createResampler(block.rate, RATE); resamplerRate = block.rate; }
    const sound = resampler.push(block.samples);
    fed += sound.length;
    arrivals.push([fed, block.t]);
    if (arrivals.length > 600) arrivals.splice(0, 200);
    for (const frame of framer.push(sound)) {
      const probability = await speechProbability(frame);
      const event = segmenter.push(frame, probability, { lagMs: clock() - block.t, lastInferMs });
      if (!event) continue;
      if (event.id !== look.id) { stable.reset(); shown = ''; look = { id: event.id, text: '', endsAt: 0 }; }
      if (event.type === 'partial') {
        // The words shown now were already there at the look before this
        // one: that is how long ago the newest of them was spoken.
        const spokenBy = look.endsAt;
        look.text = await wordsIn(event.audio);
        look.endsAt = event.endsAt;
        // Only the words two looks in a row agree on are shown.
        const words = stable.add(look.text);
        if (words !== shown) {
          shown = words;
          tell({ type: 'caption', kind: 'partial', id: event.id, text: words, delayMs: Math.round(clock() - arrivedAt(spokenBy)) });
        }
      } else {
        // Nobody spoke after the last look: its words are the sentence.
        const text = event.sameAsPartial && look.text ? look.text : await wordsIn(event.audio);
        tell({ type: 'caption', kind: 'final', id: event.id, text, delayMs: Math.round(clock() - arrivedAt(event.speechEndsAt)) });
      }
    }
  }

  async function work() {
    // A breath first, so that `working` is set before anything here runs
    // (and so before the end of this function clears it again).
    await null;
    try {
      while (waiting.length && !stopped) {
        const block = waiting.shift();
        // How old is this sound by now? Captions that fall seconds behind
        // are dropped, not shown late.
        const action = guard.next(clock() - block.t);
        if (action === 'give_up') {
          stopped = true;
          tell({ type: 'error', code: 'too_slow', message: 'Fell too far behind the sound, three times.' });
          break;
        }
        if (action === 'pause') { startAfresh(); tell({ type: 'paused' }); continue; }
        if (action === 'drop') continue;
        if (action === 'resume') tell({ type: 'resumed' });
        await hear(block);
        sinceLagNote += 1;
        if (sinceLagNote >= 10) { sinceLagNote = 0; tell({ type: 'lag', ms: Math.round(clock() - block.t) }); }
      }
    } catch (err) {
      stopped = true;
      tell({ type: 'error', code: 'unavailable', message: String(err?.message || err).slice(0, 300) });
    } finally {
      if (stopped) waiting.length = 0;
      working = null;
    }
  }

  return {
    // A block of sound from the page: { samples, rate, t } (t: when the page
    // got it). Resolves when everything given so far has been dealt with.
    push(block) {
      if (stopped) return Promise.resolve();
      waiting.push(block);
      working ||= work();
      return working;
    },
    get stopped() { return stopped; },
    get pauses() { return guard.pauses; },
  };
}

// ----- What is on the screen -----

export const MAX_LINES = 3;
export const NO_CAPTIONS = Object.freeze({ finished: Object.freeze([]), current: '' });

// The lines of captions: finished sentences, and the one being spoken.
//   { kind: 'partial', text }  the words to show of the sentence in progress
//   { kind: 'final', text }    the finished sentence, in place of that line
//   { kind: 'clear' }          nothing (the visit ended, or captions fell behind)
// A finished sentence that came out empty keeps the words already shown.
export function addCaption(state, event, max = MAX_LINES) {
  const kind = event?.kind;
  if (kind === 'clear') return NO_CAPTIONS;
  if (kind === 'partial') return { finished: state.finished, current: tidy(event.text) };
  if (kind === 'final') {
    const text = tidy(event.text) || state.current;
    return { finished: text ? [...state.finished, text].slice(-max) : state.finished, current: '' };
  }
  return state;
}

// The newest lines, oldest first: at most `max`, the sentence in progress last.
export function linesToShow(state, max = MAX_LINES) {
  return [...state.finished, ...(state.current ? [state.current] : [])].slice(-max);
}

// ----- Numbers for the check page -----

// The middle one and the largest of a list of numbers (0 and 0 for none).
export function typicalAndWorst(numbers) {
  const sorted = numbers.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return { typical: 0, worst: 0, count: 0 };
  return { typical: sorted[Math.floor((sorted.length - 1) / 2)], worst: sorted[sorted.length - 1], count: sorted.length };
}
