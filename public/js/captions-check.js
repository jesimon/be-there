// The captions check: a page a family opens on a tablet or phone before
// relying on captions there. It runs the same worker and the same listening
// as a visit does (captions.js), on a sample of clear speech, and says in
// plain words whether the device is quick enough. Nothing about any home or
// visit is involved, and nothing it hears or writes leaves the device.
import { $ } from './common.js';
import { CAPTION_FILES, parseWav } from './caption-text.js';
import { captionsSupported, captionsCodeAt, openCaptionsWorker, startCaptions, showCaptions } from './captions.js';

const FAST_ENOUGH = 0.3;          // the model must take less than this share of the speech's own length
const TOTAL_BYTES = Object.values(CAPTION_FILES.sizes).reduce((sum, bytes) => sum + bytes, 0);
const mb = (bytes) => (bytes / 1_000_000).toFixed(1);
const secs = (ms) => (ms / 1000).toFixed(1);
// "?seconds=20" shortens the long test (the automated test of this page uses it).
const asked = Number(new URLSearchParams(location.search).get('seconds'));
const LONG_TEST_SECONDS = asked >= 5 && asked <= 600 ? Math.round(asked) : 120;

let codeAt = '/js';
let engine = null;                // the worker from step 1, while it is alive
let sample = null;                // the speech: { rate, samples }
let heard = null;                 // what the worker says back during step 2
const found = {};                 // every number, for the last card

const say = (id, text, bad = false) => { const node = $(id); node.textContent = text; node.classList.toggle('error', bad); };
function problem(text) { $('#problem').textContent = text; $('#problem').hidden = false; }
function enable({ step1 = true, step2 = !!engine, step3 = !!found.ready } = {}) {
  $('#step1').disabled = !step1;
  $('#step2').disabled = !step2;
  $('#step3').disabled = !step3;
}

function showAnswer() {
  const lines = [];
  if (found.ready) lines.push(`Got ready in ${secs(found.ready.ms)} s (${found.ready.fetchedBytes ? `${mb(found.ready.fetchedBytes)} MB fetched` : 'already on this device'})`);
  if (found.quick) lines.push(`Quick test: ${secs(found.quick.ms)} s for ${found.quick.seconds.toFixed(1)} s of speech (${found.quick.share.toFixed(2)} of its length)`, `It wrote: ${found.quick.text}`);
  if (found.long) {
    lines.push(`Long test: ${found.long.seconds} s, ${found.long.captions} sentences, ${found.long.pauses} pauses to catch up${found.long.stopped ? `, stopped: ${found.long.stopped}` : ''}`,
      `Words after speech: usually ${secs(found.long.delay.typical)} s, at worst ${secs(found.long.delay.worst)} s`,
      `Behind the sound: usually ${secs(found.long.lag.typical)} s, at worst ${secs(found.long.lag.worst)} s`,
      `Sound: ${found.long.rate} Hz, ${found.long.heard.blocks} blocks heard, loudest ${found.long.heard.loudest}`);
  }
  if (found.untried) lines.push(`Long test not run: ${found.untried}`);
  if (found.error) lines.push(`Went wrong: ${found.error}`);
  lines.push(`Browser: ${navigator.userAgent}`);
  $('#numbers').textContent = lines.join('\n');

  const quickOk = !found.quick || found.quick.share < FAST_ENOUGH;
  const longOk = !found.long || (!found.long.stopped && found.long.pauses === 0 && found.long.captions > 0 && found.long.lag.worst < 3000 && found.long.lag.typical < 1000);
  // The model was quick enough, and yet no words came: it was given nothing to hear.
  const nothingHeard = found.long && !found.long.stopped && found.long.captions === 0;
  let verdict = 'Not tried yet.';
  if (found.unsupported) verdict = 'Captions can’t run in this browser.';
  else if (found.error && !found.quick && !found.long) verdict = 'Captions could not be started on this device.';
  else if (nothingHeard) verdict = 'Captions did not work on this device.';
  else if (found.long) verdict = quickOk && longOk ? 'This device can show captions.' : 'Captions would lag on this device.';
  else if (found.quick) verdict = quickOk ? 'This device can show captions. (That is from the quick test; the two-minute test is the surer one.)' : 'Captions would lag on this device.';
  $('#verdict').textContent = verdict;
}

// ----- 1. Get ready -----
async function getReady() {
  enable({ step1: false, step2: false, step3: false });
  engine?.close();
  engine = null;
  delete found.error;
  say('#result1', 'Getting ready…');
  const started = performance.now();
  const mine = openCaptionsWorker({
    codeAt,
    onProgress: ({ percent, fetching }) => say('#result1', fetching ? `Fetching… ${mb((percent / 100) * TOTAL_BYTES)} of ${mb(TOTAL_BYTES)} MB` : 'Starting…'),
    onMessage: (message) => heard?.(message),
  });
  const outcome = await Promise.race([mine.ready.then((info) => ({ info })), mine.failed.then((failure) => ({ failure }))]);
  if (outcome.failure) {
    mine.close();
    found.error = outcome.failure.message || outcome.failure.code;
    say('#result1', 'Captions could not be started on this device.', true);
  } else {
    engine = mine;
    // If it breaks later (the device ran out of room, say), say so.
    mine.failed.then((failure) => { if (engine === mine) { engine = null; found.error = failure.message || failure.code; enable(); showAnswer(); } });
    found.ready = { ms: performance.now() - started, fetchedBytes: outcome.info.fetchedBytes || 0 };
    say('#result1', `Ready. It took ${secs(found.ready.ms)} seconds${found.ready.fetchedBytes ? `, and ${mb(found.ready.fetchedBytes)} MB were fetched` : '; everything was already on this device'}.`);
  }
  enable();
  showAnswer();
}

// The sample of speech, from our own server (it is one of the captions files).
async function loadSample() {
  if (sample) return sample;
  const response = await fetch(`${CAPTION_FILES.base}${CAPTION_FILES.sample}`);
  if (!response.ok) throw new Error(`The sample could not be fetched (${response.status}).`);
  sample = parseWav(await response.arrayBuffer());
  return sample;
}

// ----- 2. Quick test -----
async function quickTest() {
  enable({ step1: false, step2: false, step3: false });
  say('#result2', 'Listening to the sample…');
  try {
    if (!engine) throw new Error('Press “Get ready” first.');
    const { rate, samples } = await loadSample();
    const copy = samples.slice();
    const answer = new Promise((resolve, reject) => {
      heard = (message) => { if (message.type === 'transcribed') resolve(message); };
      engine.failed.then((failure) => reject(new Error(failure.message || failure.code)));
    });
    engine.send({ type: 'transcribe', id: 1, samples: copy, rate }, [copy.buffer]);
    const result = await answer;
    found.quick = { ms: result.ms, seconds: result.seconds, share: result.ms / 1000 / result.seconds, text: result.text };
    const quick = found.quick.share < FAST_ENOUGH;
    say('#result2', `It wrote: “${result.text}” That took ${secs(result.ms)} seconds for ${result.seconds.toFixed(0)} seconds of speech: ${quick ? 'fast enough' : 'too slow for captions'}.`, !quick);
  } catch (err) {
    found.error = err.message;
    say('#result2', 'The quick test could not be run.', true);
  }
  heard = null;
  enable();
  showAnswer();
}

// ----- 3. Two-minute test -----
// The sample goes round and round through a video link from this page to
// itself, and is captioned from the far end of it: the same path a visitor's
// voice takes, model, listening and all.
async function longTest() {
  enable({ step1: false, step2: false, step3: false });
  // One model in memory at a time, as in a visit.
  engine?.close();
  engine = null;
  const box = $('#captions');
  let view = { state: 'loading', lines: [] };
  const draw = () => showCaptions(box, view);
  let context = null;
  let player = null;
  let sender = null;
  let receiver = null;
  let run = null;
  let lock = null;
  const outcome = { stopped: '' };
  let result = ['The two-minute test could not be run.', true];
  delete found.untried;
  // A fault of this test itself, which says nothing about captions in a visit.
  const untried = (why) => Object.assign(new Error(why), { untried: true });
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  // Some devices let a page start sound only from inside a tap, and this is
  // the tap: so both things that make sound here are started now, before
  // anything is waited for. Any later tap tries again.
  const remote = new MediaStream();
  const wake = () => {
    try { Promise.resolve(context?.resume()).catch(() => {}); } catch { /* still asleep */ }
    try { Promise.resolve($('#loop').play()).catch(() => {}); } catch { /* still waiting */ }
    try { run?.nudge(); } catch { /* not listening */ }
  };
  try {
    context = new (window.AudioContext || window.webkitAudioContext)();
    $('#loop').srcObject = remote;
  } catch { /* said below */ }
  wake();
  for (const tap of ['pointerdown', 'click']) document.addEventListener(tap, wake);
  try {
    say('#result3', 'Starting…');
    const { rate, samples } = await loadSample();
    if (!context) throw untried('this browser has no way to play the sample.');
    for (let waited = 0; waited < 3000 && context.state !== 'running'; waited += 100) await pause(100);
    if (context.state !== 'running') throw untried('the sound could not be started. Please press the button again.');
    lock = await navigator.wakeLock?.request('screen').catch(() => null);
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    player = context.createBufferSource();
    player.buffer = buffer;
    player.loop = true;
    const out = context.createMediaStreamDestination();
    player.connect(out);

    sender = new RTCPeerConnection();
    receiver = new RTCPeerConnection();
    sender.onicecandidate = (e) => { if (e.candidate) receiver.addIceCandidate(e.candidate).catch(() => {}); };
    receiver.onicecandidate = (e) => { if (e.candidate) sender.addIceCandidate(e.candidate).catch(() => {}); };
    const arrived = new Promise((resolve) => { receiver.ontrack = (e) => { remote.addTrack(e.track); resolve(); }; });
    for (const track of out.stream.getAudioTracks()) sender.addTrack(track, out.stream);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    await arrived;
    // Played out loud, as a visitor's voice is: a browser gives a page no
    // sound to listen to from a link it is not playing.
    if ($('#loop').srcObject !== remote) $('#loop').srcObject = remote;
    wake();
    player.start();
    // The link from this page to itself has to be up before anything can be
    // heard through it. If it never comes up, captions were never tried.
    const linked = () => ['connected', 'completed'].includes(receiver.iceConnectionState);
    for (let waited = 0; waited < 10_000 && !linked(); waited += 200) await pause(200);
    if (!linked()) throw untried('this page could not make a sound link to itself.');

    draw();
    const ended = new Promise((resolve) => {
      run = startCaptions({
        remoteStream: remote,
        audioContext: context,
        codeAt,
        onUpdate: (lines) => { view = { ...view, lines }; draw(); },
        onStatus: (state, info) => {
          view = { ...view, state, percent: info?.percent };
          draw();
          if (state === 'too_slow' || state === 'unavailable') { outcome.stopped = state === 'too_slow' ? 'could not keep up' : 'could not run'; resolve(); }
        },
      });
    });
    for (let left = LONG_TEST_SECONDS; left > 0 && !outcome.stopped; left -= 1) {
      say('#result3', `Testing… ${left} seconds to go.`);
      await Promise.race([ended, new Promise((resolve) => { setTimeout(resolve, 1000); })]);
    }
    const numbers = run.numbers();
    found.long = { seconds: LONG_TEST_SECONDS, ...numbers, stopped: outcome.stopped };
    result = [outcome.stopped ? `Captions stopped: they ${outcome.stopped} on this device.`
      : numbers.captions === 0 ? `No words appeared. ${numbers.heard.loudest < 0.005 ? 'This browser gave captions no sound to listen to.' : 'The speech was heard, but no words came of it.'}`
      : `Done. Words appeared about ${secs(numbers.delay.typical)} seconds after they were spoken (${secs(numbers.delay.worst)} at worst). Captions ran ${secs(numbers.lag.typical)} seconds behind the sound (${secs(numbers.lag.worst)} at worst), and ${numbers.pauses === 0 ? 'never had to pause to catch up' : numbers.pauses === 1 ? 'paused to catch up once' : `paused to catch up ${numbers.pauses} times`}.`, !!outcome.stopped || numbers.captions === 0];
  } catch (err) {
    if (err.untried) {
      found.untried = err.message;
      result = [`The two-minute test could not be run: ${err.message} That says nothing about captions in a visit.`, true];
    } else {
      found.error = err.message;
    }
  }
  for (const tap of ['pointerdown', 'click']) document.removeEventListener(tap, wake);
  try { run?.stop(); } catch { /* already stopped */ }
  try { player?.stop(); } catch { /* never started */ }
  sender?.close();
  receiver?.close();
  $('#loop').srcObject = null;
  await context?.close().catch(() => {});
  lock?.release?.().catch(() => {});
  showCaptions(box, { state: 'off' });
  // Said last, when everything has been put away again.
  say('#result3', ...result);
  enable();
  showAnswer();
}

$('#step1').addEventListener('click', getReady);
$('#step2').addEventListener('click', quickTest);
$('#step3').addEventListener('click', longTest);
if (LONG_TEST_SECONDS !== 120) for (const id of ['#step3', '#step3-title']) $(id).textContent = $(id).textContent.replace('Two-minute', `${LONG_TEST_SECONDS}-second`);

// Is there anything to try? The server says whether it has the captions files.
async function start() {
  if (!captionsSupported()) {
    found.unsupported = true;
    problem('This browser can’t run captions.');
    return showAnswer();
  }
  let config = null;
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    config = response.ok ? await response.json() : null;
  } catch { /* said below */ }
  if (config?.captions !== 'ready') {
    problem(config?.captions === 'preparing' ? 'Captions are still being set up on the server. Please try again in a few minutes.'
      : config ? 'Captions are switched off on this server.' : 'The server could not be reached. Please try again in a moment.');
    return showAnswer();
  }
  codeAt = captionsCodeAt(config.captionsCode);
  enable();
  showAnswer();
}
start();
