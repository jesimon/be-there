// Live captions, the page's side (public/js/captions.js), without a browser:
// a pretend worker, pretend sound nodes and a clock the test moves by hand.
// Then the promise that matters most: caption text is never sent anywhere
// and never stored. Every line of the captions scripts that could send or
// store anything at all is listed here, one by one; a new one fails the test
// until someone has looked at it. The same promise is checked on the real
// pages, with every message they send recorded, in test/e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CAPTION_TIMES, CAPTIONS_KEY, captionsSupported, captionsRemembered, rememberCaptions, captionsCodeAt, captionWords, showCaptions,
  openCaptionsWorker, startCaptions,
} from '../public/js/captions.js';

const read = (file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeClock() {
  let now = 1_000_000;
  let ids = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { ids += 1; timers.set(ids, { at: now + ms, fn }); return ids; },
    clearTimeout: (id) => { timers.delete(id); },
    get waiting() { return timers.size; },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
    },
  };
}

// One pretend page with captions started on it.
//   context: 'running' | 'suspended' | 'none' (the page has no AudioContext to lend)
//   stream:  the visitor's sound, or null for "not arrived yet"
//   breakAt: 'worker' (cannot be made) | 'module' (the listening module will not load)
async function page({ context = 'running', stream = 'sound', breakAt = '', codeAt } = {}) {
  const clock = fakeClock();
  const workers = [];
  const nodes = [];
  class Worker {
    constructor(url, options) {
      if (breakAt === 'worker') throw new Error('refused');
      Object.assign(this, { url, options, posted: [], transfers: [], terminated: false });
      workers.push(this);
    }
    postMessage(message, transfer) { this.posted.push(message); this.transfers.push(transfer); }
    terminate() { this.terminated = true; }
    say(message) { this.onmessage?.({ data: message }); }
  }
  const node = (kind, more = {}) => {
    const n = { kind, to: [], disconnected: 0, connect(other) { n.to.push(other); return other; }, disconnect() { n.disconnected += 1; n.to = []; }, ...more };
    nodes.push(n);
    return n;
  };
  const made = [];      // AudioContexts made by captions.js itself
  function makeContext(state) {
    const listeners = new Set();
    const ctx = {
      state, sampleRate: 48_000, destination: { kind: 'speakers' }, modules: [], resumes: 0,
      audioWorklet: { addModule: async (url) => { ctx.modules.push(url); if (breakAt === 'module') throw new Error('no module'); } },
      resume: async () => { ctx.resumes += 1; },
      createGain: () => node('gain', { gain: { value: 1 } }),
      createMediaStreamSource: (s) => node('source', { stream: s }),
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
      become(next) { ctx.state = next; for (const fn of [...listeners]) fn(); },
      get listening() { return listeners.size; },
    };
    return ctx;
  }
  const scope = {
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    AudioWorkletNode: class {
      constructor(ctx, name, options) { return node('tap', { ctx, name, options, port: { onmessage: null, closed: false, told: [], postMessage(message) { this.told.push(message); }, close() { this.closed = true; } } }); }
    },
    AudioContext: class { constructor() { Object.assign(this, makeContext('running')); made.push(this); } },
  };
  const audioContext = context === 'none' ? null : makeContext(context);
  const track = { kind: 'audio', id: 'visitor-voice' };
  const streamOf = (...tracks) => ({ getAudioTracks: () => tracks });
  const seen = { status: [], lines: [] };
  const handle = startCaptions({
    remoteStream: stream === 'sound' ? streamOf(track) : stream,
    audioContext,
    codeAt,
    onUpdate: (lines) => seen.lines.push(lines),
    onStatus: (state, info) => seen.status.push(info && Object.keys(info).length ? [state, info] : state),
    deps: { Worker, scope, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now },
  });
  await flush();
  const p = {
    handle, clock, workers, nodes, seen, audioContext, made, track, streamOf,
    get worker() { return workers.at(-1); },
    get tap() { return nodes.find((n) => n.kind === 'tap'); },
    get sources() { return nodes.filter((n) => n.kind === 'source'); },
    get gain() { return nodes.find((n) => n.kind === 'gain'); },
    get states() { return seen.status.map((s) => (Array.isArray(s) ? s[0] : s)); },
    get lines() { return seen.lines.at(-1) || []; },
    async say(message) { p.worker.say(message); await flush(); },
    // A block of sound from the listening module.
    async block(value = 0.25) { const samples = new Float32Array(4800).fill(value); p.tap.port.onmessage?.({ data: { samples, rate: 48_000 } }); await flush(); return samples; },
    audioSent: () => p.worker.posted.filter((m) => m.type === 'audio'),
  };
  return p;
}

test('the times are the ones agreed', () => {
  assert.deepEqual({ ...CAPTION_TIMES }, { loadLimit: 90_000, downloadGrace: 30_000, notice: 5_000, pausedLine: 4_000 });
  assert.ok(Object.isFrozen(CAPTION_TIMES));
});

test('starting: a module worker is asked to load, and the visitor’s sound is listened to without being played twice', async () => {
  const p = await page();
  assert.deepEqual(p.seen.status, ['loading']);
  assert.equal(p.workers.length, 1);
  assert.equal(p.worker.url, '/js/captions-worker.js');
  assert.deepEqual(p.worker.options, { type: 'module' });
  assert.deepEqual(p.worker.posted, [{ type: 'load' }]);
  // The page's own AudioContext is used (the chime's); none is made.
  assert.deepEqual(p.made, []);
  assert.deepEqual(p.audioContext.modules, ['/js/pcm-worklet.js']);
  // visitor's sound -> listener -> a volume of nothing -> out.
  assert.equal(p.sources.length, 1);
  assert.deepEqual(p.sources[0].stream.tracks, [p.track], 'the sound track alone, not the picture');
  assert.deepEqual(p.sources[0].to, [p.tap]);
  assert.equal(p.tap.name, 'pcm-tap');
  assert.deepEqual(p.tap.to, [p.gain]);
  assert.equal(p.gain.gain.value, 0, 'what we listen to is not played a second time');
  assert.deepEqual(p.gain.to, [p.audioContext.destination]);

  // With the scripts' own address from the server, both come from there.
  const q = await page({ codeAt: captionsCodeAt('0123456789abcdef0123456789abcdef') });
  assert.equal(q.worker.url, '/captions-code/0123456789abcdef0123456789abcdef/captions-worker.js');
  assert.deepEqual(q.audioContext.modules, ['/captions-code/0123456789abcdef0123456789abcdef/pcm-worklet.js']);
});

test('sound goes to the worker only once the model is ready, and never after captions stop', async () => {
  const p = await page();
  await p.block();
  await p.block();
  assert.deepEqual(p.audioSent(), [], 'nothing is sent, or kept, before the model is ready');
  await p.say({ type: 'ready', loadMs: 2100, fetchedBytes: 0 });
  const samples = await p.block(0.5);
  assert.equal(p.audioSent().length, 1);
  const sent = p.audioSent()[0];
  assert.deepEqual(Object.keys(sent).sort(), ['rate', 'samples', 't', 'type']);
  assert.equal(sent.samples, samples);
  assert.equal(sent.rate, 48_000);
  assert.equal(sent.t, p.clock.now(), 'stamped with when it reached the page');
  assert.deepEqual(p.worker.transfers.at(-1), [samples.buffer], 'handed over, not copied');
  // Something that is not a block of sound is ignored.
  p.tap.port.onmessage({ data: null });
  p.tap.port.onmessage({ data: {} });
  assert.equal(p.audioSent().length, 1);
  const tap = p.tap;
  p.handle.stop();
  assert.equal(tap.port.onmessage, null);
  assert.equal(p.worker.posted.length, 2, 'load, and one block: nothing after stopping');
});

test('what the page is told: getting ready, the notice that captions can be wrong, then captions', async () => {
  const p = await page();
  // Loading from what the tablet already has: no percentage.
  await p.say({ type: 'progress', percent: 97, fetching: false });
  // A first download: the percentage, as it grows.
  await p.say({ type: 'progress', percent: 12, fetching: true });
  await p.say({ type: 'progress', percent: 55, fetching: true });
  assert.deepEqual(p.seen.status, ['loading', 'loading', ['loading', { percent: 12 }], ['loading', { percent: 55 }]]);
  await p.say({ type: 'ready', loadMs: 30_000, fetchedBytes: 49_000_000 });
  assert.equal(p.states.at(-1), 'notice');
  // The notice stays 5 seconds…
  await p.clock.advance(4999);
  assert.equal(p.states.at(-1), 'notice');
  await p.clock.advance(1);
  assert.equal(p.states.at(-1), 'on');
  assert.deepEqual(p.seen.lines, [], 'no words yet, so nothing was shown');

  // …or until the first words, whichever comes first.
  const q = await page();
  await q.say({ type: 'ready', loadMs: 2000, fetchedBytes: 0 });
  await q.clock.advance(1000);
  assert.equal(q.states.at(-1), 'notice');
  await q.say({ type: 'caption', kind: 'partial', id: 1, text: 'Hello', delayMs: 900 });
  assert.equal(q.states.at(-1), 'on');
  assert.deepEqual(q.lines, ['Hello']);
  await q.clock.advance(10_000);
  assert.deepEqual(q.states, ['loading', 'notice', 'on']);
  // Progress that arrives late changes nothing once it is ready.
  await q.say({ type: 'progress', percent: 100, fetching: true });
  assert.deepEqual(q.states, ['loading', 'notice', 'on']);
});

test('captions: finished sentences and the one in progress, three lines at most', async () => {
  const p = await page();
  await p.say({ type: 'ready' });
  await p.say({ type: 'caption', kind: 'partial', id: 1, text: 'Ask not', delayMs: 950 });
  await p.say({ type: 'caption', kind: 'partial', id: 1, text: 'Ask not what your', delayMs: 1000 });
  assert.deepEqual(p.lines, ['Ask not what your']);
  await p.say({ type: 'caption', kind: 'final', id: 1, text: 'Ask not what your country can do for you.', delayMs: 800 });
  assert.deepEqual(p.lines, ['Ask not what your country can do for you.']);
  await p.say({ type: 'caption', kind: 'final', id: 2, text: 'Two.' });
  await p.say({ type: 'caption', kind: 'final', id: 3, text: 'Three.' });
  await p.say({ type: 'caption', kind: 'partial', id: 4, text: 'And' });
  assert.deepEqual(p.lines, ['Two.', 'Three.', 'And']);
  // The same lines again are not handed to the page a second time.
  const count = p.seen.lines.length;
  await p.say({ type: 'caption', kind: 'partial', id: 4, text: 'And' });
  assert.equal(p.seen.lines.length, count);
  // Messages it does not know (from a newer worker) are let pass.
  await p.say({ type: 'something-new', text: 'x' });
  await p.say({ type: 'caption', kind: 'something-new', text: 'x' });
  await p.say(null);
  await p.say('caption');
  assert.deepEqual(p.lines, ['Two.', 'Three.', 'And']);
  // The numbers the check page shows: no words in them.
  await p.say({ type: 'lag', ms: 40 });
  await p.say({ type: 'lag', ms: 700 });
  await p.say({ type: 'lag', ms: 90 });
  assert.deepEqual(p.handle.numbers(), {
    lag: { typical: 90, worst: 700, count: 3 }, delay: { typical: 950, worst: 1000, count: 3 }, pauses: 0, captions: 3, loadMs: 0, fetchedBytes: 0, rate: 48_000, heard: { blocks: 0, loudest: 0 },
  });
  // Whether any sound came at all, and how loud: two blocks, the louder at 0.4.
  await p.block(0.1);
  await p.block(-0.4);
  assert.deepEqual(p.handle.numbers().heard, { blocks: 2, loudest: 0.4 });
  assert.doesNotMatch(JSON.stringify(p.handle.numbers()), /Ask|Two|Three|And/);
});

test('falling behind: the words on the screen go, “paused” is said, and captions take up again', async () => {
  const p = await page();
  await p.say({ type: 'ready' });
  await p.say({ type: 'caption', kind: 'final', id: 1, text: 'Before the pause.' });
  await p.say({ type: 'caption', kind: 'partial', id: 2, text: 'Half a' });
  await p.say({ type: 'paused' });
  assert.equal(p.states.at(-1), 'paused');
  assert.deepEqual(p.lines, [], 'words that are seconds old are taken away');
  // Nothing that still arrives during the pause is shown.
  await p.say({ type: 'caption', kind: 'final', id: 2, text: 'Half a sentence from before.' });
  assert.deepEqual(p.lines, []);
  // Catching up takes the worker a blink. The line stays long enough to be
  // read: until the next words…
  await p.say({ type: 'resumed' });
  assert.equal(p.states.at(-1), 'paused');
  await p.clock.advance(1000);
  assert.equal(p.states.at(-1), 'paused');
  await p.say({ type: 'caption', kind: 'partial', id: 3, text: 'Fresh' });
  assert.equal(p.states.at(-1), 'on');
  assert.deepEqual(p.lines, ['Fresh']);
  assert.equal(p.handle.numbers().pauses, 1);
  assert.deepEqual(p.states, ['loading', 'notice', 'on', 'paused', 'on']);
  // …or, if nobody speaks, 4 seconds.
  await p.say({ type: 'paused' });
  await p.say({ type: 'resumed' });
  await p.clock.advance(3999);
  assert.equal(p.states.at(-1), 'paused');
  await p.clock.advance(1);
  assert.equal(p.states.at(-1), 'on');
  assert.deepEqual(p.lines, []);
  // Paused again before that time is up: one line, not two, and no timer left over when captions stop.
  await p.say({ type: 'paused' });
  await p.say({ type: 'resumed' });
  await p.say({ type: 'paused' });
  await p.clock.advance(10_000);
  assert.equal(p.states.at(-1), 'paused', 'still behind: the line stays');
  await p.say({ type: 'resumed' });
  p.handle.stop();
  assert.equal(p.clock.waiting, 0);
  assert.equal(p.handle.numbers().pauses, 4);
});

for (const [name, cause, expected] of [
  ['it cannot keep up', (p) => p.say({ type: 'error', code: 'too_slow', message: 'Fell too far behind the sound, three times.' }), 'too_slow'],
  ['the model breaks', (p) => p.say({ type: 'error', code: 'unavailable', message: 'RangeError: Out of memory' }), 'unavailable'],
  ['the worker says something we do not know went wrong', (p) => p.say({ type: 'error', code: 'new-kind-of-trouble' }), 'unavailable'],
  ['the worker’s script cannot be loaded', async (p) => { let prevented = false; p.worker.onerror({ message: 'failed to load', preventDefault: () => { prevented = true; } }); await flush(); assert.ok(prevented); }, 'unavailable'],
]) {
  test(`when ${name}: captions stop themselves, say so once, and leave nothing behind`, async () => {
    const p = await page();
    await p.say({ type: 'ready' });
    await p.say({ type: 'caption', kind: 'partial', id: 1, text: 'Words on the screen' });
    const worker = p.worker;
    const tap = p.tap;
    await cause(p);
    assert.equal(p.states.at(-1), expected);
    assert.equal(p.states.filter((s) => s === expected).length, 1);
    assert.equal(worker.terminated, true, 'the worker is ended');
    assert.deepEqual(p.lines, [], 'the words are taken away');
    assert.ok(tap.disconnected >= 1 && p.sources[0].disconnected >= 1 && p.gain.disconnected >= 1, 'it no longer listens');
    assert.equal(tap.port.closed, true);
    assert.deepEqual(tap.port.told, ['stop'], 'the listener is told it may go: nothing else is ever said to it');
    assert.equal(p.clock.waiting, 0, 'no timer is left');
    assert.equal(p.audioContext.listening, 0);
    // Nothing more happens, whatever still arrives or is asked.
    const told = p.seen.status.length;
    worker.onmessage?.({ data: { type: 'caption', kind: 'final', id: 9, text: 'late' } });
    p.handle.stop();
    p.handle.listenTo(p.streamOf({ id: 'another' }));
    p.handle.nudge();
    await p.clock.advance(200_000);
    assert.equal(p.seen.status.length, told);
    assert.deepEqual(p.lines, []);
  });
}

test('when captions cannot even start, the page is told and nothing is thrown at it', async () => {
  const noWorker = await page({ breakAt: 'worker' });
  assert.deepEqual(noWorker.states, ['loading', 'unavailable']);
  assert.equal(noWorker.clock.waiting, 0);
  const noModule = await page({ breakAt: 'module' });
  assert.deepEqual(noModule.states, ['loading', 'unavailable']);
  assert.equal(noModule.worker.terminated, true);
  assert.deepEqual(noModule.nodes, [], 'no listening was set up');
  // A page whose own callbacks throw does not break captions either.
  const clock = fakeClock();
  assert.doesNotThrow(() => startCaptions({ onStatus: () => { throw new Error('page trouble'); }, onUpdate: () => { throw new Error('page trouble'); }, deps: { Worker: class { postMessage() {} terminate() {} }, scope: {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now } }).stop());
});

test('not ready 90 seconds after switching on: off for this visit', async () => {
  const p = await page();
  await p.clock.advance(89_999);
  assert.deepEqual(p.states, ['loading']);
  assert.equal(p.worker.terminated, false);
  await p.clock.advance(1);
  assert.deepEqual(p.states, ['loading', 'unavailable']);
  assert.equal(p.worker.terminated, true);
  assert.equal(p.clock.waiting, 0);

  // Ready in time: the limit is forgotten.
  const q = await page();
  await q.clock.advance(60_000);
  await q.say({ type: 'ready' });
  await q.clock.advance(120_000);
  assert.deepEqual(q.states, ['loading', 'notice', 'on']);
  assert.equal(q.worker.terminated, false);

  // "Loading" from what is already on the tablet does not buy more time.
  const r = await page();
  await r.clock.advance(85_000);
  await r.say({ type: 'progress', percent: 99, fetching: false });
  await r.clock.advance(5_000);
  assert.equal(r.states.at(-1), 'unavailable');
});

test('a first download that is still arriving is given time: 30 seconds after its last progress', async () => {
  const p = await page();
  // Slow broadband: the files keep coming, a little every 20 seconds.
  for (let percent = 10; percent <= 70; percent += 10) {
    await p.clock.advance(20_000);
    await p.say({ type: 'progress', percent, fetching: true });
  }
  assert.equal(p.states.at(-1), 'loading', 'two minutes and twenty seconds in, and still moving');
  assert.equal(p.worker.terminated, false);
  // Then it stops moving.
  await p.clock.advance(29_999);
  assert.equal(p.states.at(-1), 'loading');
  await p.clock.advance(1);
  assert.equal(p.states.at(-1), 'unavailable');
  assert.equal(p.worker.terminated, true);

  // Early progress does not shorten the 90 seconds.
  const q = await page();
  await q.say({ type: 'progress', percent: 5, fetching: true });
  await q.clock.advance(60_000);
  assert.equal(q.states.at(-1), 'loading');
  await q.clock.advance(30_000);
  assert.equal(q.states.at(-1), 'unavailable');
});

test('stopping: the worker is ended, listening stops, the words are gone, and it can be done twice', async () => {
  const p = await page();
  await p.say({ type: 'ready' });
  await p.say({ type: 'caption', kind: 'final', id: 1, text: 'Something that was said.' });
  assert.deepEqual(p.lines, ['Something that was said.']);
  const worker = p.worker;
  p.handle.stop();
  assert.equal(worker.terminated, true);
  assert.deepEqual(p.lines, []);
  assert.equal(p.states.at(-1), 'off');
  assert.ok(p.tap.disconnected && p.gain.disconnected && p.sources[0].disconnected);
  assert.equal(worker.onmessage, null);
  assert.equal(p.clock.waiting, 0);
  assert.equal(p.audioContext.listening, 0);
  const told = p.seen.status.length;
  p.handle.stop();
  p.handle.stop();
  assert.equal(p.seen.status.length, told);
  // The page's AudioContext is the chime's: it is left running.
  assert.equal(p.audioContext.state, 'running');

  // Stopped while still loading.
  const q = await page();
  q.handle.stop();
  assert.deepEqual(q.states, ['loading', 'off']);
  assert.equal(q.worker.terminated, true);
  await q.clock.advance(200_000);
  assert.deepEqual(q.states, ['loading', 'off'], 'the 90-second limit does not fire afterwards');
});

test('the visitor’s sound can arrive after captions start, and a new sound track is taken up', async () => {
  const p = await page({ stream: null });
  assert.equal(p.sources.length, 0);
  assert.deepEqual(p.tap.to, [p.gain], 'ready to listen as soon as there is something');
  // The picture arrives first: still no sound.
  p.handle.listenTo(p.streamOf());
  assert.equal(p.sources.length, 0);
  p.handle.listenTo(p.streamOf(p.track));
  assert.equal(p.sources.length, 1);
  assert.deepEqual(p.sources[0].to, [p.tap]);
  // Told again about the same sound (the page is told for each track that arrives): nothing changes.
  p.handle.listenTo(p.streamOf(p.track));
  p.handle.listenTo(null);
  p.handle.listenTo();
  assert.equal(p.sources.length, 1);
  // A different sound track: the old one is let go.
  const other = { kind: 'audio', id: 'another' };
  p.handle.listenTo(p.streamOf(other));
  assert.equal(p.sources.length, 2);
  assert.equal(p.sources[0].disconnected, 1);
  assert.deepEqual(p.sources[1].stream.tracks, [other]);
  assert.deepEqual(p.sources[1].to, [p.tap]);
});

test('a browser that wants a tap first: the page is told, and any tap wakes it', async () => {
  const p = await page({ context: 'suspended' });
  assert.equal(p.audioContext.resumes, 1, 'it tries at once (the switch itself was a tap)');
  await p.say({ type: 'ready' });
  assert.equal(p.states.at(-1), 'needs_tap');
  p.handle.nudge();
  assert.equal(p.audioContext.resumes, 2);
  p.audioContext.become('running');
  assert.equal(p.states.at(-1), 'notice');
  // Awake: a tap does nothing more.
  p.handle.nudge();
  assert.equal(p.audioContext.resumes, 2);
  // If the browser puts it to sleep again (the tablet was locked), say so again.
  await p.clock.advance(6000);
  p.audioContext.become('suspended');
  assert.equal(p.states.at(-1), 'needs_tap');
  p.audioContext.become('running');
  assert.deepEqual(p.states, ['loading', 'needs_tap', 'notice', 'on', 'needs_tap', 'on']);
});

test('a page with no AudioContext to lend gets one of our own, made once', async () => {
  const p = await page({ context: 'none' });
  assert.equal(p.made.length, 1);
  assert.deepEqual(p.made[0].modules, ['/js/pcm-worklet.js']);
  assert.equal(p.handle.numbers().rate, 48_000);
  // (A second start on the same page would use the same one: it is kept by captions.js.)
});

test('the listening module is taught to each AudioContext once', async () => {
  const first = await page();
  first.handle.stop();
  // The same AudioContext, a second visit.
  const clock = fakeClock();
  const again = startCaptions({ audioContext: first.audioContext, deps: { Worker: first.workers[0].constructor, scope: { MediaStream: class {}, AudioWorkletNode: class { constructor() { this.port = {}; } connect() {} disconnect() {} } }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now } });
  await flush();
  assert.deepEqual(first.audioContext.modules, ['/js/pcm-worklet.js']);
  again.stop();
});

test('the worker by itself, as the check page uses it', async () => {
  const workers = [];
  class Worker {
    constructor(url, options) { Object.assign(this, { url, options, posted: [], terminated: false }); workers.push(this); }
    postMessage(message, transfer) { this.posted.push([message, transfer]); }
    terminate() { this.terminated = true; }
  }
  const progress = [];
  const other = [];
  const engine = openCaptionsWorker({ codeAt: '/js', onProgress: (m) => progress.push(m.percent), onMessage: (m) => other.push(m), deps: { Worker } });
  const worker = workers[0];
  assert.equal(engine.isReady, false);
  engine.send({ type: 'transcribe', id: 1 }, ['buffer']);
  assert.deepEqual(worker.posted, [[{ type: 'load' }, undefined], [{ type: 'transcribe', id: 1 }, ['buffer']]]);
  worker.onmessage({ data: { type: 'progress', percent: 40, fetching: true } });
  worker.onmessage({ data: { type: 'ready', loadMs: 1234, fetchedBytes: 5 } });
  assert.deepEqual(await engine.ready, { type: 'ready', loadMs: 1234, fetchedBytes: 5 });
  assert.equal(engine.isReady, true);
  worker.onmessage({ data: { type: 'transcribed', id: 1, text: 'hello', ms: 900, seconds: 11 } });
  assert.deepEqual([progress, other], [[40], [{ type: 'transcribed', id: 1, text: 'hello', ms: 900, seconds: 11 }]]);
  // It breaks later: `failed` says how.
  worker.onmessage({ data: { type: 'error', code: 'unavailable', message: 'gone' } });
  assert.deepEqual(await engine.failed, { code: 'unavailable', message: 'gone' });
  engine.close();
  engine.close();
  assert.equal(worker.terminated, true);
  assert.equal(engine.isReady, false);
  engine.send({ type: 'audio' });
  assert.equal(worker.posted.length, 2, 'nothing is sent to a worker that has been ended');
});

// ---------------------------------------------------------------------------
// Whether, and where
// ---------------------------------------------------------------------------

test('the choice is remembered as “on” or “off” under one name, and nothing else is', () => {
  assert.equal(CAPTIONS_KEY, 'bethere.captions');
  const kept = new Map();
  const storage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, v) };
  assert.equal(captionsRemembered(storage), false, 'off until they switch it on');
  rememberCaptions(true, storage);
  assert.deepEqual([...kept], [['bethere.captions', 'on']]);
  assert.equal(captionsRemembered(storage), true);
  rememberCaptions(false, storage);
  assert.deepEqual([...kept], [['bethere.captions', 'off']]);
  assert.equal(captionsRemembered(storage), false);
  for (const odd of ['true', '1', 'ON', 'yes', '']) { kept.set('bethere.captions', odd); assert.equal(captionsRemembered(storage), false, odd); }
  // A browser that will not store anything: not remembered, and no error.
  const refuses = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(captionsRemembered(refuses), false);
  assert.doesNotThrow(() => rememberCaptions(true, refuses));
  // No storage at all (as here, under Node).
  assert.equal(captionsRemembered(), false);
  assert.doesNotThrow(() => rememberCaptions(true));
});

test('captions are offered only where the browser can run them', () => {
  const made = [];
  class Worker {
    constructor(url, options) { made.push(url); void options.type; throw new SyntaxError('not an address'); }
  }
  const able = { Worker, AudioWorkletNode: class {}, WebAssembly: { instantiate() {} }, MediaStream: class {} };
  assert.equal(captionsSupported(able), true);
  assert.deepEqual(made, ['http://['], 'asked with an address that is no address, so that nothing is started');
  // A browser whose workers cannot be modules never looks at the "type".
  assert.equal(captionsSupported({ ...able, Worker: class { constructor() { throw new SyntaxError('x'); } } }), false);
  for (const missing of ['Worker', 'AudioWorkletNode', 'WebAssembly', 'MediaStream']) assert.equal(captionsSupported({ ...able, [missing]: undefined }), false, missing);
  assert.equal(captionsSupported({ ...able, WebAssembly: {} }), false);
  assert.equal(captionsSupported({}), false);
  assert.equal(captionsSupported(null), false);
  assert.equal(captionsSupported(), false, 'not under Node');
});

test('where the scripts are: the address the server names, or the ordinary one', () => {
  assert.equal(captionsCodeAt('0123456789abcdef0123456789abcdef'), '/captions-code/0123456789abcdef0123456789abcdef');
  for (const odd of [undefined, null, '', 'v1', '../js', '0123456789abcdef/../../x', 'ABCDEF0123456789ABCDEF0123456789', 'https://evil.example/x', 42, {}, '0123456789abcde']) assert.equal(captionsCodeAt(odd), '/js', String(odd));
});

// ---------------------------------------------------------------------------
// The words on the screen
// ---------------------------------------------------------------------------

test('the plain lines about captions themselves', () => {
  assert.equal(captionWords('loading'), 'Getting captions ready…');
  assert.equal(captionWords('loading', 42), 'Getting captions ready… 42%');
  assert.equal(captionWords('loading', 0), 'Getting captions ready… 0%');
  assert.equal(captionWords('notice'), 'Captions are on. They can contain mistakes.');
  assert.equal(captionWords('paused'), 'Captions paused, catching up');
  assert.equal(captionWords('too_slow'), 'Captions can’t keep up on this tablet.');
  assert.equal(captionWords('unavailable'), 'Captions aren’t available on this tablet.');
  assert.equal(captionWords('needs_tap'), 'Tap the screen to start captions.');
  for (const quiet of ['on', 'off', '', undefined, 'something-new']) assert.equal(captionWords(quiet), '');
  // Plain words: no exclamation marks, and nothing about how it is done.
  for (const state of ['loading', 'notice', 'paused', 'too_slow', 'unavailable', 'needs_tap']) assert.doesNotMatch(captionWords(state, 5), /!|model|worker|download|WebAssembly|error|fail/i, state);
});

test('the caption box shows a line about captions, or the captions, and hides when it has nothing to say', (t) => {
  const element = (tag) => ({ tag, textContent: '' });
  const had = globalThis.document;
  globalThis.document = { createElement: element };
  t.after(() => { if (had === undefined) delete globalThis.document; else globalThis.document = had; });
  const classes = new Set();
  const box = { dataset: {}, hidden: true, children: [], replaced: 0, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }, replaceChildren(...nodes) { box.children = nodes; box.replaced += 1; } };
  const text = () => box.children.map((line) => `${line.tag}:${line.textContent}`);

  showCaptions(box, { state: 'loading', percent: 30, lines: [] });
  assert.deepEqual(text(), ['p:Getting captions ready… 30%']);
  assert.deepEqual([box.hidden, classes.has('is-status')], [false, true]);
  // The notice, even if there happened to be lines.
  showCaptions(box, { state: 'notice', lines: ['old'] });
  assert.deepEqual(text(), ['p:Captions are on. They can contain mistakes.']);
  // On, with nothing said yet: hidden, so that it covers none of the picture.
  showCaptions(box, { state: 'on', lines: [] });
  assert.deepEqual([text(), box.hidden], [[], true]);
  showCaptions(box, { state: 'on', lines: ['Hello there.', 'How are'] });
  assert.deepEqual(text(), ['p:Hello there.', 'p:How are']);
  assert.deepEqual([box.hidden, classes.has('is-status')], [false, false]);
  // Drawn again with the same things, it is left alone.
  const replaced = box.replaced;
  showCaptions(box, { state: 'on', lines: ['Hello there.', 'How are'] });
  assert.equal(box.replaced, replaced);
  // Paused or stopped: the line about it, never the old words.
  showCaptions(box, { state: 'paused', lines: ['Hello there.'] });
  assert.deepEqual(text(), ['p:Captions paused, catching up']);
  showCaptions(box, { state: 'too_slow', lines: ['Hello there.'] });
  assert.deepEqual(text(), ['p:Captions can’t keep up on this tablet.']);
  // Off: nothing at all, whatever lines are handed in.
  showCaptions(box, { state: 'off', lines: ['Hello there.'] });
  assert.deepEqual([text(), box.hidden], [[], true]);
  showCaptions(box);
  assert.deepEqual([text(), box.hidden], [[], true]);
  assert.doesNotThrow(() => showCaptions(null, { state: 'on', lines: ['x'] }), 'a page without the box is left alone');
  // The words are put on the page as text, never as markup.
  showCaptions(box, { state: 'on', lines: ['<img src=x onerror=alert(1)>'] });
  assert.equal(box.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(read('js/captions.js'), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});

// ---------------------------------------------------------------------------
// Caption text is never sent and never stored
// ---------------------------------------------------------------------------

// Every way a script could send something out of the page or keep it on the
// device. A line of the captions scripts that uses one of them must be on the
// list below, word for word.
const WAYS_OUT = /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|console\.|caches|cookie|import\(|importScripts|postMessage|BroadcastChannel|EventSource|createDataChannel|RTCPeerConnection|RTCDataChannel|navigator\.|location|\.send\(|history\.|window\.open|eval\(|new Function|setItem|getItem|\.put\(|\.href\b|createObjectURL|clipboard|\.download\b|download=|FileSystem|showSaveFilePicker|<form|\.submit\(/;
const ALLOWED = {
  // The thinking: nothing at all.
  'js/caption-text.js': [],
  // The listener: hands blocks of sound (numbers, not words) to its page.
  'js/pcm-worklet.js': [
    'this.port.postMessage({ samples: this.block, rate: sampleRate }, [this.block.buffer]);',
  ],
  // The page's side: the one remembered on/off flag, messages to its own
  // worker (sound in, never words), and one word to its listener: "stop".
  'js/captions.js': [
    "try { return (storage || localStorage).getItem(CAPTIONS_KEY) === 'on'; } catch { return false; }",
    "try { (storage || localStorage).setItem(CAPTIONS_KEY, on ? 'on' : 'off'); } catch { /* not remembered: they can switch it on again */ }",
    "worker.postMessage({ type: 'load' });",
    'send(message, transfer) { if (!over && worker) worker.postMessage(message, transfer || []); },',
    "try { if (tap) { tap.port.onmessage = null; tap.port.postMessage('stop'); tap.port.close?.(); } } catch { /* already gone */ }",
    "engine.send({ type: 'audio', samples: block.samples, rate: block.rate, t: now() }, [block.samples.buffer]);",
  ],
  // The worker: loads the library and the model from our own server, keeps
  // those files on the device, and talks to its own page.
  'js/captions-worker.js': [
    'const origin = self.location.origin;',
    'const tell = (message) => self.postMessage(message);',
    "try { url = new URL(typeof input === 'string' ? input : input?.url ?? String(input), self.location.href); } catch { return new Response(null, { status: 404 }); }",
    'return counted(await fetch(url.href), url.pathname.slice(FILES.base.length));',
    "for (const name of await caches.keys()) if (name.startsWith('bethere-captions-') && name !== KEPT) await caches.delete(name);",
    'return await caches.open(KEPT);',
    'const response = await fetch(url);',
    "try { await kept?.put(url, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(size) } })); } catch { /* no room: fetched again next time */ }",
    'const library = await import(`${filesAt}${FILES.library}`);',
  ],
  // The check page: asks the server whether captions are there, fetches the
  // sample, makes a video link from the page to itself, and reads the
  // browser's name to show on the page.
  'js/captions-check.js': [
    "const asked = Number(new URLSearchParams(location.search).get('seconds'));",
    'lines.push(`Browser: ${navigator.userAgent}`);',
    'const response = await fetch(`${CAPTION_FILES.base}${CAPTION_FILES.sample}`);',
    "engine.send({ type: 'transcribe', id: 1, samples: copy, rate }, [copy.buffer]);",
    "lock = await navigator.wakeLock?.request('screen').catch(() => null);",
    'sender = new RTCPeerConnection();',
    'receiver = new RTCPeerConnection();',
    "const response = await fetch('/api/config', { cache: 'no-store' });",
  ],
};

test('caption text is never sent or stored: every line that could send or store anything is accounted for', () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    const lines = read(file).split('\n').map((line) => line.trim());
    // A comment does nothing, so it may say anything.
    const found = lines.filter((line) => !line.startsWith('//') && WAYS_OUT.test(line));
    assert.deepEqual(found, allowed, `${file}: the lines that reach outside the page`);
  }
  // The brief's own list, spelt out, for the three files that handle the words.
  for (const file of ['js/captions.js', 'js/captions-worker.js', 'js/caption-text.js']) {
    const code = read(file).split('\n').filter((line) => !line.trim().startsWith('//') && !ALLOWED[file].includes(line.trim())).join('\n');
    for (const sink of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'localStorage', 'indexedDB', 'console.']) assert.ok(!code.includes(sink), `${file} uses ${sink} outside the allowed lines`);
  }
});

test('caption text is never sent or stored: what each allowed line carries', () => {
  const worker = read('js/captions-worker.js');
  const pageSide = read('js/captions.js');
  // The worker fetches only from our own server's captions files, and gives its fetches no body.
  assert.match(worker, /if \(url\.origin !== origin \|\| !url\.pathname\.startsWith\(FILES\.base\)\) return new Response\(null, \{ status: 404 \}\);\n {2}return counted\(await fetch\(url\.href\)/);
  assert.match(worker, /const url = `\$\{filesAt\}\$\{path\}`;[\s\S]{0,400}const response = await fetch\(url\);/);
  assert.doesNotMatch(worker, /fetch\([^)]*,/, 'no fetch in the worker has options: no method, no body');
  assert.doesNotMatch(worker, /method:|body:/);
  // What it keeps on the device is the runtime's bytes, under the runtime's address.
  assert.match(worker, /kept\?\.put\(url, new Response\(bytes\.slice\(0\)/);
  // Everything from our own server, nothing from anywhere else, the plain runtime on one thread.
  for (const setting of ['env.allowRemoteModels = false;', 'env.allowLocalModels = true;', 'env.localModelPath = FILES.base;', 'env.fetch = ownFile;', 'env.useWasmCache = false;', 'runtime.numThreads = 1;', 'runtime.proxy = false;',
    'runtime.wasmPaths = { mjs: `${filesAt}${FILES.runtime}`, wasm: `${filesAt}${FILES.runtimeBinary}` };', "{ device: 'wasm', dtype: 'q8' }"]) {
    assert.ok(worker.includes(setting), setting);
  }
  assert.doesNotMatch(worker, /https?:\/\/|jsdelivr|huggingface|webgpu|asyncify/i, 'no other site is named anywhere in the worker');
  // No Web Speech anywhere near captions: it is broken on iPads, and speaking aloud can mute a visit.
  for (const file of [...Object.keys(ALLOWED), 'js/home.js', 'home.html', 'captions-check.html']) assert.doesNotMatch(read(file), /SpeechRecognition|speechSynthesis|SpeechSynthesisUtterance/, file);
  // The page sends its worker sound and requests, never words: the only messages it posts.
  assert.deepEqual(pageSide.match(/\{ type: '[a-z]+'/g), ["{ type: 'module'", "{ type: 'load'", "{ type: 'audio'"], 'the kind of worker, then the two messages');
  // The numbers kept for the check page are numbers.
  assert.match(pageSide, /const numbers = \{ lags: \[\], delays: \[\], pauses: 0, captions: 0, loadMs: 0, fetchedBytes: 0, rate: 0, blocks: 0, loudest: 0 \};/);
  assert.doesNotMatch(pageSide, /numbers\.\w+\.push\((?!message\.(delayMs|ms)\))/, 'only delays and lags are ever added to them');
});

test('the home screen: captions are switched by the person at home, asked about by the clock, and never mixed with what is sent', () => {
  const html = read('home.html');
  const home = read('js/home.js');
  // One large switch that says its state, inside the visit, hidden until captions can run; the box above it.
  assert.match(html, /<button id="captions-toggle" class="btn huge-btn captions-toggle" type="button" aria-pressed="false" hidden>Captions off<\/button>/);
  assert.match(html, /<div id="captions" class="captions" hidden><\/div>/);
  const visit = html.slice(html.indexOf('<div id="call"'), html.indexOf('<script'));
  assert.ok(visit.includes('id="captions-toggle"') && visit.includes('id="captions"') && visit.includes('id="end"'));
  assert.ok(visit.indexOf('id="captions"') < visit.indexOf('id="captions-toggle"') && visit.indexOf('id="captions-toggle"') < visit.indexOf('id="end"'));
  assert.match(home, /toggle\.textContent = captions \? 'Captions on' : 'Captions off';\n\s+toggle\.setAttribute\('aria-pressed', String\(!!captions\)\);/);
  // The home screen keeps working if captions.js cannot be loaded: it is asked for apart from the page's own script.
  assert.doesNotMatch(home, /^import .*captions\.js/m);
  assert.match(home, /const kit = await import\('\.\/captions\.js'\);/);
  // Whether the server has captions is asked when the screen opens, and after that by the clock: never because of a visit.
  assert.equal(home.match(/learnCaptions\(/g).length, 3, 'defined, called once when the screen opens, and once by its own timer');
  assert.match(home, /\n {2}learnCaptions\(\);\n {2}\/\/ Keep the screen awake/);
  const duringVisits = home.slice(home.indexOf('// ----- Someone knocks -----'), home.indexOf('// ----- Messages from the server -----'));
  assert.ok(duringVisits.length > 1000);
  assert.doesNotMatch(duringVisits, /learnCaptions|getConfig|api\(|fetch\(|import\(/, 'nothing between a knock and the end of a visit asks the server about captions');
  // Only a tap by the person at home changes the remembered choice.
  assert.equal(home.match(/rememberCaptions\(/g).length, 1);
  assert.match(home, /\$\('#captions-toggle'\)\.addEventListener\('click', \(\) => \{\n\s+if \(!captionsKit\) return;\n\s+const on = !captions;\n\s+captionsKit\.rememberCaptions\(on\);/);
  // Every way a visit ends goes through endLocal, which ends captions first.
  assert.match(home, /function endLocal\(\) \{\n\s+hideKnock\(\);\n\s+try \{ endCaptions\(\); \}/);
  assert.match(home, /function endCaptions\(\) \{\n\s+captionsOff\(\);\n\s+\$\('#captions-toggle'\)\.hidden = true;/);
  // No line of the home screen's script has both captions and a way to send or store.
  for (const line of home.split('\n')) {
    if (/caption/i.test(line) && !line.trim().startsWith('//')) assert.doesNotMatch(line, /link\.|\.send\(|fetch\(|api\(|localStorage|sessionStorage|console\./, line.trim());
  }
  // The visitor's page has nothing to do with captions.
  for (const file of ['js/visit.js', 'visit.html']) assert.doesNotMatch(read(file), /caption/i, file);
  // The organizer's page says where to try them.
  assert.match(read('organize.html'), /Captions \(trial\): check a device at <a href="\/captions-check">\/captions-check<\/a>/);
});
