// The visitor's page: see whether you can visit, then knock (or come straight
// in, if the person at home allows it).
import { $, rememberedToken, forgetToken, connect, getCamera, stopStream } from './common.js';
import { startCall as startPeer } from './peer.js';

// "?relay=1" before the # sends this visit through the relay from the start:
// a way to check that the relay works. Read it first, because remembering the
// link below can tidy the address and drop it.
const forceRelay = new URLSearchParams(location.search).get('relay') === '1';
const token = rememberedToken('visit');
let link;
let view = null;
let phase = 'idle';      // idle | ringing | live
let stream = null;
let peer = null;
let lastEnd = '';
// For the small line during a visit that says how the two devices are connected.
let linkState = '';      // connecting | connected | reconnecting
let path = null;         // { relayed }
let note = '';

const END_TEXT = {
  declined: 'They can’t talk right now. Try again later.',
  no_answer: 'No answer this time. Try again later.',
  paused: 'They have paused visits for now.',
  not_allowed: 'Your visits have been stopped.',
  removed: 'Your visits have been stopped.',
  offline: 'Their screen went offline.',
  ended: 'The visit has ended.',
  cancelled: '',
  busy: 'Someone else is visiting right now.',
  no_connection: 'The video couldn’t connect. Please try again in a moment.',
};

const NOTE_TEXT = {
  relay_not_set_up: 'The relay is not set up, so this visit is using a direct connection.',
  relay_unavailable: 'The relay could not be reached, so this visit is using a direct connection.',
};

// One small line, so the family can tell whether a visit went directly or
// through the relay. This is the only place the visitor page mentions it.
function renderPath() {
  $('#path').textContent = linkState === 'reconnecting' ? 'Reconnecting…'
    : path?.relayed ? 'Connected through the relay.'
    : note ? note
    : path ? 'Connected directly.'
    : linkState === 'connecting' ? 'Connecting…' : '';
}

function renderLobby() {
  if (!view) return;
  const name = view.personName;
  $('#title').textContent = phase === 'ringing' ? `Waiting for ${name}…` : `Visit ${name}`;
  const pill = $('#state');
  if (phase === 'ringing') {
    pill.textContent = view.you.mode === 'dropin' ? 'Letting them know you’re coming in' : 'Knocking…';
    pill.className = 'status-pill open';
  } else {
    pill.textContent = view.canVisit ? `${name} is available` : view.statusText;
    pill.className = `status-pill ${view.canVisit ? 'open' : 'paused'}`;
  }
  const hint = phase === 'ringing'
    ? (view.you.mode === 'dropin' ? `${name} gets a few seconds’ notice and can say “Not now”.` : `${name} will see that you are here and can answer.`)
    : lastEnd || (view.status === 'outside_hours' ? `Visiting hours are ${view.hours.start}–${view.hours.end} (${view.timeZone}).` : '');
  $('#hint').textContent = hint;
  $('#visit').hidden = phase !== 'idle';
  $('#visit').disabled = !view.canVisit;
  $('#visit').textContent = view.you.mode === 'dropin' ? 'Visit now' : 'Knock';
  $('#cancel').hidden = phase !== 'ringing';
}

async function knock() {
  lastEnd = '';
  try {
    stream = await getCamera();
  } catch {
    $('#hint').textContent = 'Please allow your camera and microphone, then try again.';
    return;
  }
  $('#preview').srcObject = stream;
  $('#preview').hidden = false;
  phase = 'ringing';
  renderLobby();
  link.send({ type: 'knock' });
}

function startCall() {
  phase = 'live';
  $('#lobby').hidden = true;
  $('#call').hidden = false;
  $('#with-text').textContent = `You are with ${view.personName}`;
  $('#local').srcObject = stream;
  const mine = startPeer({
    role: 'visitor',
    stream,
    link,
    forceRelay,
    onRemote: (remote) => { const v = $('#remote'); if (v.srcObject !== remote) v.srcObject = remote; },
    onState: (state) => {
      if (peer !== mine) return;
      // The video never connected, or was lost for good: the visit is over.
      if (state === 'no_connection') return endLocal('no_connection');
      // After a drop the way through may have changed: say nothing about it
      // until it has been read again.
      if (state === 'reconnecting') path = null;
      linkState = state;
      renderPath();
    },
    onPath: (info) => { if (peer === mine) { path = info; renderPath(); } },
    onNote: (code) => { if (peer === mine) { note = NOTE_TEXT[code] || ''; renderPath(); } },
  });
  peer = mine;
  mine.ready.catch((e) => {
    console.error(e);
    if (peer !== mine) return;
    link.send({ type: 'end' });
    endLocal('ended');
  });
}

function endLocal(reason) {
  peer?.close();
  peer = null;
  linkState = '';
  path = null;
  note = '';
  renderPath();
  stopStream(stream);
  stream = null;
  $('#preview').hidden = true;
  $('#preview').srcObject = null;
  $('#remote').srcObject = null;
  $('#local').srcObject = null;
  $('#call').hidden = true;
  $('#lobby').hidden = false;
  phase = 'idle';
  if (reason !== undefined) lastEnd = END_TEXT[reason] ?? '';
  renderLobby();
}

$('#visit').addEventListener('click', knock);
$('#cancel').addEventListener('click', () => { link.send({ type: 'cancel' }); endLocal('cancelled'); });
$('#end').addEventListener('click', () => { link.send({ type: 'end' }); endLocal('ended'); });

function onMessage(msg) {
  switch (msg.type) {
    case 'status':
      view = msg.view;
      renderLobby();
      break;
    case 'ringing':
      break;
    case 'answered':
      // A second 'answered' must not start a second video link.
      if (phase === 'ringing') startCall();
      break;
    case 'signal':
      peer?.handleSignal(msg.data);
      break;
    case 'relay':
      peer?.handleRelay(msg);
      break;
    case 'cannot':
      endLocal(msg.reason);
      break;
    case 'ended':
      if (phase !== 'idle') endLocal(msg.reason);
      break;
    default:
  }
}

if (!token) {
  $('#title').textContent = 'This link is missing its key';
  $('#state').textContent = 'Open your Be There link again, in full.';
  $('#hint').textContent = 'The long code after the # was lost. If you set things up, use “Open it on this phone” on the organizer page.';
  $('#visit').hidden = true;
} else {
  link = connect({
    role: 'visitor',
    token,
    onMessage,
    onState: (s) => { if (s === 'closed' && phase !== 'idle') endLocal('offline'); },
    onRejected: () => {
      forgetToken('visit');
      endLocal();
      $('#title').textContent = 'This link no longer works';
      $('#state').textContent = 'Ask the family for a new one.';
      $('#state').className = 'status-pill paused';
      $('#visit').hidden = true;
      $('#hint').textContent = '';
    },
  });
}
