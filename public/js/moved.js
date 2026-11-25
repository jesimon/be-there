// Be There has a new address. This is how a page that was opened at the old
// one goes there, taking its link with it.
//
// A browser treats the two addresses as different sites: what one remembers,
// the other does not know, and each asks for the camera by itself. So the
// server never redirects. The page itself moves, and only when all of this is
// true:
//   - the server names a new address (it only ever names the one fixed in
//     lib/address.js),
//   - this is not the home screen,
//   - the new address answers right now, at the very door visits use.
// The link's secret travels after the #, which is never sent to any server.
// Nothing is forgotten at the old address, which keeps working for ever.
//
// The home screen never moves by itself. On the new address the tablet asks
// for the camera and microphone once more, and that question must not come up
// unannounced in front of the person at home. It moves when a family member
// opens a new home screen link there, while they are with them.
//
// This file stands alone: it imports nothing, so a page can never be stopped
// by an older common.js that the browser has kept.

// The pages that go to the new address by themselves.
export const MOVES_BY_ITSELF = Object.freeze(['visit', 'organize', 'setup']);

// How long to wait, in milliseconds, before deciding to stay.
export const WAIT = { config: 4000, door: 4000 };

// A plain web address (scheme, host, port) and nothing else, or null.
function plainOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

// `deps` lets test/moved.test.js run this without a browser.
export function createMover(deps = {}) {
  const get = (name) => deps[name] || globalThis[name];
  const later = (fn, ms) => (deps.setTimeout || globalThis.setTimeout)(fn, ms);
  const cancel = (id) => (deps.clearTimeout || globalThis.clearTimeout)(id);
  let asked = null;

  async function readNewAddress() {
    const here = get('location');
    const Stop = get('AbortController');
    const stop = Stop ? new Stop() : null;
    // A server that never answers must not hold the page up for ever.
    let timer;
    const tooLate = new Promise((resolve) => { timer = later(() => { stop?.abort(); resolve(null); }, WAIT.config); });
    const answer = (async () => {
      const res = await get('fetch')('/api/config', { cache: 'no-store', ...(stop ? { signal: stop.signal } : {}) });
      if (!res.ok) return null;
      const there = plainOrigin((await res.json())?.canonicalOrigin);
      // Never from a safe page to one that is not.
      if (there && here.protocol === 'https:' && !there.startsWith('https://')) return null;
      return there;
    })();
    try {
      return await Promise.race([answer, tooLate]);
    } finally {
      cancel(timer);
    }
  }

  // The new address, or null when there is none (or the server could not be
  // asked). Asked for once per page. Never rejects.
  function newAddress() {
    asked ||= readNewAddress().catch(() => null);
    return asked;
  }

  // Can visits work there? Open the same live connection every page uses,
  // wait for it to open, and close it again. Nothing is sent on it.
  function doorOpens(there) {
    return new Promise((resolve) => {
      let socket = null;
      let settled = false;
      let timer = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        cancel(timer);
        try { socket?.close(); } catch { /* already closed */ }
        resolve(ok);
      };
      timer = later(() => finish(false), WAIT.door);
      try {
        socket = new (get('WebSocket'))(`${there.replace(/^http/, 'ws')}/ws`);
        socket.onopen = () => finish(true);
        socket.onerror = () => finish(false);
        socket.onclose = () => finish(false);
      } catch {
        finish(false);
      }
    });
  }

  // Call once, when the page loads, before it connects to anything. `kind` is
  // the page ('visit', 'organize' or 'setup'); `token` is its link's secret,
  // if it has one. If the page is to move, this never returns: the browser is
  // on its way. Otherwise it returns and the page carries on where it is.
  // Never throws.
  async function goToNewAddress(kind, token) {
    try {
      if (!MOVES_BY_ITSELF.includes(kind)) return;
      const here = get('location');
      const there = await newAddress();
      if (!there || there === here.origin) return;
      if (!(await doorOpens(there))) return;
      here.replace(`${there}${here.pathname}${here.search}${token ? `#${encodeURIComponent(token)}` : ''}`);
      await new Promise(() => {});
    } catch { /* the new address is not ready: stay here */ }
  }

  return { goToNewAddress, newAddress };
}

// The one for this page.
let page = null;
const mine = () => (page ||= createMover());
export const goToNewAddress = (kind, token) => mine().goToNewAddress(kind, token);
export const newAddress = () => mine().newAddress();
