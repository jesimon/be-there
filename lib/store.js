// Storage: one JSON file (data/db.json, or DATA_FILE). Writes go to a temporary
// file first, then replace the old one, so a crash never leaves half a file.
// Nothing about the visits themselves is stored: no video, no audio, no log of
// who visited when.
//
// Visitors' photos are files of their own in a "photos" folder beside the data
// file (lib/photos.js); a visitor's record holds only the photo's tag. A store
// kept in memory (':memory:', as the tests use) keeps the photos in memory too.
import fs from 'node:fs';
import path from 'node:path';
import { newId, newToken, hashToken, sameHash } from './tokens.js';
import { cleanName, cleanHours, validTimeZone, MODES } from './rules.js';
import { photosInFolder, photosInMemory } from './photos.js';

export function createStore(file = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'db.json'), { photos } = {}) {
  let db = { homes: [] };
  if (file !== ':memory:' && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pictures = photos || (file === ':memory:' ? photosInMemory() : photosInFolder(path.join(path.dirname(file), 'photos')));
  // Clearing a picture away must never stop a visitor or a home from being
  // removed: once its record is gone, the file is never served again.
  const quietly = (fn) => { try { fn(); } catch { /* the record is what counts */ } };
  const current = (home, visitorId) => home.visitors.find((x) => x.id === visitorId && !x.removed) || null;

  function save() {
    if (file === ':memory:') return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }

  const byHash = (field, token) => {
    if (!token) return null;
    const h = hashToken(token);
    return db.homes.find((home) => sameHash(home[field], h)) || null;
  };

  return {
    // Returns the home and its two secret links' tokens (shown once).
    createHome({ name, personName, timeZone, hours }) {
      const homeToken = newToken();
      const organizerToken = newToken();
      const home = {
        id: newId(),
        name: cleanName(name) || `${cleanName(personName) || 'Our'}’s home`,
        personName: cleanName(personName) || 'Grandma',
        timeZone: validTimeZone(timeZone) ? timeZone : 'UTC',
        hours: cleanHours(hours),
        paused: false,
        homeHash: hashToken(homeToken),
        organizerHash: hashToken(organizerToken),
        visitors: [],
        createdAt: new Date().toISOString(),
      };
      db.homes.push(home);
      save();
      return { home, homeToken, organizerToken };
    },

    homeByHomeToken: (token) => byHash('homeHash', token),
    homeByOrganizerToken: (token) => byHash('organizerHash', token),

    // Finds the home and visitor for a visitor's link.
    visitorByToken(token) {
      if (!token) return null;
      const h = hashToken(token);
      for (const home of db.homes) {
        const visitor = home.visitors.find((v) => !v.removed && sameHash(v.hash, h));
        if (visitor) return { home, visitor };
      }
      return null;
    },

    getHome: (id) => db.homes.find((h) => h.id === id) || null,

    // Organizers invite; the person at home must still approve.
    addVisitor(home, { name, relation }) {
      const token = newToken();
      const visitor = {
        id: newId(),
        name: cleanName(name) || 'A visitor',
        relation: cleanName(relation, 40),
        mode: 'knock',
        approved: false,
        hash: hashToken(token),
        createdAt: new Date().toISOString(),
      };
      home.visitors.push(visitor);
      save();
      return { visitor, token };
    },

    updateHome(home, changes) {
      if ('paused' in changes) home.paused = !!changes.paused;
      if ('hours' in changes) home.hours = cleanHours(changes.hours);
      if ('timeZone' in changes && validTimeZone(changes.timeZone)) home.timeZone = changes.timeZone;
      if ('name' in changes && cleanName(changes.name)) home.name = cleanName(changes.name);
      if ('personName' in changes && cleanName(changes.personName)) home.personName = cleanName(changes.personName);
      save();
      return home;
    },

    updateVisitor(home, visitorId, changes) {
      const v = home.visitors.find((x) => x.id === visitorId && !x.removed);
      if (!v) return null;
      if ('approved' in changes) v.approved = !!changes.approved;
      if ('mode' in changes && MODES.includes(changes.mode)) v.mode = changes.mode;
      save();
      return v;
    },

    // A visitor's photo: the picture itself goes to the photo folder, and its
    // tag (which changes when the picture does) onto the visitor's record. The
    // picture is written first, so a record never names one that is not there.
    setPhoto(home, visitorId, bytes, etag) {
      const v = current(home, visitorId);
      if (!v) return null;
      pictures.put(home.id, v.id, bytes);
      v.photo = { etag, updatedAt: new Date().toISOString() };
      save();
      return v;
    },

    // The picture for a visitor who has one, or null.
    photoBytes(home, visitorId) {
      const v = current(home, visitorId);
      return v?.photo ? pictures.get(home.id, v.id) : null;
    },

    // Returns the visitor (or null); the picture is gone for good.
    removePhoto(home, visitorId) {
      const v = current(home, visitorId);
      if (!v) return null;
      delete v.photo;
      save();
      quietly(() => pictures.remove(home.id, v.id));
      return v;
    },

    // Removing a visitor makes their link stop working for good, and removes
    // their photo.
    removeVisitor(home, visitorId) {
      const v = current(home, visitorId);
      if (!v) return null;
      v.removed = true;
      v.approved = false;
      v.hash = '';
      delete v.photo;
      save();
      quietly(() => pictures.remove(home.id, v.id));
      return v;
    },

    // A new organizer link; the old one stops working.
    resetOrganizerLink(home) {
      const token = newToken();
      home.organizerHash = hashToken(token);
      save();
      return token;
    },

    resetHomeLink(home) {
      const token = newToken();
      home.homeHash = hashToken(token);
      save();
      return token;
    },

    // Deletes the home, and every photo kept for it.
    deleteHome(home) {
      db.homes = db.homes.filter((h) => h !== home);
      save();
      quietly(() => pictures.removeHome(home.id));
    },
  };
}
