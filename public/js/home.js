// The home screen: always on, in the home of the person being visited.
// Large, calm, and theirs to control: who may visit, whether anyone may come
// straight in, pausing visits, and ending any visit with one tap. A red light
// and their visitor's name show for the whole of every visit.
import { $, el, initials, tokenFromLink, connect, getCamera, stopStream, makePeer, unlockSound, chime } from './common.js';

const token = tokenFromLink();
let link;
let home = null;
let call = null;          // { visitorId, name, state }
let stream = null;
let peer = null;
let ringTimer = null;
let countdownTimer = null;

function showProblem(title, text) {
  $('#problem-title').textContent = title;
  $('#problem-text').textContent = text;
  $('#problem').hidden = false;
}

// ----- Clock and greeting -----
function tick() {
  const now = new Date();
  const h = now.getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = home ? `${part}, ${home.personName}` : part;
  $('#clock').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
setInterval(tick, 10_000);
tick();

// ----- The list of people -----
function render() {
  if (!home) return;
  tick();
  $('#status').textContent = home.paused ? 'Visits are paused' : 'Visits are open';
  $('#status').className = `status-pill ${home.paused ? 'paused' : 'open'}`;
  $('#pause').textContent = home.paused ? 'Open visits again' : 'Pause visits';
  $('#pause').classList.toggle('yes', home.paused);

  const people = $('#people');
  people.replaceChildren(...home.visitors.map((v) => {
    const send = (msg) => link.send({ ...msg, visitorId: v.id });
    const controls = v.approved
      ? [
          el('button', { class: `btn toggle ${v.mode === 'dropin' ? 'on' : ''}`, type: 'button', 'aria-pressed': String(v.mode === 'dropin'),
            onclick: () => send({ type: 'mode', mode: v.mode === 'dropin' ? 'knock' : 'dropin' }) },
            v.mode === 'dropin' ? 'Can come straight in' : 'Asks me first'),
          el('button', { class: 'btn quiet', type: 'button', onclick: () => {
            if (confirm(`Stop ${v.name}'s visits? You can say yes again later.`)) send({ type: 'approve', approved: false });
          } }, 'Stop visits'),
        ]
      : [
          el('p', { class: 'ask' }, `${v.name} would like to be able to visit you.`),
          el('button', { class: 'btn yes', type: 'button', onclick: () => send({ type: 'approve', approved: true }) }, 'Yes'),
          el('button', { class: 'btn no', type: 'button', onclick: () => send({ type: 'approve', approved: false }) }, 'Not now'),
        ];
    return el('article', { class: `person ${v.approved ? '' : 'pending'}` },
      el('div', { class: 'avatar' }, initials(v.name)),
      el('div', { class: 'person-text' }, el('p', { class: 'person-name' }, v.name), v.relation ? el('p', { class: 'muted' }, v.relation) : null),
      el('div', { class: 'person-controls' }, controls));
  }));
  $('#nobody').hidden = home.visitors.length > 0;
}

$('#pause').addEventListener('click', () => {
  if (!home) return;
  link.send({ type: 'pause', paused: !home.paused });
});

// ----- Someone knocks -----
function showKnock({ visitorId, name, mode, notice }) {
  call = { visitorId, name, state: 'ringing' };
  $('#knock-avatar').textContent = initials(name);
  $('#knock').hidden = false;
  chime();
  clearInterval(ringTimer);
  ringTimer = setInterval(chime, 3000);
  if (mode === 'dropin') {
    let left = notice || 8;
    $('#knock-title').textContent = `${name} is coming in`;
    $('#answer').textContent = 'Let them in now';
    const update = () => { $('#knock-sub').textContent = `In ${left} second${left === 1 ? '' : 's'}. Tap “Not now” to stop them.`; };
    update();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(countdownTimer); answer(); } else update();
    }, 1000);
  } else {
    $('#knock-title').textContent = `${name} is here to see you`;
    $('#knock-sub').textContent = 'Would you like to answer?';
    $('#answer').textContent = 'Answer';
  }
}

function hideKnock() {
  clearInterval(ringTimer);
  clearInterval(countdownTimer);
  $('#knock').hidden = true;
}

async function answer() {
  if (!call || call.state !== 'ringing') return;
  hideKnock();
  const { visitorId, name } = call;
  call.state = 'connecting';
  try {
    stream = await getCamera();
  } catch {
    link.send({ type: 'decline', visitorId });
    call = null;
    alert('The camera or microphone could not be used. Please ask your family to check the tablet’s settings.');
    return;
  }
  $('#local').srcObject = stream;
  $('#with-you-text').textContent = `${name} is with you`;
  $('#call').hidden = false;
  $('#idle').hidden = true;
  peer = await makePeer({
    stream,
    offerer: false,
    sendSignal: (data) => link.send({ type: 'signal', data }),
    onRemote: (remote) => { const v = $('#remote'); if (v.srcObject !== remote) v.srcObject = remote; },
  });
  // Only now is the visitor told to start: the video link is ready for them.
  link.send({ type: 'answer', visitorId });
}

function endLocal() {
  hideKnock();
  peer?.close();
  peer = null;
  stopStream(stream);
  stream = null;
  $('#remote').srcObject = null;
  $('#local').srcObject = null;
  $('#call').hidden = true;
  $('#idle').hidden = false;
  call = null;
}

$('#answer').addEventListener('click', answer);
$('#decline').addEventListener('click', () => {
  if (call) link.send({ type: 'decline', visitorId: call.visitorId });
  endLocal();
});
$('#end').addEventListener('click', () => {
  link.send({ type: 'end' });
  endLocal();
});

// ----- Messages from the server -----
function onMessage(msg) {
  switch (msg.type) {
    case 'state':
      home = msg.home;
      render();
      break;
    case 'knock':
      if (!call) showKnock(msg);
      break;
    case 'signal':
      peer?.handleSignal(msg.data).catch((e) => console.error(e));
      break;
    case 'ended':
      endLocal();
      break;
    default:
  }
}

function start() {
  if (!token) return showProblem('This screen needs its link', 'Ask the family member who set it up to open the home screen link on this tablet.');
  link = connect({
    role: 'home',
    token,
    onMessage,
    onState: (s) => {
      if (s === 'closed') { $('#status').textContent = 'Reconnecting…'; $('#status').className = 'status-pill'; endLocal(); }
    },
    onRejected: (code) => {
      endLocal();
      if (code === 4004) showProblem('Open on another screen', 'Be There was opened on another screen. Reload this page to use it here instead.');
      else showProblem('This link no longer works', 'Ask your family for the new home screen link.');
    },
  });
  // Keep the screen awake while Be There is open, where the browser allows it.
  const wake = () => navigator.wakeLock?.request('screen').catch(() => {});
  wake();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
}

// Connect straight away, so the screen is "on" as soon as it is opened.
// The first tap anywhere turns on the chime (browsers require a tap for sound).
start();
$('#start').hidden = false;
document.addEventListener('pointerdown', () => {
  unlockSound();
  $('#start').hidden = true;
}, { once: true });
