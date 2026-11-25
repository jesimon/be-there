// Visitors' photos: is this file a plain, small JPEG, and a strict rebuild of
// it that keeps the picture and nothing else. Pure functions: no I/O.
//
// A photo reaches the server from the organizer's browser, which has already
// turned it upright, cut it square and shrunk it (public/js/photo.js). The
// server still trusts none of it. It reads the file's structure (ITU-T T.81,
// Annex B), refuses anything it does not expect, and then writes the file out
// again itself:
//   - a fixed JFIF header of our own first, never bytes from the upload;
//   - then only the tables, the frame and the scans, in their order;
//   - no EXIF (where and when it was taken, on what), no colour profile, no
//     comments, no other application data, nothing after the end marker.
//
// What this cannot do: it does not decode the picture. A file that passes may
// still be damaged inside and draw as nothing, or as a blank picture (the
// home screen keeps the initials underneath, and the name beside it), and
// bytes hidden inside the compressed picture data cannot be seen. So the
// limits on pixels and bytes below matter, and the server always sends a
// photo as image/jpeg, as a download, to signed-in pages only (server.js).
import crypto from 'node:crypto';

const SOI = 0xd8, EOI = 0xd9, SOS = 0xda, DQT = 0xdb, DHT = 0xc4, DRI = 0xdd;
const APP1 = 0xe1, APP14 = 0xee;
const FRAMES = new Set([0xc0, 0xc1, 0xc2]);     // baseline, extended, progressive (all Huffman-coded)
// Lossless, hierarchical and arithmetic-coded pictures, and the markers that
// go with them: browsers do not draw these, so we do not keep them.
const OTHER_CODING = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xdc, 0xde, 0xdf]);
const isRestart = (marker) => marker >= 0xd0 && marker <= 0xd7;
const startsWith = (buf, at, end, text) => end - at >= text.length && buf.toString('latin1', at, at + text.length) === text;

// A quantization segment may hold at most this many tables (a picture uses at
// most four in all). Without it, a first segment could be padded out to any
// length an attacker likes.
export const MAX_TABLES_PER_SEGMENT = 4;

export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 512 * 1024, maxDim: 1024, maxScans: 32 });
// What a visitor's photo may be: square, 96 to 512 pixels a side, 200 KB.
export const PHOTO_LIMITS = Object.freeze({ maxBytes: 200 * 1024, maxDim: 512, minDim: 96, maxScans: 16 });

// What every file we keep starts with: the start marker, then a 16-byte JFIF
// header (version 1.01, square pixels, no thumbnail).
export const JFIF_START = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');

// Goes through the file once. Returns { ok: false, reason } or the facts and
// the list of segments, each { marker, from, to }: from..to runs from the
// segment's length field to its end, and for a scan it includes the
// compressed picture data that follows.
function walk(buf, limits) {
  const { maxBytes, maxDim, maxScans } = { ...DEFAULT_LIMITS, ...limits };
  const fail = (reason) => ({ ok: false, reason, width: 0, height: 0 });
  if (!Buffer.isBuffer(buf)) return fail('not_a_buffer');
  if (buf.length > maxBytes) return fail('too_large');
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) return fail('not_jpeg');

  const len = buf.length;
  const segments = [];
  let pos = 2;
  let frame = null;
  let scans = 0;
  let orientation = 1;
  // The tables given so far, by number: a frame or a scan that names one
  // which was never given cannot be drawn by anything.
  const given = { quantization: new Set(), dc: new Set(), ac: new Set() };

  for (;;) {
    // Every segment starts with FF; extra FF "fill bytes" may come before it.
    if (pos >= len) return fail('truncated');
    if (buf[pos] !== 0xff) return fail('garbage_between_segments');
    while (pos < len && buf[pos] === 0xff) pos += 1;
    if (pos >= len) return fail('truncated');
    const marker = buf[pos];
    pos += 1;

    if (marker === EOI) break;
    if (marker === SOI) return fail('second_image');       // a second picture, joined on or nested
    // FF00 and restart markers belong inside a scan only; 01 to BF are not ours to read.
    if (marker < 0xc0 || isRestart(marker)) return fail('bad_marker');
    if (OTHER_CODING.has(marker) || (marker >= 0xf0 && marker <= 0xfd)) return fail('unsupported_coding');
    if (pos + 2 > len) return fail('truncated');
    const size = buf.readUInt16BE(pos);                    // counts its own two bytes
    if (size < 2) return fail('bad_length');
    if (pos + size > len) return fail('truncated');
    const from = pos;
    const body = pos + 2;
    let to = pos + size;

    if (FRAMES.has(marker)) {
      if (frame) return fail('second_frame');
      if (size < 11) return fail('bad_frame');
      const precision = buf[body];
      const height = buf.readUInt16BE(body + 1);
      const width = buf.readUInt16BE(body + 3);
      const components = buf[body + 5];
      if (size !== 8 + 3 * components) return fail('bad_frame');
      if (precision !== 8) return fail('unsupported_precision');
      if (components !== 1 && components !== 3) return fail('unsupported_components');   // no CMYK
      if (!width || !height) return fail('bad_dimensions');   // height 0 means "told later": refuse
      // The real guard against a small file that unpacks into a huge picture.
      if (width > maxDim || height > maxDim) return fail('too_many_pixels');
      const parts = new Map();      // each part's number -> its quantization table, and its blocks in one unit of a scan
      for (let c = 0; c < components; c += 1) {
        const sampling = buf[body + 7 + 3 * c];
        const h = sampling >> 4;
        const v = sampling & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4 || buf[body + 8 + 3 * c] > 3) return fail('bad_frame');
        parts.set(buf[body + 6 + 3 * c], { table: buf[body + 8 + 3 * c], blocks: h * v });
      }
      if (parts.size !== components) return fail('bad_frame');   // two parts with one number
      frame = { width, height, components, progressive: marker === 0xc2, parts };
    } else if (marker === DQT) {
      // One or more tables: a byte (precision, id), then 64 values of one or
      // two bytes. They must fill the segment exactly.
      if (size === 2) return fail('bad_table');
      let tables = 0;
      for (let p = body; p < to;) {
        const wide = buf[p] >> 4;
        const id = buf[p] & 15;
        if (wide > 1 || id > 3) return fail('bad_table');
        p += 1 + 64 * (wide + 1);
        if (p > to) return fail('bad_table');
        given.quantization.add(id);
        tables += 1;
      }
      if (tables > MAX_TABLES_PER_SEGMENT) return fail('too_many_tables');
    } else if (marker === DHT) {
      // One or more tables: a byte (class, id), 16 counts, then that many symbols.
      if (size === 2) return fail('bad_table');
      for (let p = body; p < to;) {
        if (p + 17 > to || (buf[p] >> 4) > 1 || (buf[p] & 15) > 3) return fail('bad_table');
        const kind = buf[p] >> 4 ? given.ac : given.dc;
        const id = buf[p] & 15;
        let symbols = 0;
        for (let k = 1; k <= 16; k += 1) symbols += buf[p + k];
        p += 17 + symbols;
        if (symbols > 256 || p > to) return fail('bad_table');
        kind.add(id);
      }
    } else if (marker === DRI) {
      if (size !== 4) return fail('bad_table');
    } else if (marker === APP14 && startsWith(buf, body, to, 'Adobe')) {
      // Adobe's marker says how the colours are stored. We never keep it, and
      // leaving it out could change the colours, so such a file is refused.
      // The organizer's page never makes one.
      return fail('adobe_marker');
    } else if (marker === APP1 && startsWith(buf, body, to, 'Exif\0\0')) {
      // Read only which way up the picture is; the first block that says
      // "not upright" counts.
      if (orientation === 1) orientation = exifOrientation(buf.subarray(body + 6, to));
    } else if (marker === SOS) {
      if (!frame) return fail('scan_before_frame');
      const parts = buf[body];
      if (size < 8 || parts < 1 || parts > frame.components || size !== 6 + 2 * parts) return fail('bad_scan');
      // Which tables this scan needs. A progressive picture comes in passes:
      // one kind reads only the first value of each block (and, when it is
      // refining an earlier pass, uses no table at all), the other only the rest.
      const first = buf[body + 1 + 2 * parts] === 0;
      const refining = (buf[body + 3 + 2 * parts] >> 4) !== 0;
      const needsDc = frame.progressive ? first && !refining : true;
      const needsAc = frame.progressive ? !first : true;
      let blocks = 0;
      for (let c = 0; c < parts; c += 1) {
        const tables = buf[body + 2 + 2 * c];
        if ((tables >> 4) > 3 || (tables & 15) > 3) return fail('bad_scan');
        const part = frame.parts.get(buf[body + 1 + 2 * c]);
        if (!part) return fail('bad_scan');                 // a part the frame does not have
        if (!given.quantization.has(part.table)) return fail('missing_tables');
        if ((needsDc && !given.dc.has(tables >> 4)) || (needsAc && !given.ac.has(tables & 15))) return fail('missing_tables');
        blocks += part.blocks;
      }
      // Parts scanned together may not make a unit of more than ten blocks.
      if (parts > 1 && blocks > 10) return fail('bad_scan');
      scans += 1;
      if (scans > maxScans) return fail('too_many_scans');
      // The compressed picture data runs to the next real marker. FF00 is a
      // data byte and FFD0 to FFD7 are restart markers: both belong to the scan.
      let p = to;
      for (;;) {
        const i = buf.indexOf(0xff, p);
        if (i < 0) return fail('truncated');
        let j = i + 1;
        while (j < len && buf[j] === 0xff) j += 1;
        if (j >= len) return fail('truncated');
        const next = buf[j];
        if (next === 0x00) {
          if (j !== i + 1) return fail('bad_stuffing');     // FF FF 00: decoders disagree about it
          p = j + 1;
        } else if (isRestart(next)) {
          p = j + 1;
        } else {
          to = i;                                           // a real marker: the scan ends here
          break;
        }
      }
    }
    // Anything else here is application data or a comment: read past, never kept.
    segments.push({ marker, from, to });
    pos = to;
  }

  if (!frame) return fail('no_frame');
  if (!scans) return fail('no_scan');
  const { width, height, components, progressive } = frame;
  return { ok: true, reason: '', width, height, components, progressive, scans, orientation, trailingBytes: len - pos, segments };
}

// EXIF "Orientation" (tag 0x0112 in the first directory of a TIFF block):
// 1 to 8, or 1 when it is absent or cannot be read.
function exifOrientation(tiff) {
  try {
    const order = tiff.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return 1;
    const little = order === 'II';
    const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
    const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
    if (u16(2) !== 42) return 1;
    const directory = u32(4);
    const count = u16(directory);
    for (let n = 0; n < count; n += 1) {
      const entry = directory + 2 + 12 * n;
      if (u16(entry) !== 0x0112) continue;
      const value = u16(entry + 2) === 4 ? u32(entry + 8) : u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  } catch { /* it points outside the block: as good as absent */ }
  return 1;
}

// What the file is, from its structure alone:
//   { ok: true, reason: '', width, height, components (1 or 3), progressive,
//     scans, orientation (1 to 8; 1 when there is no EXIF), trailingBytes }
//   { ok: false, reason, width: 0, height: 0 }
// Never throws.
export function inspectJpeg(buffer, limits) {
  const { segments, ...facts } = walk(buffer, limits);
  return facts;
}

// The strict rebuild: our own JFIF header, then the tables, frame and scans of
// `buffer` byte for byte, then the end marker. Everything else is left out.
// Rebuilding a rebuilt file gives the same bytes again. Throws a TypeError
// (with `.reason`) for a file inspectJpeg() refuses.
export function rebuildJpeg(buffer, limits) {
  const found = walk(buffer, limits);
  if (!found.ok) throw Object.assign(new TypeError(`not a usable JPEG: ${found.reason}`), { reason: found.reason });
  const out = [JFIF_START];
  for (const { marker, from, to } of found.segments) {
    const kept = FRAMES.has(marker) || marker === DQT || marker === DHT || marker === DRI || marker === SOS;
    if (kept) out.push(Buffer.from([0xff, marker]), buffer.subarray(from, to));
  }
  out.push(Buffer.from([0xff, EOI]));
  return Buffer.concat(out);
}

// The rules for a visitor's photo, applied to what was uploaded:
//   { ok: true, bytes (what to keep), etag } or { ok: false, reason }
// Never throws.
export function acceptPhoto(buffer) {
  const refuse = (reason) => ({ ok: false, reason });
  try {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return refuse('not_jpeg');
    const found = inspectJpeg(buffer, PHOTO_LIMITS);
    if (!found.ok) return refuse(found.reason);
    if (found.width !== found.height) return refuse('not_square');
    if (found.width < PHOTO_LIMITS.minDim) return refuse('too_small');
    // With the EXIF gone, a picture that relied on it would lie on its side.
    if (found.orientation !== 1) return refuse('not_upright');
    const bytes = rebuildJpeg(buffer, PHOTO_LIMITS);
    // What we keep must itself pass, and be the same picture.
    const kept = inspectJpeg(bytes, PHOTO_LIMITS);
    if (!kept.ok) return refuse(kept.reason);
    const same = kept.width === found.width && kept.height === found.height && kept.components === found.components
      && kept.progressive === found.progressive && kept.scans === found.scans && kept.orientation === 1 && kept.trailingBytes === 0;
    if (!same) return refuse('rebuild_failed');
    // The tag pages use to tell one version of a photo from the next.
    const etag = crypto.createHash('sha256').update(bytes).digest('base64url').slice(0, 22);
    return { ok: true, bytes, etag };
  } catch {
    return refuse('rebuild_failed');
  }
}
