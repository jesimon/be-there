import { $, api, copyText } from './common.js';

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
    const homeLink = `${location.origin}/home#${res.homeToken}`;
    const orgLink = `${location.origin}/organize#${res.organizerToken}`;
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
