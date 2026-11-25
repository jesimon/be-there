// The organizer page: for the family member who set things up.
import { $, el, api, tokenFromLink, copyText } from './common.js';

let token = tokenFromLink();
let home = null;

const call = (path, opts = {}) => api(path, { token, ...opts });

// The phone's own share sheet (Messages, Mail, AirDrop), where available:
// it sends the whole link, so the secret after the # is never lost.
function offerShare(button, url, title) {
  if (!navigator.share) return;
  button.hidden = false;
  button.onclick = () => navigator.share({ title, url }).catch(() => {});
}

function render(online) {
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
    el('span', { class: 'visitor-name' }, v.name, v.relation ? el('span', { class: 'muted' }, ` · ${v.relation}`) : null),
    el('span', { class: `tag ${v.approved ? 'ok' : 'wait'}` }, v.approved ? (v.mode === 'dropin' ? 'Can come straight in' : 'Knocks first') : `Waiting for ${home.personName} to say yes`),
    el('button', { class: 'btn quiet', type: 'button', onclick: async () => {
      if (!confirm(`Remove ${v.name}? Their link will stop working.`)) return;
      await call(`/api/organize/visitors/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      load();
    } }, 'Remove'))) : [el('li', { class: 'muted' }, 'Nobody yet. Invite the first person below.')]));
  $('#content').hidden = false;
}

async function load() {
  try {
    const res = await call('/api/organize');
    home = res.home;
    render(res.online);
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
    const url = `${location.origin}/visit#${res.token}`;
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

$('#new-home-link').addEventListener('click', async () => {
  if (!confirm('Make a new home screen link? The current home screen will stop working until you open the new link on it.')) return;
  const res = await call('/api/organize/home-link', { method: 'POST' });
  const homeUrl = `${location.origin}/home#${res.homeToken}`;
  $('#home-url').textContent = homeUrl;
  offerShare($('#home-share'), homeUrl, `Be There home screen for ${home.personName}`);
  $('#home-link-box').hidden = false;
});

$('#new-org-link').addEventListener('click', async () => {
  if (!confirm('Make a new organizer link? This one will stop working.')) return;
  const res = await call('/api/organize/organizer-link', { method: 'POST' });
  token = res.organizerToken;
  const url = `${location.origin}/organize#${token}`;
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

if (!token) $('#error').textContent = 'This page needs your organizer link.';
else {
  load();
  setInterval(load, 15_000);
}
