// The organizer page: for the family member who set things up.
import { $, el, api, initials, tokenFromLink, copyText } from './common.js';
import { goToNewAddress, newAddress } from './moved.js';
import { squarePhoto, getPhotoUrl, cachedPhotoUrl, keepOnlyPhotos, photoFetcher, createFaces } from './photo.js';

let token = tokenFromLink();
let home = null;
// The last answer about the home screen and the relay, so the list can be
// drawn again between two checks with the server.
let seen = { online: false, relay: 'off' };
// Where the links made here point: at the new address once there is one,
// whichever address this page was opened at.
let linkBase = location.origin;

const call = (path, opts = {}) => api(path, { token, ...opts });

// The phone's own share sheet (Messages, Mail, AirDrop), where available:
// it sends the whole link, so the secret after the # is never lost.
function offerShare(button, url, title) {
  if (!navigator.share) return;
  button.hidden = false;
  button.onclick = () => navigator.share({ title, url }).catch(() => {});
}

// What the relay test found, in plain words.
function relayResultText(res) {
  if (res.ok) return 'The relay works.';
  const reason = String(res.reason || '');
  if (reason === 'not_set_up') return 'The relay is not set up yet, so there is nothing to test.';
  if (/^http_(401|403|404)$/.test(reason)) return 'The relay service did not accept the key. Check TURN_KEY_ID and TURN_API_TOKEN.';
  if (reason === 'timeout' || reason === 'network') return 'The relay service could not be reached. Try again in a moment.';
  return 'The relay service gave an answer we did not expect. Try again in a moment.';
}

// ----- Photos of visitors -----
// Only this page adds, changes or removes a visitor's photo. The picture that
// was picked stays on this device: a small square copy is made here and only
// that is sent (photo.js). What is shown in the list afterwards is fetched
// back from the server, so it is exactly what the home screen shows.
const photoPath = (id) => `/api/organize/visitors/${encodeURIComponent(id)}/photo`;
const fetchPhoto = photoFetcher(photoPath, () => token);
const faces = createFaces('avatar small');
let photoFor = null;      // id of the visitor whose photo is being added or changed
let photoNote = null;     // { id, text, bad }: a line under that visitor
let photoBusy = false;

const redraw = () => { if (home) render(seen.online, seen.relay); };

function loadPhotos() {
  keepOnlyPhotos(home.visitors.map((v) => v.id));
  for (const v of home.visitors) {
    const had = cachedPhotoUrl(v.id);
    getPhotoUrl(v.id, v.photo, fetchPhoto).then((url) => { if (url !== had) redraw(); });
  }
}

// Under a visitor's name: "Add a photo", or "Change photo" and "Remove photo".
function photoTools(v) {
  const open = photoFor === v.id;
  return el('div', { class: 'photo-tools' },
    el('button', { class: 'btn', type: 'button', disabled: photoBusy, 'aria-expanded': String(open), onclick: () => {
      photoFor = open ? null : v.id;
      photoNote = null;
      redraw();
    } }, v.photo ? 'Change photo' : 'Add a photo'),
    v.photo ? el('button', { class: 'btn quiet', type: 'button', disabled: photoBusy, onclick: async () => {
      if (!confirm(`Remove ${v.name}’s photo?`)) return;
      photoFor = null;
      photoNote = null;
      try {
        await call(photoPath(v.id), { method: 'DELETE' });
      } catch (err) {
        photoNote = { id: v.id, text: err.message, bad: true };
      }
      load();
    } }, 'Remove photo') : null);
}

// Across the foot of a visitor's row: the two ways to pick a photo, while one
// is being added or changed, and a line saying how it went.
function photoPanel(v) {
  const pick = (input) => () => {
    photoFor = v.id;
    $(input)?.click();
  };
  return [
    photoFor === v.id ? el('div', { class: 'photo-pick' },
      el('button', { class: 'btn yes big-btn', type: 'button', disabled: photoBusy, onclick: pick('#photo-take') }, 'Take a photo'),
      el('button', { class: 'btn big-btn', type: 'button', disabled: photoBusy, onclick: pick('#photo-choose') }, 'Choose a photo'),
      el('button', { class: 'btn quiet', type: 'button', disabled: photoBusy, onclick: () => { photoFor = null; redraw(); } }, 'Cancel')) : null,
    photoNote?.id === v.id ? el('p', { class: `photo-note ${photoNote.bad ? 'bad' : ''}`, role: 'status' }, photoNote.text) : null,
  ];
}

// A picture was taken or chosen: make the small square copy, send it, show it.
async function photoPicked(input) {
  const file = input.files?.[0];
  // Cleared at once, so that picking the same picture again is noticed too.
  input.value = '';
  const v = home?.visitors.find((x) => x.id === photoFor);
  if (!file || !v || photoBusy) return;
  const say = (text, bad = false) => { photoNote = { id: v.id, text, bad }; redraw(); };
  photoBusy = true;
  say('Adding the photo…');
  try {
    const blob = await squarePhoto(file);
    let res;
    try {
      res = await fetch(photoPath(v.id), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: blob });
    } catch {
      throw new Error('The photo could not be sent. Please check the connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
    photoFor = null;
    photoBusy = false;
    say(`Photo saved. ${home.personName} will see it beside ${v.name}’s name.`);
    load();
  } catch (err) {
    photoBusy = false;
    say(err.message, true);
  }
}
for (const id of ['#photo-take', '#photo-choose']) $(id)?.addEventListener('change', (e) => photoPicked(e.target));

function render(online, relay) {
  seen = { online, relay };
  $('#relay-state').textContent = relay === 'ready' ? 'Relay: ready' : 'Relay: not set up (visits still work on most home networks)';
  $('#title').textContent = home.name;
  for (const n of document.querySelectorAll('.person-name-inline')) n.textContent = home.personName;
  $('#online').textContent = online ? 'Home screen is on' : 'Home screen is off: open its link on their tablet';
  $('#online').className = `status-pill ${online ? 'open' : ''}`;
  $('#paused').hidden = !home.paused;
  $('#tz').textContent = home.timeZone;
  // Don't overwrite the hours while someone is editing them.
  if (!$('#hours').contains(document.activeElement)) {
    $('#hours').start.value = home.hours.start;
    $('#hours').end.value = home.hours.end;
  }
  $('#visitors').replaceChildren(...(home.visitors.length ? home.visitors.map((v) => el('li', {},
    faces.of(v.id, initials(v.name), cachedPhotoUrl(v.id)),
    el('div', { class: 'visitor-main' },
      el('span', { class: 'visitor-name' }, v.name, v.relation ? el('span', { class: 'muted' }, ` · ${v.relation}`) : null),
      photoTools(v)),
    el('span', { class: `tag ${v.approved ? 'ok' : 'wait'}` }, v.approved ? (v.mode === 'dropin' ? 'Can come straight in' : 'Knocks first') : `Waiting for ${home.personName} to say yes`),
    el('button', { class: 'btn quiet', type: 'button', onclick: async () => {
      if (!confirm(`Remove ${v.name}? Their link will stop working.`)) return;
      await call(`/api/organize/visitors/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      load();
    } }, 'Remove'),
    photoPanel(v))) : [el('li', { class: 'muted' }, 'Nobody yet. Invite the first person below.')]));
  faces.keepOnly(home.visitors.map((v) => v.id));
  $('#content').hidden = false;
}

async function load() {
  try {
    const res = await call('/api/organize');
    home = res.home;
    loadPhotos();
    render(res.online, res.relay);
  } catch (err) {
    $('#title').textContent = 'Be There';
    $('#error').textContent = err.message;
    $('#content').hidden = true;
  }
}

$('#invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const res = await call('/api/organize/visitors', { method: 'POST', body: { name: f.get('name'), relation: f.get('relation') } });
    $('#new-name').textContent = res.visitor.name;
    const url = `${linkBase}/visit#${res.token}`;
    $('#new-url').textContent = url;
    $('#new-open').href = url;
    offerShare($('#new-share'), url, `Your Be There link to visit ${home.personName}`);
    $('#new-link').hidden = false;
    e.target.reset();
    load();
  } catch (err) { $('#error').textContent = err.message; }
});

$('#hours').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await call('/api/organize/home', { method: 'PATCH', body: { hours: { start: f.get('start'), end: f.get('end') } } });
    load();
  } catch (err) { $('#error').textContent = err.message; }
});

$('#relay-test').addEventListener('click', async () => {
  const button = $('#relay-test');
  button.disabled = true;
  $('#relay-result').textContent = 'Testing…';
  try {
    $('#relay-result').textContent = relayResultText(await call('/api/organize/relay-test', { method: 'POST' }));
  } catch (err) {
    $('#relay-result').textContent = err.message;
  }
  button.disabled = false;
});

$('#new-home-link').addEventListener('click', async () => {
  if (!confirm('Make a new home screen link? The current home screen will stop working until you open the new link on it.')) return;
  const res = await call('/api/organize/home-link', { method: 'POST' });
  const homeUrl = `${linkBase}/home#${res.homeToken}`;
  $('#home-url').textContent = homeUrl;
  offerShare($('#home-share'), homeUrl, `Be There home screen for ${home.personName}`);
  $('#home-link-box').hidden = false;
});

$('#new-org-link').addEventListener('click', async () => {
  if (!confirm('Make a new organizer link? This one will stop working.')) return;
  const res = await call('/api/organize/organizer-link', { method: 'POST' });
  token = res.organizerToken;
  const url = `${linkBase}/organize#${token}`;
  history.replaceState(null, '', `/organize#${token}`);
  $('#org-url').textContent = url;
  $('#org-link-box').hidden = false;
});

$('#delete').addEventListener('click', async () => {
  if (!confirm(`Delete ${home.name} and every visitor link? This cannot be undone.`)) return;
  await call('/api/organize/home', { method: 'DELETE' });
  document.body.replaceChildren(el('main', { class: 'page narrow' }, el('h1', {}, 'Deleted'), el('p', {}, 'The home and all its links are gone.')));
});

document.addEventListener('click', (e) => {
  const id = e.target.dataset?.copy;
  if (id) copyText($(`#${id}`).textContent, e.target);
});

async function start() {
  // If Be There has a new address, go there first, with the link. When the
  // page moves, this never comes back and nothing is loaded here.
  await goToNewAddress('organize', token);
  const movedTo = await newAddress();
  if (movedTo) {
    linkBase = movedTo;
    // The home screen is the one page that does not move by itself: say how
    // the family can move it.
    if ($('#moved-note')) {
      $('#moved-host').textContent = new URL(movedTo).host;
      $('#moved-note').hidden = false;
    }
  }
  if (!token) $('#error').textContent = 'This page needs your organizer link.';
  else {
    load();
    setInterval(load, 15_000);
  }
}
start();
