// Be There's address, and the only address devices may ever be sent on to.
//
// The app answers at two addresses: the first one the host gave it
// (be-there-gp50.onrender.com), which must keep working for ever because
// devices hold their links there, and bethere.gladspring.org. A browser
// treats them as two different sites, so a page that moves to the new one
// takes its link's secret with it, after the #. That makes the new address a
// place every home, visitor and organizer link could be handed to. So it is
// fixed here, in the code: a slip in the service's settings, or someone else
// taking a look-alike name, can never send a link anywhere else.
//
// Pure: nothing here reads the environment or logs. The server never
// redirects and never turns a request away because of its address; moving is
// done by the page itself (public/js/moved.js), and never by the home screen.

export const CANONICAL_ALLOW = Object.freeze(['https://bethere.gladspring.org']);

// A plain web origin: scheme and host (and port), nothing after it.
function isOrigin(text) {
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === text;
  } catch {
    return false;
  }
}

// What CANONICAL_ORIGIN asks for, checked against the list.
//   { origin: an entry of `allow`, or null,
//     ignored: true when something was asked for and it is not on the list }
// Only an exact match counts (spaces around the value aside): no other
// scheme, port, path, capital letters or longer name. The entry of the list
// is returned, never the text that was given.
export function canonicalOriginFrom(value, allow = CANONICAL_ALLOW) {
  const asked = typeof value === 'string' ? value.trim() : value == null ? '' : null;
  if (asked === '') return { origin: null, ignored: false };
  const list = Array.isArray(allow) ? allow : [];
  const found = asked === null ? undefined : list.find((entry) => typeof entry === 'string' && entry === asked && isOrigin(entry));
  return found ? { origin: found, ignored: false } : { origin: null, ignored: true };
}
