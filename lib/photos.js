// Where visitors' photos are kept: one small file for each visitor, in a
// folder next to the data file (<folder>/<home id>/<visitor id>.jpg). A new
// photo replaces the old one; there is no history. Nothing here is logged.
//
// Two kinds of keeper with the same four functions, so tests (and a store
// made with ':memory:') never write to the disk:
//   put(homeId, visitorId, bytes), get(homeId, visitorId) -> Buffer or null,
//   remove(homeId, visitorId), removeHome(homeId)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// File names are made only from ids we made ourselves (lib/tokens.js newId).
const ID = /^[A-Za-z0-9_-]{8,32}$/;
export const validId = (id) => typeof id === 'string' && ID.test(id);

// Is `target` inside the folder `root`? (Never the folder itself.)
const inside = (root, target) => target.startsWith(root + path.sep);

// The file for one visitor's photo, or null if either id is not one of ours
// or the path would leave the folder.
export function photoPath(folder, homeId, visitorId) {
  if (!validId(homeId) || !validId(visitorId)) return null;
  const root = path.resolve(folder);
  const file = path.resolve(root, homeId, `${visitorId}.jpg`);
  return inside(root, file) ? file : null;
}

export function photosInFolder(folder) {
  const root = path.resolve(folder);
  const homeFolder = (homeId) => {
    if (!validId(homeId)) return null;
    const dir = path.resolve(root, homeId);
    return inside(root, dir) ? dir : null;
  };
  return {
    put(homeId, visitorId, bytes) {
      const file = photoPath(root, homeId, visitorId);
      if (!file || !Buffer.isBuffer(bytes)) throw new Error('This photo cannot be kept.');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // Written under another name first, then put in place in one step, so
      // a crash never leaves half a picture (as lib/store.js does).
      const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, bytes, { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    },
    get(homeId, visitorId) {
      const file = photoPath(root, homeId, visitorId);
      if (!file) return null;
      try { return fs.readFileSync(file); } catch { return null; }
    },
    remove(homeId, visitorId) {
      const file = photoPath(root, homeId, visitorId);
      if (file) fs.rmSync(file, { force: true });
    },
    removeHome(homeId) {
      const dir = homeFolder(homeId);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function photosInMemory() {
  const kept = new Map();     // "<home id>/<visitor id>" -> Buffer
  const key = (homeId, visitorId) => (validId(homeId) && validId(visitorId) ? `${homeId}/${visitorId}` : null);
  return {
    put(homeId, visitorId, bytes) {
      const k = key(homeId, visitorId);
      if (!k || !Buffer.isBuffer(bytes)) throw new Error('This photo cannot be kept.');
      kept.set(k, Buffer.from(bytes));
    },
    get(homeId, visitorId) {
      const found = kept.get(key(homeId, visitorId));
      return found ? Buffer.from(found) : null;
    },
    remove(homeId, visitorId) { kept.delete(key(homeId, visitorId)); },
    removeHome(homeId) {
      for (const k of [...kept.keys()]) if (k.startsWith(`${homeId}/`)) kept.delete(k);
    },
    get size() { return kept.size; },
  };
}
