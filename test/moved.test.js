// The move to the new address (public/js/moved.js), without a browser: a
// pretend page address, server answer and live connection, and a clock the
// test moves by hand. The real thing, in two browsers, is in test/e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMover, MOVES_BY_ITSELF, WAIT, goToNewAddress, newAddress } from '../public/js/moved.js';

const OLD = 'https://be-there-gp50.onrender.com';
const NEW = 'https://bethere.gladspring.org';
const TOKEN = 'q3J-7_dVb0aXk2mN5pR8sT1uW4yZ6cE9fH0iK3lM7oQ';   // the shape of a real link secret

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeClock() {
  let now = 0;
  let ids = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { ids += 1; timers.set(ids, { at: now + ms, fn }); return ids; },
    clearTimeout: (id) => { timers.delete(id); },
    get waiting() { return timers.size; },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
    },
  };
}

// One page. `config` is what GET /api/config answers (or a function that
// makes the answer); `door` says what the connection to the new address does:
// 'open', 'error', 'close', 'silent' or 'throw'.
function page({ href = `${OLD}/visit#${TOKEN}`, config = { canonicalOrigin: NEW }, door = 'open' } = {}) {
  const clock = fakeClock();
  const url = new URL(href);
  const went = [];
  const location = { origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search, hash: url.hash, replace: (to) => went.push(to) };
  const fetched = [];
  const fetch = async (path, options) => {
    fetched.push([path, options]);
    if (typeof config === 'function') return config(options);
    return { ok: true, json: async () => config };
  };
  const sockets = [];
  class Socket {
    constructor(address) {
      if (door === 'throw') throw new Error('refused');
      Object.assign(this, { address, sent: [], closed: 0 });
      sockets.push(this);
      setImmediate(() => {
        if (door === 'open') this.onopen?.();
        if (door === 'error') { this.onerror?.(); this.onclose?.(); }
        if (door === 'close') this.onclose?.();
      });
    }
    send(data) { this.sent.push(data); }
    close() { this.closed += 1; setImmediate(() => this.onclose?.()); }
  }
  const mover = createMover({ fetch, WebSocket: Socket, location, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, AbortController });
  // Runs the hand-off and says how it came out: 'stayed' (it returned) or
  // 'left' (it is still waiting for the browser to leave the page).
  let outcome = 'left';
  const run = async (kind, token, wait = 0) => {
    mover.goToNewAddress(kind, token).then(() => { outcome = 'stayed'; }, () => { outcome = 'threw'; });
    await clock.advance(wait);
    await flush();
    return outcome;
  };
  return { clock, location, went, fetched, sockets, mover, run, get outcome() { return outcome; } };
}

test('a visitor page at the old address goes to the new one, with its link after the #', async () => {
  const p = page();
  assert.equal(await p.run('visit', TOKEN), 'left', 'it never returns: the browser is leaving the page');
  assert.deepEqual(p.went, [`${NEW}/visit#${TOKEN}`]);
  // It first checked the door visits use at the new address, and sent nothing through it.
  assert.equal(p.sockets.length, 1);
  assert.equal(p.sockets[0].address, 'wss://bethere.gladspring.org/ws');
  assert.deepEqual(p.sockets[0].sent, []);
  assert.equal(p.sockets[0].closed, 1, 'and closed it again');
  assert.equal(p.fetched.length, 1);
  assert.equal(p.fetched[0][0], '/api/config');
  assert.equal(p.clock.waiting, 0, 'no timer is left running');
  // Still waiting much later: it never carries on at the old address.
  await p.clock.advance(60_000);
  assert.deepEqual(p.went, [`${NEW}/visit#${TOKEN}`]);
});

test('the secret only ever travels after the #, and the rest of the address is kept', async () => {
  const forced = page({ href: `${OLD}/visit?relay=1#${TOKEN}` });
  await forced.run('visit', TOKEN);
  assert.deepEqual(forced.went, [`${NEW}/visit?relay=1#${TOKEN}`]);

  const organizer = page({ href: `${OLD}/organize#${TOKEN}` });
  await organizer.run('organize', TOKEN);
  assert.deepEqual(organizer.went, [`${NEW}/organize#${TOKEN}`]);

  // No link on this device: the page still moves, with nothing after it.
  for (const none of [undefined, '', null]) {
    const setup = page({ href: `${OLD}/setup` });
    await setup.run('setup', none);
    assert.deepEqual(setup.went, [`${NEW}/setup`]);
  }

  for (const p of [forced, organizer]) {
    const [before] = p.went[0].split('#');
    assert.doesNotMatch(before, new RegExp(TOKEN));
    assert.doesNotMatch(JSON.stringify(p.fetched), new RegExp(TOKEN), 'the secret is not sent to the server');
    assert.doesNotMatch(p.sockets[0].address, new RegExp(TOKEN));
  }

  // Whatever the link held comes out the same when the new page reads it back
  // (it reads it with decodeURIComponent, as common.js does).
  for (const odd of ['a b', '100%', 'x#y', 'é/ü?&=', TOKEN]) {
    const p = page();
    await p.run('visit', odd);
    assert.equal(decodeURIComponent(new URL(p.went[0]).hash.slice(1)), odd);
  }
});

test('the home screen never moves by itself', async () => {
  assert.deepEqual(MOVES_BY_ITSELF, ['visit', 'organize', 'setup']);
  for (const kind of ['home', 'Home', 'home ', undefined, null, '', 'anything-else', ['visit']]) {
    const p = page({ href: `${OLD}/home#${TOKEN}` });
    assert.equal(await p.run(kind, TOKEN, 10_000), 'stayed', String(kind));
    assert.deepEqual(p.went, []);
    assert.deepEqual(p.sockets, [], 'it does not even look at the new address');
    assert.deepEqual(p.fetched, []);
  }
  // Nor does the home screen's own script load this file, or any page but these three.
  const read = (file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(read('js/home.js'), /moved\.js|goToNewAddress|newAddress|canonicalOrigin|location\.(replace|assign|href\s*=)/);
  assert.doesNotMatch(read('home.html'), /moved\.js/);
  assert.doesNotMatch(read('js/common.js'), /moved\.js|canonicalOrigin/);
  assert.doesNotMatch(read('js/peer.js'), /moved\.js|canonicalOrigin/);
  // The three that do move wait for the answer before they start anything.
  assert.match(read('js/visit.js'), /^goToNewAddress\('visit', token\)\.then\(start\);$/m);
  assert.match(read('js/organize.js'), /^  await goToNewAddress\('organize', token\);$/m);
  assert.match(read('js/setup.js'), /^const linksAt = goToNewAddress\('setup'\)\.then\(newAddress\)/m);
  assert.match(read('js/setup.js'), /const linkBase = await linksAt;\s+const res = await api\('\/api\/homes'/, 'no home is created before the page knows where it is staying');
});

test('with no new address, or already there, the page stays and nothing is tried', async () => {
  const cases = {
    'an older server': { iceServers: [], dropInNoticeSeconds: 8 },
    'not switched on': { canonicalOrigin: null },
    'already at the new address': { canonicalOrigin: OLD },
  };
  for (const [name, config] of Object.entries(cases)) {
    const p = page({ config });
    assert.equal(await p.run('visit', TOKEN), 'stayed', name);
    assert.deepEqual(p.went, [], name);
    assert.deepEqual(p.sockets, [], name);
    assert.equal(p.clock.waiting, 0, name);
  }
  const there = page({ href: `${NEW}/visit#${TOKEN}` });
  assert.equal(await there.run('visit', TOKEN), 'stayed');
  assert.deepEqual(there.sockets, []);
  assert.equal(await there.mover.newAddress(), NEW);
});

test('if the new address does not answer, the page stays where it is', async () => {
  for (const door of ['error', 'close', 'throw']) {
    const p = page({ door });
    assert.equal(await p.run('visit', TOKEN), 'stayed', door);
    assert.deepEqual(p.went, [], door);
    assert.equal(p.clock.waiting, 0, door);
  }

  // A connection that neither opens nor fails: give up after four seconds.
  const p = page({ door: 'silent' });
  assert.equal(await p.run('visit', TOKEN, WAIT.door - 1), 'left', 'still waiting just before four seconds');
  assert.deepEqual(p.went, []);
  await p.clock.advance(1);
  await flush();
  assert.equal(p.outcome, 'stayed');
  assert.deepEqual(p.went, []);
  assert.equal(p.sockets[0].closed, 1, 'the half-made connection is closed');
  assert.deepEqual(p.sockets[0].sent, []);
  // It opens after all, too late: the page has carried on here and must not be pulled away.
  p.sockets[0].onopen?.();
  await p.clock.advance(60_000);
  assert.deepEqual(p.went, []);
  assert.equal(p.clock.waiting, 0);
  assert.equal(WAIT.door, 4000);
});

test('if the server cannot be asked, the page stays where it is', async () => {
  const bad = {
    'the request fails': () => { throw new Error('offline'); },
    'the server says no': () => ({ ok: false, status: 503, json: async () => ({ canonicalOrigin: NEW }) }),
    'the answer is not JSON': () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }),
    'the answer is empty': () => ({ ok: true, json: async () => null }),
  };
  for (const [name, config] of Object.entries(bad)) {
    const p = page({ config });
    assert.equal(await p.run('visit', TOKEN), 'stayed', name);
    assert.deepEqual(p.went, [], name);
    assert.deepEqual(p.sockets, [], name);
    assert.equal(await p.mover.newAddress(), null, name);
    assert.equal(p.clock.waiting, 0, name);
  }

  // A server that never answers does not hold the page up for ever.
  let aborted = false;
  const p = page({ config: (options) => new Promise(() => { options.signal.addEventListener('abort', () => { aborted = true; }); }) });
  assert.equal(await p.run('visit', TOKEN, WAIT.config - 1), 'left');
  await p.clock.advance(1);
  await flush();
  assert.equal(p.outcome, 'stayed');
  assert.deepEqual(p.went, []);
  assert.deepEqual(p.sockets, []);
  assert.equal(aborted, true, 'the request is given up');
  assert.equal(await p.mover.newAddress(), null);
});

test('only a plain address is ever followed', async () => {
  const odd = [
    `${NEW}/`, `${NEW}/visit`, `${NEW}?x`, `${NEW}#x`, `${NEW}:443`, 'https://user@bethere.gladspring.org', 'HTTPS://bethere.gladspring.org',
    '//bethere.gladspring.org', 'bethere.gladspring.org', 'wss://bethere.gladspring.org', 'javascript:alert(1)', 'data:text/html,hello',
    '', ' ', 0, 1, true, {}, [NEW], { origin: NEW },
  ];
  for (const canonicalOrigin of odd) {
    const p = page({ config: { canonicalOrigin } });
    assert.equal(await p.run('visit', TOKEN), 'stayed', JSON.stringify(canonicalOrigin));
    assert.deepEqual(p.went, []);
    assert.deepEqual(p.sockets, []);
    assert.equal(await p.mover.newAddress(), null);
  }
  // Never from a page reached safely to an address that is not.
  const down = page({ config: { canonicalOrigin: 'http://bethere.gladspring.org' } });
  assert.equal(await down.run('visit', TOKEN), 'stayed');
  assert.deepEqual(down.sockets, []);
  assert.equal(await down.mover.newAddress(), null);
  // On a developer's machine, plain http to plain http is allowed (the e2e uses it).
  const local = page({ href: `http://localhost:3000/visit#${TOKEN}`, config: { canonicalOrigin: 'http://127.0.0.1:3000' } });
  assert.equal(await local.run('visit', TOKEN), 'left');
  assert.equal(local.sockets[0].address, 'ws://127.0.0.1:3000/ws');
  assert.deepEqual(local.went, [`http://127.0.0.1:3000/visit#${TOKEN}`]);
});

test('newAddress gives link builders the new address, asking the server once', async () => {
  const p = page({ door: 'error' });
  assert.equal(await p.run('organize', TOKEN), 'stayed');
  // The page stayed, but links made on it point at the new address all the same.
  assert.equal(await p.mover.newAddress(), NEW);
  assert.equal(await p.mover.newAddress(), NEW);
  assert.equal(p.fetched.length, 1);
  assert.equal(p.fetched[0][1].cache, 'no-store');

  const none = page({ config: { canonicalOrigin: null } });
  assert.equal(await none.mover.newAddress(), null);
});

test('without a browser at all, it does nothing and does not throw', async () => {
  // The page's own functions, with nothing passed in: no location here.
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no server here'); };
  try {
    await goToNewAddress('visit', TOKEN);
    assert.equal(await newAddress(), null);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(fetched <= 1);
});

test('the file stands alone, so an older common.js can never stop a page', () => {
  const source = fs.readFileSync(new URL('../public/js/moved.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bimport\(/);
  // And it writes nothing down: no console, no storage.
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|document\.cookie/);
});
