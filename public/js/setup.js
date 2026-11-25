import { $, api, copyText } from './common.js';
import { goToNewAddress, newAddress } from './moved.js';

// If Be There has a new address, the home is set up there: this page goes
// there by itself, and then `linksAt` never arrives and nothing is created
// here. If the page stays, its two links still point at the new address once
// there is one.
const linksAt = goToNewAddress('setup').then(newAddress).then((there) => there || location.origin);

const info = await api('/api/setup-info').catch(() => ({ needsPassword: false }));
if (info.needsPassword) {
  $('#pw-label').hidden = false;
  $('#pw-label input').required = true;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error').textContent = '';
  try {
    const linkBase = await linksAt;
    const res = await api('/api/homes', {
      method: 'POST',
      body: {
        personName: f.get('personName'),
        name: f.get('name'),
        hours: { start: f.get('start'), end: f.get('end') },
        // The home screen sets its own time zone when it first connects.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        password: f.get('password') || '',
      },
    });
    const homeLink = `${linkBase}/home#${res.homeToken}`;
    const orgLink = `${linkBase}/organize#${res.organizerToken}`;
    $('#home-link').textContent = homeLink;
    $('#org-link').textContent = orgLink;
    $('#org-open').href = orgLink;
    $('#form').hidden = true;
    $('#done').hidden = false;
  } catch (err) {
    $('#error').textContent = err.message;
  }
});

document.addEventListener('click', (e) => {
  const id = e.target.dataset?.copy;
  if (id) copyText($(`#${id}`).textContent, e.target);
});
