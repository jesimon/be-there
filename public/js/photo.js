// Visitors' photos, in the browser. Three small parts:
//
//   squarePhoto()  makes the small square JPEG the server accepts out of
//                  whatever picture the organizer picked. The picture they
//                  picked never leaves their device: only the small copy is
//                  sent, and a copy made this way carries no record of where
//                  or when the photo was taken.
//   the cache      keeps each photo in memory once it has been fetched.
//   showFace()     shows a photo in a round "avatar", over the initials.
//
// A photo is fetched once for each version of it: when the page first learns
// its tag, or when the tag changes. It is never fetched because somebody
// knocks, a visit starts or ends, or the list is drawn again. The host can
// see which addresses are asked for and when, so asking for a visitor's photo
// at the moment they visit would leave a record of visits. We keep none.
//
// This file stands alone: it imports nothing.

export const PHOTO_SIZE = 384;                 // pixels a side
const QUALITIES = [0.85, 0.7, 0.55];           // tried in turn until the file is small enough
const SMALL_ENOUGH = 150 * 1024;               // bytes; the server takes up to 200 KB
const UNREADABLE = 'This kind of photo can’t be read here. Please take a new one or choose a different picture.';
const UNUSABLE = 'That picture couldn’t be used. Please try another photo.';

// ----- Making the small square photo -----

const loaded = (img) => (typeof img.decode === 'function'
  ? img.decode()
  : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; }));

// An <img> first: it reads every kind of picture this browser can show, and
// browsers turn a photo upright for an <img> by themselves (a phone stores
// which way up it was held beside the picture, not in it).
async function decode(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await loaded(img);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty');
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (first) {
    URL.revokeObjectURL(url);
    if (typeof createImageBitmap !== 'function') throw first;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
  }
}

function newCanvas(side) {
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  // A JPEG cannot be see-through: without this, clear areas would turn black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}
// Gives a canvas's memory back at once (it matters on a phone).
const free = (canvas) => { canvas.width = 0; canvas.height = 0; };
const toJpeg = (canvas, quality) => new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', quality); });

// `file` is what a file input gave. Resolves with a Blob: a JPEG, `size`
// pixels square, upright, cut from the middle of the picture. Rejects with an
// Error whose message can be shown as it is.
export async function squarePhoto(file, { size = PHOTO_SIZE } = {}) {
  let picture;
  try {
    picture = await decode(file);
  } catch {
    throw new Error(UNREADABLE);
  }
  let held = null;       // the canvas from the step before
  try {
    const side = Math.min(picture.width, picture.height);
    let from = picture.source;
    let x = Math.round((picture.width - side) / 2);
    let y = Math.round((picture.height - side) / 2);
    let span = side;
    // Shrink by halves until within twice the size wanted: one big step
    // leaves jagged edges and patterns.
    const step = (to) => {
      const next = newCanvas(to);
      next.ctx.drawImage(from, x, y, span, span, 0, 0, to, to);
      if (held) free(held);
      held = next.canvas;
      from = next.canvas;
      x = 0;
      y = 0;
      span = to;
    };
    while (span / 2 >= size) step(Math.ceil(span / 2));
    step(size);
    let blob = null;
    for (const quality of QUALITIES) {
      blob = await toJpeg(held, quality);
      // A browser that cannot make a JPEG quietly makes a PNG instead.
      if (!blob || blob.type !== 'image/jpeg') throw new Error('no jpeg');
      if (blob.size <= SMALL_ENOUGH) break;
    }
    return blob;
  } catch {
    throw new Error(UNUSABLE);
  } finally {
    if (held) free(held);
    picture.release();
  }
}

// ----- Fetching a photo once, and keeping it -----

// How to ask the server for a photo: with the page's link secret, and without
// the browser's own cache (each request it would make to check its copy is a
// request the host can see).
export function photoFetcher(pathFor, token) {
  return (key) => fetch(pathFor(key), {
    headers: { Authorization: `Bearer ${typeof token === 'function' ? token() : token}` },
    cache: 'no-store',
  });
}

// If a photo cannot be fetched (the connection dropped, the server was being
// restarted), try again after these waits and then leave it until the page is
// reloaded or the photo changes. These are set off by the clock alone, never
// by a knock or a visit.
export const RETRY_AFTER = Object.freeze([60_000, 5 * 60_000, 30 * 60_000]);

// `deps` lets test/photo.test.js run this without a browser.
export function createPhotoCache(deps = {}) {
  const makeUrl = deps.makeUrl || ((blob) => URL.createObjectURL(blob));
  const dropUrl = deps.dropUrl || ((url) => URL.revokeObjectURL(url));
  const later = deps.later || ((fn, ms) => setTimeout(fn, ms));
  const retryAfter = deps.retryAfter || RETRY_AFTER;
  const held = new Map();     // key -> { etag, url, loading }

  function forgetPhoto(key) {
    const entry = held.get(key);
    if (!entry) return;
    held.delete(key);
    if (entry.url) dropUrl(entry.url);
  }

  async function load(key, entry, fetcher) {
    const current = () => held.get(key) === entry;
    for (let tries = 0; ; tries += 1) {
      let again = true;
      try {
        const res = await fetcher(key, entry.etag);
        if (!current()) return null;      // replaced or removed while we asked
        if (res.ok) {
          const blob = await res.blob();
          if (!current()) return null;
          if (blob.type === 'image/jpeg') {
            entry.url = makeUrl(blob);
            return entry.url;
          }
          again = false;
        } else {
          // "No photo" or "this link does not work" will not change by asking again.
          again = res.status >= 500 || res.status === 408 || res.status === 429;
        }
      } catch { /* no answer at all: try later */ }
      if (!current()) return null;
      if (!again || tries >= retryAfter.length) return null;
      await new Promise((resolve) => { later(resolve, retryAfter[tries]); });
      if (!current()) return null;
    }
  }

  // The photo for `key` (a visitor's id) in the version `etag`, as a blob:
  // address an <img> can show; null when there is no photo or it could not be
  // fetched. Asks `fetcher(key, etag)` only when the tag is new to it. The
  // same tag again, however often, waits for or returns what it has. A photo
  // that was replaced or removed is let go of at once.
  async function getPhotoUrl(key, etag, fetcher) {
    if (!etag) {
      forgetPhoto(key);
      return null;
    }
    let entry = held.get(key);
    if (!entry || entry.etag !== etag) {
      forgetPhoto(key);
      entry = { etag, url: null, loading: null };
      held.set(key, entry);
      entry.loading = load(key, entry, fetcher).catch(() => null);
    }
    return entry.url || entry.loading;
  }

  // What is in memory right now, or null. Never asks the server.
  const cachedPhotoUrl = (key) => held.get(key)?.url || null;

  // Lets go of every photo but those of `keys` (the visitors there are now).
  function keepOnlyPhotos(keys) {
    const wanted = new Set(keys);
    for (const key of [...held.keys()]) if (!wanted.has(key)) forgetPhoto(key);
  }

  return { getPhotoUrl, cachedPhotoUrl, forgetPhoto, keepOnlyPhotos };
}

// The one for this page.
export const photoCache = createPhotoCache();
export const { getPhotoUrl, cachedPhotoUrl, forgetPhoto, keepOnlyPhotos } = photoCache;

// ----- Showing it -----

// Shows a person in a round "avatar" element: their initials, and over them
// their photo when `url` is given. If the picture cannot be drawn, the
// initials are simply left showing. The name is always written beside an
// avatar, so the picture has no text of its own (alt="").
// Called again with the same things, it leaves the element alone, so a photo
// does not flicker each time a list is drawn again.
export function showFace(node, text, url) {
  if (!node) return;
  const wanted = url || '';
  if (node.dataset.photo === wanted && node.dataset.text === text) return;
  node.dataset.photo = wanted;
  node.dataset.text = text;
  node.replaceChildren(...(text ? [text] : []));
  if (!url) return;
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('error', () => img.remove());
  img.src = url;
  node.append(img);
}

// One avatar element for each person in a list, kept from one drawing of the
// list to the next.
export function createFaces(className = 'avatar') {
  const nodes = new Map();
  return {
    of(key, text, url) {
      let node = nodes.get(key);
      if (!node) {
        node = document.createElement('div');
        node.className = className;
        nodes.set(key, node);
      }
      showFace(node, text, url);
      return node;
    },
    keepOnly(keys) {
      const wanted = new Set(keys);
      for (const key of [...nodes.keys()]) if (!wanted.has(key)) nodes.delete(key);
    },
  };
}
