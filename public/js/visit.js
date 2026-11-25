// The visitor's page: see whether you can visit, then knock (or come straight
// in, if the person at home allows it).
import { $, tokenFromLink, connect, getCamera, stopStream, makePeer } from './common.js';

const token = tokenFromLink();
let link;
let view = null;
let phase = 'idle';      // idle | ringing | live
let stream = null;
let peer = null;
let lastEnd = '';

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
};

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

async function startCall() {
  phase = 'live';
  $('#lobby').hidden = true;
  $('#call').hidden = false;
  $('#with-text').textContent = `You are with ${view.personName}`;
  $('#local').srcObject = stream;
  peer = await makePeer({
    stream,
    offerer: true,
    sendSignal: (data) => link.send({ type: 'signal', data }),
    onRemote: (remote) => { const v = $('#remote'); if (v.srcObject !== remote) v.srcObject = remote; },
  });
}

function endLocal(reason) {
  peer?.close();
  peer = null;
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
      startCall().catch((e) => { console.error(e); link.send({ type: 'end' }); endLocal('ended'); });
      break;
    case 'signal':
      peer?.handleSignal(msg.data).catch((e) => console.error(e));
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
  $('#state').textContent = 'Ask the family for your Be There link.';
} else {
  link = connect({
    role: 'visitor',
    token,
    onMessage,
    onState: (s) => { if (s === 'closed' && phase !== 'idle') endLocal('offline'); },
    onRejected: () => {
      endLocal();
      $('#title').textContent = 'This link no longer works';
      $('#state').textContent = 'Ask the family for a new one.';
      $('#state').className = 'status-pill paused';
      $('#visit').hidden = true;
      $('#hint').textContent = '';
    },
  });
}
