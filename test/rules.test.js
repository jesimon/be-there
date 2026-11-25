import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitStatus, visitorView, homeView, withinHours, cleanHours, cleanName, localMinutes } from '../lib/rules.js';
import { createStore } from '../lib/store.js';
import { hashToken } from '../lib/tokens.js';

const noon = new Date('2026-11-25T12:00:00Z');
const home = (over = {}) => ({ id: 'h', name: 'Mary’s home', personName: 'Mary', timeZone: 'UTC', hours: { start: '08:00', end: '21:00' }, paused: false, visitors: [], ...over });
const visitor = (over = {}) => ({ id: 'v', name: 'Sarah', approved: true, mode: 'knock', ...over });
const online = { online: true, busyWith: null };

test('a visitor can visit only once the person at home has said yes', () => {
  assert.equal(visitStatus(home(), visitor({ approved: false }), online, noon).reason, 'awaiting_approval');
  assert.deepEqual(visitStatus(home(), visitor(), online, noon), { ok: true, reason: 'available', mode: 'knock' });
});

test('pausing, hours, an offline screen and another visit each stop a visit', () => {
  assert.equal(visitStatus(home({ paused: true }), visitor(), online, noon).reason, 'paused');
  assert.equal(visitStatus(home(), visitor(), online, new Date('2026-11-25T22:00:00Z')).reason, 'outside_hours');
  assert.equal(visitStatus(home(), visitor(), { online: false }, noon).reason, 'offline');
  assert.equal(visitStatus(home(), visitor(), { online: true, busyWith: 'other' }, noon).reason, 'busy');
  assert.equal(visitStatus(home(), visitor(), { online: true, busyWith: 'v' }, noon).ok, true);
  assert.equal(visitStatus(home(), visitor({ removed: true }), online, noon).reason, 'removed');
});

test('visiting hours use the home’s own time zone and can wrap past midnight', () => {
  // 12:00 UTC is 07:00 in New York (EST): before 08:00 there.
  assert.equal(localMinutes(noon, 'America/New_York'), 7 * 60);
  assert.equal(withinHours({ start: '08:00', end: '21:00' }, 'America/New_York', noon), false);
  assert.equal(withinHours({ start: '08:00', end: '21:00' }, 'Europe/London', noon), true);
  assert.equal(withinHours({ start: '20:00', end: '02:00' }, 'UTC', new Date('2026-11-25T23:30:00Z')), true);
  assert.equal(withinHours({ start: '20:00', end: '02:00' }, 'UTC', noon), false);
  assert.equal(withinHours({ start: '08:00', end: '21:00' }, 'Not/AZone', noon), true, 'a bad zone falls back to UTC');
  // The same start and end means any time (a midnight-to-midnight setting).
  for (const h of ['00:00', '03:15', '12:00', '23:59']) assert.equal(withinHours({ start: '00:00', end: '00:00' }, 'UTC', new Date(`2026-11-25T${h}:00Z`)), true);
});

test('bad hours and names are cleaned', () => {
  assert.deepEqual(cleanHours({ start: '25:00', end: '10:00' }), { start: '08:00', end: '21:00' });
  assert.deepEqual(cleanHours({ start: '00:00', end: '00:00' }), { start: '00:00', end: '00:00' });
  assert.equal(cleanName('  <b>Sarah</b>\n  Jones  '), 'bSarah/b Jones');
  assert.equal(cleanName('x'.repeat(100)).length, 60);
});

test('a visitor sees only their own details, never the other visitors', () => {
  const h = home({ visitors: [visitor(), visitor({ id: 'w', name: 'Tom' })] });
  const view = visitorView(h, h.visitors[0], online, noon);
  assert.equal(view.canVisit, true);
  assert.doesNotMatch(JSON.stringify(view), /Tom/);
  assert.equal(homeView(h).visitors.length, 2);
  assert.doesNotMatch(JSON.stringify(homeView({ ...h, homeHash: 'secret', organizerHash: 'secret2' })), /secret/);
});

test('the store keeps only hashes of links, and removed visitors’ links stop working', () => {
  const store = createStore(':memory:');
  const { home: h, homeToken, organizerToken } = store.createHome({ personName: 'Mary', timeZone: 'Europe/London' });
  assert.equal(h.homeHash, hashToken(homeToken));
  assert.doesNotMatch(JSON.stringify(h), new RegExp(homeToken));
  assert.equal(store.homeByHomeToken(homeToken), h);
  assert.equal(store.homeByOrganizerToken(organizerToken), h);
  assert.equal(store.homeByHomeToken(organizerToken), null, 'an organizer link is not a home screen link');
  assert.equal(store.homeByHomeToken(''), null);
  const { visitor: v, token } = store.addVisitor(h, { name: 'Sarah', relation: 'Granddaughter' });
  assert.equal(v.approved, false, 'new visitors wait for the person at home');
  assert.equal(store.visitorByToken(token).visitor, v);
  store.removeVisitor(h, v.id);
  assert.equal(store.visitorByToken(token), null);
  const newToken = store.resetHomeLink(h);
  assert.equal(store.homeByHomeToken(homeToken), null);
  assert.equal(store.homeByHomeToken(newToken), h);
});
