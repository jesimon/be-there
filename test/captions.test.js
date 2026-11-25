// Live captions, the thinking (public/js/caption-text.js), without a browser
// and without the speech model: where a sentence starts and ends, which
// words of a sentence in progress are shown, what happens when the tablet
// cannot keep up, how much the model may write, sound brought to the model's
// rate, and which lines are on the screen. The model here is a pretend one
// that "hears" what the test tells it to. The real one, in a real browser,
// is in test/e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE, FRAME, SEGMENT, LAG, MAX_LINES, NO_CAPTIONS, CAPTION_FILES,
  createSegmenter, createStableWords, createLagGuard, createCaptioner, createResampler, resample, createFramer, createProgress,
  parseWav, maxNewTokens, padToOneSecond, tidy, wordsOf, addCaption, linesToShow, typicalAndWorst,
} from '../public/js/caption-text.js';
import { CAPTIONS_FILES, CAPTIONS_VERSION } from '../lib/captions-files.js';

const frameOf = (value = 0) => new Float32Array(FRAME).fill(value);
// Feeds a segmenter frames at a given likelihood of speech and notes at which
// frame (counted from 1) each thing it says came.
function feeder(segmenter = createSegmenter()) {
  const events = [];
  let n = 0;
  const f = {
    segmenter,
    events,
    get n() { return n; },
    feed(probability, count, about) {
      for (let i = 0; i < count; i += 1) {
        n += 1;
        const event = segmenter.push(frameOf(probability), probability, about);
        if (event) events.push({ ...event, at: n });
      }
      return f;
    },
    of: (type) => events.filter((e) => e.type === type),
  };
  return f;
}
const SPEECH = 0.9;
const QUIET = 0.05;
const samples = (count) => count * FRAME;

test('captions: the numbers are the ones agreed', () => {
  assert.equal(RATE, 16_000);
  assert.equal(FRAME, 512);
  assert.deepEqual({ ...SEGMENT }, {
    speechOn: 0.5, speechOff: 0.35, preRollMs: 300, endQuietMs: 700, shortSpeechMs: 1500, shortHoldMs: 1400,
    softMaxMs: 8000, softQuietMs: 250, hardMaxMs: 14_000, minSpeechMs: 100,
    partialEveryMs: 800, partialSpacing: 1.5, partialMaxLagMs: 350,
  });
  assert.deepEqual({ ...LAG }, { limitMs: 3000, caughtUpMs: 500, maxPauses: 3 });
  assert.equal(MAX_LINES, 3);
  assert.ok(Object.isFrozen(SEGMENT) && Object.isFrozen(LAG) && Object.isFrozen(NO_CAPTIONS));
});

test('captions: the browser’s list of files is the server’s, without the sample', () => {
  assert.equal(CAPTION_FILES.base, `/captions-files/${CAPTIONS_VERSION}/`);
  const served = Object.fromEntries(CAPTIONS_FILES.filter((f) => f.path !== CAPTION_FILES.sample).map((f) => [f.path, f.bytes]));
  assert.deepEqual({ ...CAPTION_FILES.sizes }, served);
  const paths = CAPTIONS_FILES.map((f) => f.path);
  for (const name of [CAPTION_FILES.library, CAPTION_FILES.runtime, CAPTION_FILES.runtimeBinary, CAPTION_FILES.sample]) assert.ok(paths.includes(name), name);
  for (const folder of [CAPTION_FILES.model, CAPTION_FILES.detector]) assert.ok(paths.some((p) => p.startsWith(`${folder}/`)), folder);
  // The plain build of the runtime, never the one that gets tabs killed on iPhones and iPads.
  assert.equal(CAPTION_FILES.runtime, 'ort-wasm-simd-threaded.mjs');
  assert.equal(CAPTION_FILES.runtimeBinary, 'ort-wasm-simd-threaded.wasm');
  assert.ok(!paths.some((p) => /asyncify|jsep|jspi/.test(p)));
});

// ---------------------------------------------------------------------------
// Where a sentence starts and ends
// ---------------------------------------------------------------------------

test('segmenter: quiet is nothing, and speech must be likely before a sentence starts', () => {
  assert.deepEqual(feeder().feed(QUIET, 500).events, []);
  // 0.45 is not sure enough to start a sentence…
  const unsure = feeder().feed(0.45, 300);
  assert.deepEqual(unsure.events, []);
  assert.equal(unsure.segmenter.speaking, false);
  // …but once one has started, 0.4 still counts as speech (it only ends below 0.35).
  const going = feeder().feed(QUIET, 20).feed(0.5, 1).feed(0.4, 100);
  assert.equal(going.segmenter.speaking, true);
  assert.deepEqual(going.of('final'), []);
  // Just under 0.35 is quiet.
  assert.equal(feeder().feed(SPEECH, 60).feed(0.34, 22).of('final').length, 1);
});

test('segmenter: a sentence ends after 700 ms of quiet, and carries the moment before it began', () => {
  // 20 frames of quiet, 63 of speech (2 seconds), then quiet.
  const f = feeder().feed(QUIET, 20).feed(SPEECH, 63).feed(QUIET, 21);
  assert.deepEqual(f.of('final'), [], '672 ms of quiet is not yet the end');
  f.feed(QUIET, 1);
  const [final] = f.of('final');
  assert.equal(final.at, 20 + 63 + 22, 'the 22nd quiet frame makes 704 ms');
  assert.equal(final.id, 1);
  // The sound handed to the model: 10 frames from before the first word (320 ms), the speech, and the quiet.
  assert.equal(final.audio.length, samples(10 + 63 + 22));
  assert.equal(final.startsAt, samples(10));
  assert.equal(final.speechEndsAt, samples(20 + 63));
  assert.equal(final.endsAt, samples(105));
  assert.equal(final.seconds, samples(95) / RATE);
  assert.ok(final.audio instanceof Float32Array);
  assert.equal(f.segmenter.speaking, false);
  // The sound itself is passed on untouched: quiet, speech, quiet.
  assert.ok(Math.abs(final.audio[0] - QUIET) < 1e-6 && Math.abs(final.audio[samples(10)] - SPEECH) < 1e-6 && Math.abs(final.audio[samples(73)] - QUIET) < 1e-6);

  // With less than 300 ms before the first word, it carries what there was.
  const early = feeder().feed(QUIET, 3).feed(SPEECH, 63).feed(QUIET, 22);
  assert.equal(early.of('final')[0].audio.length, samples(3 + 63 + 22));
  assert.equal(early.of('final')[0].startsAt, 0);
});

test('segmenter: a short phrase waits 1400 ms, so that it can join what follows', () => {
  // Half a second of speech, alone: it ends only after 1400 ms of quiet.
  const alone = feeder().feed(QUIET, 20).feed(SPEECH, 16).feed(QUIET, 43);
  assert.deepEqual(alone.of('final'), []);
  alone.feed(QUIET, 1);
  assert.equal(alone.of('final')[0].at, 20 + 16 + 44, 'the 44th quiet frame makes 1408 ms');

  // The same phrase, a second of quiet, and more speech: one sentence, not two.
  const joined = feeder().feed(QUIET, 20).feed(SPEECH, 16).feed(QUIET, 31).feed(SPEECH, 40).feed(QUIET, 22);
  const finals = joined.of('final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].id, 1);
  assert.equal(finals[0].audio.length, samples(10 + 16 + 31 + 40 + 22));

  // After a longer sentence the same second of quiet is the end.
  const long = feeder().feed(QUIET, 20).feed(SPEECH, 60).feed(QUIET, 31);
  assert.equal(long.of('final').length, 1);
  assert.equal(long.of('final')[0].at, 20 + 60 + 22);
  // "Short" is measured on the speech itself: 46 frames (1472 ms) is short, 47 (1504 ms) is not.
  assert.equal(feeder().feed(QUIET, 20).feed(SPEECH, 46).feed(QUIET, 43).of('final').length, 0);
  assert.equal(feeder().feed(QUIET, 20).feed(SPEECH, 47).feed(QUIET, 22).of('final').length, 1);
});

test('segmenter: a click is not a sentence', () => {
  const f = feeder().feed(QUIET, 20).feed(SPEECH, 3).feed(QUIET, 100);
  assert.deepEqual(f.events, [], '96 ms of "speech" is dropped, and nothing is asked of the model');
  assert.equal(f.segmenter.speaking, false);
  // 128 ms is kept: "Yes" and "No" are short too.
  assert.equal(feeder().feed(QUIET, 20).feed(SPEECH, 4).feed(QUIET, 44).of('final').length, 1);
  // And a real sentence after the click is heard as usual.
  f.feed(SPEECH, 60).feed(QUIET, 22);
  assert.equal(f.of('final').length, 1);
});

test('segmenter: after 8 seconds a short pause ends the sentence, and at 14 seconds it is ended whatever happens', () => {
  // A 320 ms pause two seconds in does not end it…
  const f = feeder().feed(QUIET, 20).feed(SPEECH, 60).feed(QUIET, 10).feed(SPEECH, 185);
  assert.deepEqual(f.of('final'), []);
  // …but past 8 seconds, 250 ms of quiet does (the 8th quiet frame makes 256 ms).
  f.feed(QUIET, 7);
  assert.deepEqual(f.of('final'), []);
  f.feed(QUIET, 1);
  assert.equal(f.of('final').length, 1);
  assert.equal(f.of('final')[0].at, 20 + 60 + 10 + 185 + 8);
  assert.ok(f.of('final')[0].seconds > 8 && f.of('final')[0].seconds < 9);

  // Someone who does not stop for breath: cut at 14 seconds, and the rest is the next sentence.
  const g = feeder().feed(QUIET, 20).feed(SPEECH, 500);
  const [first] = g.of('final');
  assert.equal(g.of('final').length, 1);
  assert.equal(first.audio.length, samples(438), '438 frames is the first length past 14 seconds');
  assert.ok(first.seconds >= 14 && first.seconds < 14.04);
  assert.equal(first.at, 20 + 428);
  assert.equal(g.segmenter.speaking, true, 'the very next frame started the next sentence');
  g.feed(QUIET, 22);
  const second = g.of('final')[1];
  assert.equal(second.id, 2);
  assert.equal(second.audio.length, samples(500 - 428 + 22));
  assert.equal(second.startsAt, first.endsAt, 'nothing is lost between the two');
  assert.ok(g.events.every((e) => e.seconds <= 14.04), 'no clip handed to the model is longer than the cap');
});

test('segmenter: a look at the sentence in progress every 800 ms of new sound', () => {
  const f = feeder().feed(QUIET, 20).feed(SPEECH, 100);
  // 25 frames are 800 ms: counted from the frame the sentence started on.
  assert.deepEqual(f.of('partial').map((e) => e.at), [21 + 25, 21 + 50, 21 + 75]);
  assert.deepEqual(f.of('partial').map((e) => e.id), [1, 1, 1]);
  // Each look is given the whole sentence so far.
  assert.deepEqual(f.of('partial').map((e) => e.audio.length), [samples(10 + 26), samples(10 + 51), samples(10 + 76)]);
  assert.equal(f.of('partial')[0].endsAt, samples(46));
});

test('segmenter: looks are spaced by how long the model takes, and skipped when behind', () => {
  // The model took a second last time: wait 1.5 seconds of sound (47 frames), not 0.8.
  const slow = feeder().feed(QUIET, 20).feed(SPEECH, 100, { lastInferMs: 1000 });
  assert.deepEqual(slow.of('partial').map((e) => e.at), [21 + 47, 21 + 94]);
  // 350 ms or more behind the live sound: no look at all.
  assert.deepEqual(feeder().feed(QUIET, 20).feed(SPEECH, 100, { lagMs: 350 }).of('partial'), []);
  assert.equal(feeder().feed(QUIET, 20).feed(SPEECH, 100, { lagMs: 349 }).of('partial').length, 3);
  // Behind for a while, then caught up: the look comes at once, and the next 800 ms after that one.
  const caught = feeder().feed(QUIET, 20).feed(SPEECH, 40, { lagMs: 2000 }).feed(SPEECH, 40);
  assert.deepEqual(caught.of('partial').map((e) => e.at), [61, 86]);
});

test('segmenter: no second look when nobody has spoken since the last, and its words can stand for the sentence', () => {
  // Two seconds of speech, then quiet. Looks at frames 46, 71 and 96; the
  // last one comes after the speech has ended (frame 83), so it saw it all.
  const f = feeder().feed(QUIET, 20).feed(SPEECH, 63).feed(QUIET, 22);
  assert.deepEqual(f.events.map((e) => `${e.type}@${e.at}`), ['partial@46', 'partial@71', 'partial@96', 'final@105']);
  assert.equal(f.of('final')[0].sameAsPartial, true);

  // A short phrase with a long wait after it: one look after the speech, and no more.
  const short = feeder().feed(QUIET, 20).feed(SPEECH, 16).feed(QUIET, 44);
  assert.deepEqual(short.events.map((e) => `${e.type}@${e.at}`), ['partial@46', 'final@80']);
  assert.equal(short.of('final')[0].sameAsPartial, true);

  // If the last look came before the last words (here: we were behind, so it
  // was skipped), the sentence must be worked out afresh.
  const behind = feeder().feed(QUIET, 20).feed(SPEECH, 30).feed(QUIET, 44, { lagMs: 1000 });
  assert.deepEqual(behind.events.map((e) => `${e.type}@${e.at}`), ['partial@46', 'final@94']);
  assert.equal(behind.of('final')[0].sameAsPartial, false);
  // And with no look at all, of course.
  assert.equal(feeder().feed(QUIET, 20).feed(SPEECH, 20).feed(QUIET, 44, { lagMs: 1000 }).of('final')[0].sameAsPartial, false);
});

test('segmenter: starting afresh drops the sentence in progress', () => {
  const f = feeder().feed(QUIET, 20).feed(SPEECH, 30);
  assert.equal(f.segmenter.speaking, true);
  f.segmenter.reset();
  assert.equal(f.segmenter.speaking, false);
  f.feed(QUIET, 60);
  assert.deepEqual(f.of('final'), []);
  f.feed(SPEECH, 60).feed(QUIET, 22);
  assert.equal(f.of('final').length, 1);
  assert.equal(f.of('final')[0].audio.length, samples(10 + 60 + 22), 'the next sentence does not carry the dropped one');
  assert.equal(f.segmenter.position, samples(f.n), 'the count of sound heard goes on');
});

// ---------------------------------------------------------------------------
// Which words of a sentence in progress are shown
// ---------------------------------------------------------------------------

test('stable words: only what two looks in a row agree on, from the start of the sentence', () => {
  const s = createStableWords();
  assert.equal(s.add('And so'), '', 'one look alone shows nothing');
  assert.equal(s.add('And so my fellow'), 'And so');
  assert.equal(s.add('And so my fellow Americans'), 'And so my fellow');
  // Capitals and commas are not a disagreement; a new word is written as the newest look has it.
  assert.equal(s.add('and so, my fellow Americans, ask'), 'And so my fellow Americans,');
  assert.equal(s.text, 'And so my fellow Americans,');
  // The same again adds the last word; a shorter or empty look changes nothing.
  assert.equal(s.add('And so my fellow Americans ask'), 'And so my fellow Americans, ask');
  assert.equal(s.add('And so'), 'And so my fellow Americans, ask');
  assert.equal(s.add(''), 'And so my fellow Americans, ask');
  assert.equal(s.add(null), 'And so my fellow Americans, ask');
  s.reset();
  assert.equal(s.text, '');
  assert.equal(s.add('Hello there'), '', 'after a reset the next sentence starts from nothing');
  assert.equal(s.add('Hello there Mary'), 'Hello there');
});

test('stable words: a look that rewrites earlier words changes nothing that is shown', () => {
  const s = createStableWords();
  s.add('And so my fellow');
  assert.equal(s.add('And so my fellow Americans'), 'And so my fellow');
  // The model changes its mind about the third word, and sticks to it.
  assert.equal(s.add('And so by fellow Americans ask not'), 'And so my fellow');
  assert.equal(s.add('And so by fellow Americans ask not what'), 'And so my fellow', 'two looks agree, but not with what is shown: the line waits');
  assert.equal(s.add('Answer by fellow Americans ask not what your'), 'And so my fellow');
  // It comes back to what is shown: the line grows again, from where it was.
  assert.equal(s.add('And so my fellow Americans ask not what your'), 'And so my fellow');
  assert.equal(s.add('And so my fellow Americans ask not what your country'), 'And so my fellow Americans ask not what your');
  // Invented repeats in one look never reach the screen unless the next look has them too.
  const r = createStableWords();
  r.add('Hey');
  assert.equal(r.add('Hey, hey, hey.'), 'Hey,');
  assert.equal(r.add('Hey there you'), 'Hey,');
});

test('stable words: whatever the model says, words once shown are never changed or taken back', () => {
  // A few thousand made-up looks from a tiny vocabulary, so that agreements
  // and disagreements of every kind turn up.
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const vocabulary = ['ask', 'not', 'what', 'your', 'country', 'can', 'do', 'Ask', 'not,', 'for', 'you'];
  let grew = 0;
  for (let sentence = 0; sentence < 300; sentence += 1) {
    const s = createStableWords();
    let shown = '';
    let base = [];
    for (let look = 0; look < 12; look += 1) {
      // Mostly the last look with more words; sometimes with a word changed; sometimes something else.
      const roll = random();
      if (roll < 0.6) base = [...base, vocabulary[Math.floor(random() * vocabulary.length)]];
      else if (roll < 0.85 && base.length) base = base.map((w, i) => (i === Math.floor(random() * base.length) ? vocabulary[Math.floor(random() * vocabulary.length)] : w));
      else base = Array.from({ length: Math.floor(random() * 6) }, () => vocabulary[Math.floor(random() * vocabulary.length)]);
      const next = s.add(base.join(' '));
      assert.ok(next === shown || next.startsWith(`${shown} `) || (shown === '' && next.length > 0), `“${shown}” became “${next}”`);
      if (next !== shown) grew += 1;
      shown = next;
    }
  }
  assert.ok(grew > 300, 'and the lines did grow');
});

// ---------------------------------------------------------------------------
// What is on the screen
// ---------------------------------------------------------------------------

test('the lines to show: finished sentences, then the one in progress; three at most, oldest first', () => {
  let state = NO_CAPTIONS;
  assert.deepEqual(linesToShow(state), []);
  state = addCaption(state, { kind: 'partial', text: 'Hello' });
  assert.deepEqual(linesToShow(state), ['Hello']);
  state = addCaption(state, { kind: 'partial', text: 'Hello  there ' });
  assert.deepEqual(linesToShow(state), ['Hello there']);
  // The finished sentence takes the place of the line in progress.
  state = addCaption(state, { kind: 'final', text: 'Hello there, Mary.' });
  assert.deepEqual(linesToShow(state), ['Hello there, Mary.']);
  state = addCaption(state, { kind: 'partial', text: 'How' });
  assert.deepEqual(linesToShow(state), ['Hello there, Mary.', 'How']);
  state = addCaption(state, { kind: 'final', text: 'How are you?' });
  state = addCaption(state, { kind: 'final', text: 'I brought cake.' });
  assert.deepEqual(linesToShow(state), ['Hello there, Mary.', 'How are you?', 'I brought cake.']);
  // A fourth line pushes the oldest out, whether it is finished or in progress.
  state = addCaption(state, { kind: 'partial', text: 'Shall we' });
  assert.deepEqual(linesToShow(state), ['How are you?', 'I brought cake.', 'Shall we']);
  state = addCaption(state, { kind: 'final', text: 'Shall we have some?' });
  assert.deepEqual(linesToShow(state), ['How are you?', 'I brought cake.', 'Shall we have some?']);
  assert.equal(state.finished.length, 3, 'older sentences are not kept anywhere');
  assert.deepEqual(linesToShow(state, 2), ['I brought cake.', 'Shall we have some?']);
  // Nothing changes for a message it does not know.
  assert.equal(addCaption(state, { kind: 'something-new', text: 'x' }), state);
  assert.equal(addCaption(state, null), state);
  // Cleared: nothing at all.
  state = addCaption(state, { kind: 'clear' });
  assert.equal(state, NO_CAPTIONS);
  assert.deepEqual(linesToShow(state), []);
});

test('the lines to show: a sentence that came out empty keeps the words already shown', () => {
  let state = addCaption(NO_CAPTIONS, { kind: 'partial', text: 'See you on' });
  state = addCaption(state, { kind: 'final', text: '   ' });
  assert.deepEqual(linesToShow(state), ['See you on']);
  assert.equal(state.current, '');
  // With nothing shown, an empty sentence adds no line.
  assert.deepEqual(linesToShow(addCaption(state, { kind: 'final', text: '' })), ['See you on']);
  assert.deepEqual(linesToShow(addCaption(NO_CAPTIONS, { kind: 'final', text: '' })), []);
  // An in-progress line with no words yet is not a line.
  assert.deepEqual(linesToShow(addCaption(state, { kind: 'partial', text: '' })), ['See you on']);
});

// ---------------------------------------------------------------------------
// When the tablet cannot keep up
// ---------------------------------------------------------------------------

test('lag: more than 3 seconds behind drops what is waiting and says so; the third time gives up', () => {
  const guard = createLagGuard();
  assert.equal(guard.next(0), 'use');
  assert.equal(guard.next(2999), 'use');
  assert.equal(guard.next(3000), 'use', 'exactly 3 seconds is not yet "more than"');
  assert.equal(guard.next(3001), 'pause');
  assert.equal(guard.pauses, 1);
  // Everything that is still old is dropped, down to sound that is fresh again.
  assert.equal(guard.next(2900), 'drop');
  assert.equal(guard.next(501), 'drop');
  assert.equal(guard.next(500), 'resume');
  assert.equal(guard.next(100), 'use');
  // A second time.
  assert.equal(guard.next(5000), 'pause');
  assert.equal(guard.next(4000), 'drop');
  assert.equal(guard.next(10), 'resume');
  assert.equal(guard.pauses, 2);
  // The third time there is no pause: captions are over for this visit.
  assert.equal(guard.next(3500), 'give_up');
  assert.equal(guard.pauses, 3);
  for (const lag of [0, 100, 9000]) assert.equal(guard.next(lag), 'give_up');
  // A clock that jumps backwards is not "behind".
  assert.equal(createLagGuard().next(-50), 'use');
  assert.equal(createLagGuard().next(NaN), 'use');
  // The numbers can be set (the tests of the whole do).
  const strict = createLagGuard({ limitMs: 100, caughtUpMs: 10, maxPauses: 1 });
  assert.equal(strict.next(101), 'give_up');
});

// ---------------------------------------------------------------------------
// How much the model may write
// ---------------------------------------------------------------------------

test('the token cap: 7 for each second of sound, never fewer than 8', () => {
  assert.deepEqual([0, 0.4, 1, 1.14, 1.15, 2, 2.95, 8, 11, 14].map(maxNewTokens), [8, 8, 8, 8, 9, 14, 21, 56, 77, 98]);
  // The library's own cap (6 for each whole second) is 0 under a second and 12 at 2.95 s, where fast speech was cut short.
  assert.ok(maxNewTokens(2.95) > Math.floor(2.95) * 6);
  // And not much higher: 12 a second made the model repeat itself.
  assert.ok(maxNewTokens(14) < 14 * 8);
});

test('clips shorter than a second get quiet added; longer ones are left alone', () => {
  const short = new Float32Array(9000).fill(0.5);
  const padded = padToOneSecond(short);
  assert.equal(padded.length, RATE);
  assert.equal(padded[8999], 0.5);
  assert.equal(padded[9000], 0);
  assert.equal(short.length, 9000, 'the clip itself is not changed');
  const long = new Float32Array(RATE + 1);
  assert.equal(padToOneSecond(long), long);
  assert.equal(padToOneSecond(new Float32Array(RATE)).length, RATE);
  assert.equal(padToOneSecond(new Float32Array(0)).length, RATE);
  assert.equal(tidy('  Ask not\n what  your country '), 'Ask not what your country');
  assert.equal(tidy(undefined), '');
  assert.deepEqual(wordsOf('  a  b\tc '), ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// Sound at the model's rate
// ---------------------------------------------------------------------------

const sine = (hz, rate, count, level = 0.5) => Float32Array.from({ length: count }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / rate));
const loudness = (x, from = 0) => Math.sqrt(x.slice(from).reduce((sum, v) => sum + v * v, 0) / (x.length - from));

test('resampler: a tenth of a second at 48,000 or 44,100 becomes 1,600 samples at 16,000', () => {
  assert.equal(resample(new Float32Array(4800), 48_000).length, 1600);
  assert.equal(resample(new Float32Array(48_000), 48_000).length, RATE);
  // 44,100 does not divide evenly: over many blocks nothing is lost or made up.
  const r = createResampler(44_100);
  let total = 0;
  for (let i = 0; i < 100; i += 1) {
    const out = r.push(new Float32Array(4410));
    assert.ok(Math.abs(out.length - 1600) <= 1, `block ${i} gave ${out.length}`);
    total += out.length;
  }
  assert.ok(Math.abs(total - 160_000) <= 1, `10 seconds gave ${total} samples`);
  // Odd rates too.
  assert.ok(Math.abs(resample(new Float32Array(22_050), 22_050).length - RATE) <= 1);
  assert.ok(Math.abs(resample(new Float32Array(96_000), 96_000).length - RATE) <= 1);
});

test('resampler: blocks join without a seam, whatever their sizes', () => {
  const sound = sine(440, 44_100, 44_100);
  const whole = resample(sound, 44_100);
  for (const sizes of [[4410], [128], [1, 7, 4410, 333], [10_000, 3, 3, 3]]) {
    const r = createResampler(44_100);
    const parts = [];
    for (let at = 0, i = 0; at < sound.length; i += 1) {
      const size = sizes[i % sizes.length];
      parts.push(r.push(sound.subarray(at, at + size)));
      at += size;
    }
    const joined = Float32Array.from(parts.flatMap((p) => [...p]));
    assert.ok(Math.abs(joined.length - whole.length) <= 1, `sizes ${sizes}: ${joined.length} against ${whole.length}`);
    for (let i = 0; i < Math.min(joined.length, whole.length); i += 97) assert.ok(Math.abs(joined[i] - whole[i]) < 1e-5, `sizes ${sizes}: sample ${i}`);
  }
});

test('resampler: speech comes through, and what is too high for the new rate is turned down', () => {
  // A steady level stays that level.
  const flat = resample(new Float32Array(4800).fill(0.25), 48_000);
  assert.ok(flat.every((v) => Math.abs(v - 0.25) < 1e-6));
  // A note in the middle of the range of speech keeps its strength and its pitch.
  for (const rate of [48_000, 44_100]) {
    const out = resample(sine(1000, rate, rate), rate);
    assert.ok(Math.abs(loudness(out) - loudness(sine(1000, RATE, RATE))) < 0.03, `1 kHz from ${rate}`);
    let crossings = 0;
    for (let i = 1; i < out.length; i += 1) if (out[i - 1] < 0 && out[i] >= 0) crossings += 1;
    assert.ok(Math.abs(crossings - 1000) <= 2, `1 kHz from ${rate} is still 1 kHz (${crossings})`);
  }
  // 15 kHz cannot be carried at 16,000 samples a second. Left alone it would come out as a loud false note.
  assert.ok(loudness(resample(sine(15_000, 48_000, 48_000), 48_000)) < 0.1 * loudness(sine(15_000, 48_000, 48_000)));
});

test('resampler: edge cases', () => {
  // Already at the right rate: handed back as it is.
  const same = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(createResampler(RATE).push(same), same);
  // Nothing in, nothing out; and a block too small to make one sample is kept for the next.
  const r = createResampler(48_000);
  assert.equal(r.push(new Float32Array(0)).length, 0);
  assert.equal(r.push(new Float32Array([0.3, 0.3])).length, 0);
  const next = r.push(new Float32Array([0.3, 0.3]));
  assert.equal(next.length, 1);
  assert.ok(Math.abs(next[0] - 0.3) < 1e-6);
  // Going up (a rate lower than the model's): a straight line between neighbours.
  const up = resample(new Float32Array([0, 1, 0, -1, 0]), 8000);
  assert.deepEqual([...up].map((v) => Math.round(v * 100) / 100), [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
  const stream = createResampler(8000);
  const first = stream.push(new Float32Array([0, 1, 0]));
  const second = stream.push(new Float32Array([-1, 0]));
  assert.deepEqual([...first, ...second].map((v) => Math.round(v * 100) / 100), [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
  assert.ok(![...up, ...first, ...second].some(Number.isNaN));
  // A rate that is no rate.
  for (const bad of [0, -1, NaN, Infinity, undefined, '48000x']) assert.throws(() => createResampler(bad), RangeError, String(bad));
  assert.throws(() => createResampler(48_000, 0), RangeError);
});

test('framer: frames of 512, with what is left over kept for next time', () => {
  const framer = createFramer();
  const block = Float32Array.from({ length: 1600 }, (_, i) => i);
  const first = framer.push(block);
  assert.deepEqual(first.map((f) => f.length), [512, 512, 512]);
  assert.equal(first[2][511], 1535);
  const second = framer.push(block);
  assert.deepEqual(second.map((f) => f.length), [512, 512, 512]);
  assert.equal(second[0][0], 1536, 'the 64 left over come first');
  assert.equal(second[0][64], 0);
  assert.equal(framer.push(new Float32Array(0)).length, 0);
  framer.reset();
  assert.equal(framer.push(new Float32Array(511)).length, 0);
  assert.equal(framer.push(new Float32Array(1)).length, 1);
});

// ---------------------------------------------------------------------------
// The sample clip
// ---------------------------------------------------------------------------

function wav({ rate = 44_100, channels = 2, bits = 16, kind = 1, frames = [[0, 0]], extra = [] }) {
  const data = Buffer.alloc(frames.length * channels * (bits / 8));
  frames.forEach((frame, i) => frame.forEach((value, c) => {
    if (bits === 16) data.writeInt16LE(value, (i * channels + c) * 2); else data.writeUInt8(value, i * channels + c);
  }));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(kind, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);
  const head = Buffer.alloc(8);
  head.write('data', 0);
  head.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, ...extra, head, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

test('the sample clip: a 16-bit WAV is read into one channel between -1 and 1', () => {
  const stereo = parseWav(wav({ frames: [[16_384, 16_384], [-32_768, -32_768], [32_767, 0], [0, 0]] }));
  assert.equal(stereo.rate, 44_100);
  assert.deepEqual([...stereo.samples].map((v) => Math.round(v * 1000) / 1000), [0.5, -1, 0.5, 0]);
  assert.ok(stereo.samples instanceof Float32Array);
  const mono = parseWav(wav({ rate: 48_000, channels: 1, frames: [[8192], [-8192]] }));
  assert.deepEqual([mono.rate, ...mono.samples], [48_000, 0.25, -0.25]);
  // A note before the sound (a title, say), of odd length, is stepped over.
  const note = Buffer.concat([Buffer.from('LIST'), Buffer.from([5, 0, 0, 0]), Buffer.from('hello'), Buffer.from([0])]);
  assert.deepEqual([...parseWav(wav({ channels: 1, frames: [[16_384]], extra: [note] })).samples], [0.5]);
  // Given as an ArrayBuffer, as a browser has it.
  const bytes = wav({ channels: 1, frames: [[16_384]] });
  assert.deepEqual([...parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).samples], [0.5]);
  // A file that says it holds more sound than it does is read as far as it goes.
  const cut = wav({ channels: 1, frames: [[1], [2], [3], [4]] }).subarray(0, 44 + 4);
  assert.equal(parseWav(cut).samples.length, 2);
});

test('the sample clip: anything that is not such a file is refused in plain words', () => {
  const refused = /not a sound file we can read/;
  assert.throws(() => parseWav(Buffer.from('not a wav at all, just some text that is long enough')), refused);
  assert.throws(() => parseWav(Buffer.alloc(10)), refused);
  assert.throws(() => parseWav(null), refused);
  assert.throws(() => parseWav(wav({ bits: 8, channels: 1, frames: [[1], [2]] })), refused, '8-bit');
  assert.throws(() => parseWav(wav({ kind: 3, channels: 1, frames: [[1]] })), refused, 'not plain PCM');
  assert.throws(() => parseWav(wav({ rate: 0, channels: 1, frames: [[1]] })), refused);
  // No sound in it at all.
  assert.throws(() => parseWav(wav({ channels: 1, frames: [[1]] }).subarray(0, 36)), refused);
});

// ---------------------------------------------------------------------------
// How far a first download has got, and numbers for the check page
// ---------------------------------------------------------------------------

test('progress: a whole number of percent that never goes down, and 100 only when every file is in', () => {
  const sizes = { a: 600, b: 300, c: 100 };
  const p = createProgress(sizes);
  assert.equal(p.total, 1000);
  assert.equal(p.percent(), 0);
  assert.equal(p.add('a', 150), 15);
  assert.equal(p.add('a', 150), 30);
  assert.equal(p.add('nothing-we-know', 5000), 30, 'a file that is not on the list counts for nothing');
  assert.equal(p.add('a', 5000), 60, 'never more than the file’s own size');
  assert.equal(p.done('b'), 90);
  assert.equal(p.add('c', 99), 99, 'all but one byte: still not 100');
  assert.equal(p.add('c', 1), 100);
  // The whole of a file at once (it was kept from last time), and all three: 100.
  const q = createProgress(sizes);
  assert.equal(q.done('a'), 60);
  assert.equal(q.done('b'), 90);
  assert.equal(q.add('c', 0), 90);
  assert.equal(q.add('c', -5), 90);
  assert.equal(q.done('c'), 100);
  // The real list: about 49 MB.
  const real = createProgress();
  assert.ok(real.total > 49_000_000 && real.total < 49_500_000, String(real.total));
  for (const path of Object.keys(CAPTION_FILES.sizes).slice(1)) real.done(path);
  assert.equal(real.percent(), 98, 'stops short of 100 while one file is missing');
});

test('typical and worst: the middle one and the largest', () => {
  assert.deepEqual(typicalAndWorst([]), { typical: 0, worst: 0, count: 0 });
  assert.deepEqual(typicalAndWorst([300]), { typical: 300, worst: 300, count: 1 });
  assert.deepEqual(typicalAndWorst([900, 100, 500]), { typical: 500, worst: 900, count: 3 });
  assert.deepEqual(typicalAndWorst([4, 1, 3, 2]), { typical: 2, worst: 4, count: 4 });
  assert.deepEqual(typicalAndWorst([10, NaN, Infinity, 20]), { typical: 10, worst: 20, count: 2 });
});

// ---------------------------------------------------------------------------
// Sound in, captions out: the rules together, with a pretend model
// ---------------------------------------------------------------------------

const TENTH = RATE / 10;      // a block of a tenth of a second at the model's rate
// A pretend worker. Blocks of sound are "loud" (speech) or silent; the
// pretend detector says so, and the pretend model writes two words for each
// second of the clip it is given, from `script`. Time is a number the test
// owns: hearing a frame costs 1 ms, writing costs `writeMs`, and a block
// cannot be dealt with before it has arrived.
function captioning({ script = 'ask not what your country can do for you ask what you can do for your country', writeMs = 120, rate = RATE } = {}) {
  const words = script.split(' ');
  const c = { now: 1_000_000, told: [], written: [], resets: 0, heardFrames: 0, writeMs, arrives: 1_000_000 };
  const captioner = createCaptioner({
    speechProbability: async (frame) => { c.now += 1; c.heardFrames += 1; return frame[frame.length >> 1] > 0.5 ? 0.9 : 0.05; },
    write: async (clip, maxTokens) => {
      c.written.push({ length: clip.length, maxTokens, speech: clip.reduce((n, v) => n + (v > 0.5 ? 1 : 0), 0) });
      c.now += typeof c.writeMs === 'function' ? c.writeMs(clip) : c.writeMs;
      if (c.fail) throw new Error(c.fail);
      // Two words for each second of speech in the clip: what a model would have heard so far.
      const said = words.slice(0, Math.max(1, Math.floor((c.written.at(-1).speech / RATE) * 2)));
      return ` ${said.join(' ')}${c.rewrite?.(c.written.length) || ''} `;
    },
    resetDetector: () => { c.resets += 1; },
    tell: (message) => c.told.push({ ...message, at: c.now }),
    clock: () => c.now,
  });
  c.captioner = captioner;
  // `tenths` blocks of a tenth of a second each, loud or silent, arriving in real time.
  c.hear = async (loud, tenths) => {
    for (let i = 0; i < tenths; i += 1) {
      c.arrives += 100;
      c.now = Math.max(c.now, c.arrives);
      await captioner.push({ samples: new Float32Array(Math.round(rate / 10)).fill(loud ? 1 : 0), rate, t: c.arrives });
    }
    return c;
  };
  c.of = (type) => c.told.filter((m) => m.type === type);
  c.captions = () => c.of('caption').map((m) => `${m.kind}: ${m.text}`);
  return c;
}

test('captioner: a sentence comes out as growing words, then the finished sentence', async () => {
  const c = captioning();
  await c.hear(false, 10);
  await c.hear(true, 40);
  await c.hear(false, 12);
  const captions = c.of('caption');
  assert.ok(captions.length >= 4, c.captions().join(' / '));
  const partials = captions.filter((m) => m.kind === 'partial');
  const finals = captions.filter((m) => m.kind === 'final');
  assert.equal(finals.length, 1);
  assert.equal(captions.at(-1), finals[0], 'the finished sentence comes last');
  assert.equal(finals[0].text, 'ask not what your country can do for');
  // What is shown of the sentence in progress only ever grows…
  for (let i = 1; i < partials.length; i += 1) assert.ok(partials[i].text.startsWith(`${partials[i - 1].text} `), `${partials[i - 1].text} -> ${partials[i].text}`);
  // …and is behind what the model last wrote: only words two looks agree on.
  assert.equal(partials[0].text, 'ask', 'the first words appear with the second look');
  assert.ok(finals[0].text.startsWith(partials.at(-1).text));
  assert.ok(captions.every((m) => m.id === 1));
  // Nothing but captions and a note of the lag now and then; every message says only what it should.
  assert.deepEqual([...new Set(c.told.map((m) => m.type))].sort(), ['caption', 'lag']);
  for (const m of captions) assert.deepEqual(Object.keys(m).sort(), ['at', 'delayMs', 'id', 'kind', 'text', 'type']);
  for (const m of c.of('lag')) assert.deepEqual(Object.keys(m).sort(), ['at', 'ms', 'type']);
  // How late the words were: about a second for words in progress, and the wait for quiet for the sentence.
  assert.ok(partials.every((m) => m.delayMs > 700 && m.delayMs < 1500), JSON.stringify(partials.map((m) => m.delayMs)));
  assert.ok(finals[0].delayMs >= 700 && finals[0].delayMs < 1000, String(finals[0].delayMs));
  assert.equal(c.captioner.stopped, false);
  assert.equal(c.resets, 0);
});

test('captioner: the model is given at least a second of sound, with the agreed cap, and is not asked twice for the same words', async () => {
  const c = captioning();
  await c.hear(false, 10);
  await c.hear(true, 5);
  await c.hear(false, 20);
  // Half a second of speech: one look (padded to a second), and its words are the sentence.
  assert.deepEqual(c.captions(), ['final: ask']);
  assert.equal(c.written.length, 1, 'the sentence was not worked out a second time');
  // Longer sentences: every clip the model saw, and the cap it was given.
  await c.hear(true, 45);
  await c.hear(false, 10);
  assert.ok(c.written.length >= 5);
  for (const w of c.written) {
    assert.ok(w.length >= RATE, 'never less than a second');
    assert.equal(w.maxTokens, Math.max(8, Math.ceil((w.length / RATE) * 7)));
    assert.ok(w.length <= 14.04 * RATE);
  }
  assert.equal(c.of('caption').filter((m) => m.kind === 'final').length, 2);
  // Someone already speaking when captions start: the first look has only
  // 0.8 seconds of sound, and is given a full second all the same.
  const sudden = captioning();
  await sudden.hear(true, 9);
  assert.equal(sudden.written.length, 1);
  assert.equal(sudden.written[0].length, RATE);
  assert.ok(sudden.written[0].speech < RATE, 'the rest is the quiet that was added');
  assert.equal(sudden.written[0].maxTokens, 8);
  // The last look came after the last word, so the second sentence was not written twice either.
  assert.equal(c.written.length, c.of('caption').length - 2 + 2, 'one look for each caption shown, one that showed nothing in each sentence');
});

test('captioner: words shown are never rewritten, even when the model changes its mind', async () => {
  // Every third look, the model says something else about the start of the sentence.
  const c = captioning();
  c.rewrite = (n) => (n % 3 === 0 ? ' — no, wait' : '');
  const told = c.told;
  await c.hear(false, 10);
  await c.hear(true, 80);
  await c.hear(false, 10);
  const partials = told.filter((m) => m.type === 'caption' && m.kind === 'partial');
  assert.ok(partials.length >= 3);
  for (let i = 1; i < partials.length; i += 1) assert.ok(partials[i].text.startsWith(partials[i - 1].text), `${partials[i - 1].text} -> ${partials[i].text}`);
  assert.ok(!partials.some((m) => /wait/.test(m.text)), 'what only one look said never reached the screen');
});

test('captioner: sound at the tablet’s own rate gives the same captions', async () => {
  const at16 = captioning();
  const at48 = captioning({ rate: 48_000 });
  const at441 = captioning({ rate: 44_100 });
  for (const c of [at16, at48, at441]) {
    await c.hear(false, 10);
    await c.hear(true, 30);
    await c.hear(false, 12);
  }
  assert.ok(at16.captions().length >= 3);
  assert.deepEqual(at48.captions(), at16.captions());
  assert.deepEqual(at441.captions(), at16.captions());
});

test('captioner: more than 3 seconds behind, it drops what is waiting, says “paused”, then “resumed”; the third time it gives up', async () => {
  // A tablet on which every look at a sentence takes 4 seconds.
  const c = captioning({ writeMs: 4000 });
  await c.hear(false, 10);
  await c.hear(true, 20);
  const story = () => c.told.filter((m) => m.type !== 'lag' && m.type !== 'caption').map((m) => m.type);
  assert.deepEqual(story(), ['paused'], 'the first look took 4 seconds: the sound after it is too old');
  assert.equal(c.resets, 1, 'the speech detector starts afresh');
  const heardWhenPaused = c.heardFrames;
  const writtenWhenPaused = c.written.length;
  // The blocks that were waiting are dropped unheard, until sound that is fresh again.
  await c.hear(true, 20);
  assert.equal(c.heardFrames, heardWhenPaused, 'nothing that was waiting was listened to');
  assert.deepEqual(story(), ['paused']);
  await c.hear(true, 20);
  assert.deepEqual(story(), ['paused', 'resumed']);
  const resumed = c.of('resumed')[0];
  const firstHeard = c.heardFrames - heardWhenPaused;
  assert.ok(firstHeard > 0);
  // It took up again with sound no more than half a second old.
  assert.ok(c.told.filter((m) => m.type === 'lag' && m.at >= resumed.at).every((m) => m.ms <= 500 + 4000));
  // Speech goes on. The next look is slow again (it comes later than the
  // first did: looks are spaced by how long the last one took), and so on.
  await c.hear(true, 200);
  assert.deepEqual(story(), ['paused', 'resumed', 'paused', 'resumed', 'error']);
  const error = c.of('error')[0];
  assert.equal(error.code, 'too_slow');
  assert.equal(c.captioner.stopped, true);
  assert.equal(c.captioner.pauses, 3);
  assert.equal(c.resets, 2);
  assert.ok(c.written.length > writtenWhenPaused);
  // After that it listens to nothing and says nothing.
  const [heard, written, told] = [c.heardFrames, c.written.length, c.told.length];
  await c.hear(true, 50);
  assert.deepEqual([c.heardFrames, c.written.length, c.told.length], [heard, written, told]);
  // No words from before a pause are shown after it: each pause starts a sentence afresh.
  assert.ok(c.of('caption').every((m) => m.kind === 'partial' || m.text.length > 0));
});

test('captioner: a tablet that is only a little slow shows fewer looks, and never falls 3 seconds behind', async () => {
  const c = captioning({ writeMs: 900 });
  await c.hear(false, 10);
  await c.hear(true, 100);
  await c.hear(false, 12);
  assert.deepEqual(c.told.filter((m) => !['lag', 'caption'].includes(m.type)), [], 'no pause');
  assert.ok(c.of('lag').every((m) => m.ms < 3000));
  // Looks are at least 1.5 times as far apart as the last one took.
  const quick = captioning({ writeMs: 50 });
  await quick.hear(false, 10);
  await quick.hear(true, 100);
  await quick.hear(false, 12);
  assert.ok(c.written.length < quick.written.length, `${c.written.length} looks against ${quick.written.length}`);
  assert.ok(c.of('caption').some((m) => m.kind === 'final'));
});

test('captioner: one thing at a time, in the order the sound came', async () => {
  const order = [];
  let release;
  let now = 0;
  const captioner = createCaptioner({
    speechProbability: async (frame) => { order.push(`hear ${frame[0]}`); return frame[0] >= 1 ? 0.9 : 0.05; },
    write: () => { order.push('write…'); return new Promise((resolve) => { release = () => { order.push('…written'); resolve('hello'); }; }); },
    tell: (m) => order.push(`tell ${m.type}`),
    clock: () => now,
  });
  const block = (value) => ({ samples: new Float32Array(TENTH).fill(value), rate: RATE, t: now });
  for (let i = 1; i <= 9; i += 1) captioner.push(block(1));          // speech: a look falls due in the 9th block
  const all = captioner.push(block(2));
  captioner.push(block(3));
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.at(-1), 'write…', 'the model is writing');
  const before = order.length;
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.length, before, 'and nothing else happens meanwhile, though more sound is waiting');
  release();
  await all;
  const after = order.slice(before);
  assert.equal(after[0], '…written');
  assert.ok(after.indexOf('hear 2') < after.indexOf('hear 3'), 'the waiting blocks are then heard in order');
  assert.ok(after.includes('hear 3'));
});

test('captioner: if the model breaks, captions stop with one plain message', async () => {
  const c = captioning();
  c.fail = 'RangeError: Out of memory';
  await c.hear(false, 10);
  await c.hear(true, 30);
  assert.deepEqual(c.of('error').map(({ code, message }) => ({ code, message })), [{ code: 'unavailable', message: 'RangeError: Out of memory' }]);
  assert.equal(c.captioner.stopped, true);
  assert.deepEqual(c.of('caption'), []);
  const told = c.told.length;
  await c.hear(true, 30);
  assert.equal(c.told.length, told);
});
