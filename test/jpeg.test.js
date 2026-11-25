// lib/jpeg.js: which files count as a visitor's photo, and what is kept of
// them. The pictures in test/fixtures/ are small drawings made by
// test/fixtures/make_fixtures.py (Pillow); canvas-384.jpg is what
// public/js/photo.js exported in Chromium 158 from sideways-320x240.jpg, so it
// is the kind of file the organizer's page really sends. None is a photograph.
// The bad files are built here, from those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { inspectJpeg, rebuildJpeg, acceptPhoto, PHOTO_LIMITS, DEFAULT_LIMITS, JFIF_START, MAX_TABLES_PER_SEGMENT } from '../lib/jpeg.js';

const fx = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const base = fx('baseline-256.jpg');
const progressive = fx('progressive-256.jpg');
const HONEST = ['baseline-256.jpg', 'progressive-256.jpg', 'grey-256.jpg', 'restart-256.jpg', 'metadata-256.jpg', 'canvas-384.jpg'];

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
const afterSoi = (buf, extra) => Buffer.concat([buf.subarray(0, 2), extra, buf.subarray(2)]);
const beforeEoi = (buf, extra) => Buffer.concat([buf.subarray(0, buf.length - 2), extra, EOI]);
const text = (s) => Buffer.from(s, 'latin1');

// The parts of a well-formed JPEG, read by a walker of the test's own:
// [{ marker, at, end }], where a scan's part includes its picture data.
function parts(b) {
  const out = [];
  let p = 2;
  for (;;) {
    assert.equal(b[p], 0xff, `a marker at byte ${p}`);
    while (b[p + 1] === 0xff) p += 1;
    const marker = b[p + 1];
    if (marker === 0xd9) { out.push({ marker, at: p, end: p + 2 }); return out; }
    let end = p + 2 + b.readUInt16BE(p + 2);
    if (marker === 0xda) {
      for (;;) {
        const i = b.indexOf(0xff, end);
        assert.ok(i >= 0, 'the picture data ends in a marker');
        let j = i + 1;
        while (b[j] === 0xff) j += 1;
        if (b[j] === 0 || (b[j] >= 0xd0 && b[j] <= 0xd7)) { end = j + 1; continue; }
        end = i;
        break;
      }
    }
    out.push({ marker, at: p, end });
    p = end;
  }
}
const markersOf = (b) => parts(b).map((s) => s.marker.toString(16)).join(' ');
const part = (b, marker, nth = 0) => parts(b).filter((s) => s.marker === marker)[nth];
const sof = part(base, 0xc0).at;        // FF C0, length (2), precision, height (2), width (2), components
const patched = (fn, from = base) => { const b = Buffer.from(from); fn(b); return b; };
const sized = (w, h, from = base) => patched((b) => { const at = part(b, from === progressive ? 0xc2 : 0xc0).at; b.writeUInt16BE(h, at + 5); b.writeUInt16BE(w, at + 7); }, from);
const refused = (buf, reason, name) => {
  assert.deepEqual(acceptPhoto(buf), { ok: false, reason }, name);
};
// Refused by the structure check itself, so by all three functions alike.
const malformed = (buf, reason, name) => {
  const found = inspectJpeg(buf, PHOTO_LIMITS);
  assert.deepEqual(found, { ok: false, reason, width: 0, height: 0 }, name);
  assert.throws(() => rebuildJpeg(buf, PHOTO_LIMITS), (err) => err instanceof TypeError && err.reason === reason, name);
  refused(buf, reason, name);
};

// An EXIF block that says which way up the picture is, and nothing else.
function exif(orientation, { little = true, long = false, entriesBefore = 0 } = {}) {
  const u16 = (n) => { const b = Buffer.alloc(2); if (little) b.writeUInt16LE(n); else b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); if (little) b.writeUInt32LE(n); else b.writeUInt32BE(n); return b; };
  const entry = (tag, type, value) => Buffer.concat([u16(tag), u16(type), u32(1), type === 4 ? u32(value) : Buffer.concat([u16(value), u16(0)])]);
  const others = Array.from({ length: entriesBefore }, (_, n) => entry(0x0100 + (n % 16), 3, 1));
  const tiff = Buffer.concat([text(little ? 'II' : 'MM'), u16(42), u32(8), u16(others.length + 1), ...others, entry(0x0112, long ? 4 : 3, orientation), u32(0)]);
  return seg(0xe1, Buffer.concat([text('Exif\0\0'), tiff]));
}

test('the limits for a visitor’s photo are the ones decided', () => {
  assert.deepEqual({ ...PHOTO_LIMITS }, { maxBytes: 200 * 1024, maxDim: 512, minDim: 96, maxScans: 16 });
  assert.equal(MAX_TABLES_PER_SEGMENT, 4);
  assert.equal(JFIF_START.toString('hex'), 'ffd8ffe000104a46494600010100000100010000');
  assert.ok(Object.isFrozen(PHOTO_LIMITS) && Object.isFrozen(DEFAULT_LIMITS));
});

test('honest pictures pass, and come out with our own header and nothing but the picture', () => {
  const facts = {
    'baseline-256.jpg': [256, 3, false, 1],
    'progressive-256.jpg': [256, 3, true, 10],
    'grey-256.jpg': [256, 1, false, 1],
    'restart-256.jpg': [256, 3, false, 1],
    'metadata-256.jpg': [256, 3, false, 1],
    'canvas-384.jpg': [384, 3, false, 1],
  };
  for (const name of HONEST) {
    const src = fx(name);
    const [side, components, isProgressive, scans] = facts[name];
    const found = inspectJpeg(src, PHOTO_LIMITS);
    assert.deepEqual(found, { ok: true, reason: '', width: side, height: side, components, progressive: isProgressive, scans, orientation: 1, trailingBytes: 0 }, name);

    const got = acceptPhoto(src);
    assert.equal(got.ok, true, name);
    assert.deepEqual(Object.keys(got).sort(), ['bytes', 'etag', 'ok'], name);
    const kept = got.bytes;
    assert.ok(kept.subarray(0, 20).equals(JFIF_START), `${name}: starts with the fixed header`);
    assert.ok(kept.subarray(-2).equals(EOI), `${name}: ends at the end marker`);
    // After the one JFIF header: only tables, the frame, restart interval and scans.
    const markers = parts(kept).map((s) => s.marker);
    assert.equal(markers[0], 0xe0, name);
    for (const marker of markers.slice(1)) assert.ok([0xdb, 0xc4, 0xdd, 0xc0, 0xc1, 0xc2, 0xda, 0xd9].includes(marker), `${name}: ${marker.toString(16)} was kept`);
    for (const dropped of [0xe1, 0xe2, 0xed, 0xee, 0xfe]) assert.ok(!markers.includes(dropped), `${name}: no ${dropped.toString(16)} segment`);
    // The picture's own parts are there byte for byte, in their order.
    const picture = (b) => Buffer.concat(parts(b).filter((s) => [0xdb, 0xc4, 0xdd, 0xc0, 0xc1, 0xc2, 0xda].includes(s.marker)).map((s) => b.subarray(s.at, s.end)));
    assert.ok(picture(kept).equals(picture(src)), `${name}: tables, frame and scans unchanged`);
    assert.equal(kept.length, 20 + picture(src).length + 2, name);
    assert.deepEqual(inspectJpeg(kept, PHOTO_LIMITS), found, `${name}: the same picture`);
    // The tag is the start of the SHA-256 of exactly what is kept.
    assert.equal(got.etag, crypto.createHash('sha256').update(kept).digest('base64url').slice(0, 22), name);
    assert.match(got.etag, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(rebuildJpeg(src, PHOTO_LIMITS).equals(kept), name);
  }
});

test('where and when a photo was taken, the camera, the colour profile and comments are all removed', () => {
  const src = fx('metadata-256.jpg');
  const words = ['SENTINEL-GPS-METHOD', 'SENTINEL-MAKE', 'SENTINEL-MODEL', 'SENTINEL-COMMENT', 'SENTINEL-XMP', 'SENTINEL-IPTC', 'Exif', 'ICC_PROFILE', 'xmpmeta', 'Photoshop', '2026:11:25', 'Example Road'];
  for (const word of words) assert.ok(src.includes(word), `the fixture has ${word}`);
  assert.equal(markersOf(src), 'e1 ed e0 e1 e2 fe db db c0 c4 c4 c4 c4 da d9');
  const { bytes } = acceptPhoto(src);
  for (const word of [...words, 'SENTINEL']) assert.ok(!bytes.includes(word), `${word} is gone`);
  assert.equal(markersOf(bytes), 'e0 db db c0 c4 c4 c4 c4 da d9');
  // It is the same drawing as baseline-256.jpg, saved the same way: with
  // everything else gone, the two are the same file.
  assert.ok(bytes.equals(acceptPhoto(base).bytes));

  // What a browser's canvas writes: a JFIF header and a colour profile. The profile goes.
  const canvas = fx('canvas-384.jpg');
  assert.equal(markersOf(canvas), 'e0 e2 db db c0 c4 c4 c4 c4 da d9');
  const kept = acceptPhoto(canvas).bytes;
  assert.equal(markersOf(kept), 'e0 db db c0 c4 c4 c4 c4 da d9');
  const profile = part(canvas, 0xe2);
  assert.equal(kept.length, canvas.length - (profile.end - profile.at));
});

test('rebuilding is idempotent, and never copies a header from the upload', () => {
  for (const name of [...HONEST, 'orientation-6-256.jpg', 'sideways-320x240.jpg']) {
    const once = rebuildJpeg(fx(name));
    assert.ok(rebuildJpeg(once).equals(once), name);
    assert.ok(rebuildJpeg(rebuildJpeg(once)).equals(once), name);
  }
  // A JFIF header with other numbers in it, a thumbnail, and a second one:
  // none of its bytes is kept.
  const jfif = seg(0xe0, Buffer.concat([text('JFIF\0'), Buffer.from([9, 9, 2, 0x12, 0x34, 0x56, 0x78, 2, 1]), text('THUMB!')]));
  const jfxx = seg(0xe0, text('JFXX\0\x10 a second header'));
  const odd = Buffer.concat([SOI, jfif, jfxx, base.subarray(20)]);
  const { bytes } = acceptPhoto(odd);
  assert.ok(bytes.equals(acceptPhoto(base).bytes));
  assert.ok(!bytes.includes('THUMB!') && !bytes.includes('JFXX'));
  // No header at all: ours is still written first.
  assert.ok(acceptPhoto(Buffer.concat([SOI, base.subarray(20)])).bytes.equals(bytes));
});

test('refused: files that are not one whole, plain JPEG', () => {
  const sos = part(base, 0xda).at;
  const dqt = part(base, 0xdb).at;
  const dht = part(base, 0xc4).at;
  const frame = base.subarray(sof, part(base, 0xc0).end);
  const fourParts = seg(0xc0, Buffer.from([8, 1, 0, 1, 0, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]));
  const stuffed = (() => { const i = base.indexOf(Buffer.from([0xff, 0x00]), sos); assert.ok(i > 0); return Buffer.concat([base.subarray(0, i), Buffer.from([0xff]), base.subarray(i)]); })();
  const cases = {
    'a PNG': [Buffer.from('89504e470d0a1a0a0000000d4948445200000100000001000802000000d3103f31', 'hex'), 'not_jpeg'],
    'a GIF': [text('GIF89a\x00\x01\x00\x01\x80\x00\x00\xff\xff\xff\x00\x00\x00;'), 'not_jpeg'],
    'a HEIC header': [Buffer.concat([Buffer.from([0, 0, 0, 0x18]), text('ftypheic\0\0\0\0mif1heic')]), 'not_jpeg'],
    'a web page': [text('<!doctype html><script>alert(1)</script>'), 'not_jpeg'],
    'the start marker alone': [SOI, 'not_jpeg'],
    'three bytes': [Buffer.from([0xff, 0xd8, 0xff]), 'not_jpeg'],
    'start and end with nothing between': [Buffer.concat([SOI, EOI]), 'no_frame'],
    'a second start marker': [afterSoi(base, SOI), 'second_image'],
    'a second picture joined on inside': [Buffer.concat([base.subarray(0, base.length - 2), base]), 'second_image'],
    'garbage between segments': [afterSoi(base, text('junk')), 'garbage_between_segments'],
    'a zero byte between segments': [afterSoi(base, Buffer.from([0x00])), 'garbage_between_segments'],
    'FF00 between segments': [afterSoi(base, Buffer.from([0xff, 0x00])), 'bad_marker'],
    'a restart marker outside the picture data': [afterSoi(base, Buffer.from([0xff, 0xd0])), 'bad_marker'],
    'a reserved marker': [afterSoi(base, Buffer.from([0xff, 0x4f, 0, 2])), 'bad_marker'],
    'a segment of length 0': [patched((b) => b.writeUInt16BE(0, dqt + 2)), 'bad_length'],
    'a segment of length 1': [patched((b) => b.writeUInt16BE(1, dqt + 2)), 'bad_length'],
    'a segment longer than the file': [patched((b) => b.writeUInt16BE(0xffff, dqt + 2)), 'truncated'],
    'no end marker': [base.subarray(0, base.length - 2), 'truncated'],
    'ends on FF': [base.subarray(0, base.length - 1), 'truncated'],
    'cut off in the picture data': [base.subarray(0, sos + 300), 'truncated'],
    '12 bits a sample': [patched((b) => { b[sof + 4] = 12; }), 'unsupported_precision'],
    '4 components (CMYK)': [Buffer.concat([base.subarray(0, sof), fourParts, base.subarray(part(base, 0xc0).end)]), 'unsupported_components'],
    '2 components': [Buffer.concat([base.subarray(0, sof), seg(0xc0, Buffer.from([8, 1, 0, 1, 0, 2, 1, 0x11, 0, 2, 0x11, 0])), base.subarray(part(base, 0xc0).end)]), 'unsupported_components'],
    'a frame whose length disagrees with its components': [patched((b) => { b[sof + 9] = 4; }), 'bad_frame'],
    'a sampling factor of 0': [patched((b) => { b[sof + 11] = 0x01; }), 'bad_frame'],
    'a frame naming quantization table 4': [patched((b) => { b[sof + 12] = 4; }), 'bad_frame'],
    'height 0 (“told later”)': [patched((b) => b.writeUInt16BE(0, sof + 5)), 'bad_dimensions'],
    'width 0': [patched((b) => b.writeUInt16BE(0, sof + 7)), 'bad_dimensions'],
    'two frames': [Buffer.concat([base.subarray(0, sos), frame, base.subarray(sos)]), 'second_frame'],
    'a scan before the frame': [Buffer.concat([base.subarray(0, sof), base.subarray(sos)]), 'scan_before_frame'],
    'a frame but no scan': [Buffer.concat([base.subarray(0, sos), EOI]), 'no_scan'],
    'no tables': [Buffer.concat([SOI, frame, base.subarray(sos)]), 'missing_tables'],
    'no Huffman tables': [Buffer.concat([base.subarray(0, dht), base.subarray(sos)]), 'missing_tables'],
    'a scan with more parts than the frame': [patched((b) => { b[sos + 4] = 4; }), 'bad_scan'],
    'a scan naming Huffman table 4': [patched((b) => { b[sos + 6] = 0x40; }), 'bad_scan'],
    // What a frame or a scan names must be there: no browser can draw these.
    'a frame naming a quantization table that is never given': [patched((b) => { b[sof + 12] = 3; }), 'missing_tables'],
    'a scan naming a Huffman table that is never given': [patched((b) => { b[sos + 6] = 0x03; }), 'missing_tables'],
    'a scan naming another Huffman table that is never given': [patched((b) => { b[sos + 8] = 0x31; }), 'missing_tables'],
    'only the first-value Huffman tables given': [Buffer.concat([base.subarray(0, part(base, 0xc4, 1).at), base.subarray(part(base, 0xc4, 2).at, part(base, 0xc4, 3).at), base.subarray(sos)]), 'missing_tables'],
    'tables given only after the scan that needs them': [Buffer.concat([base.subarray(0, dht), base.subarray(sos, base.length - 2), base.subarray(dht, sos), EOI]), 'missing_tables'],
    'a scan naming a part the frame does not have': [patched((b) => { b[sos + 5] = 9; }), 'bad_scan'],
    'two parts of the frame with one number': [patched((b) => { b[sof + 13] = b[sof + 10]; }), 'bad_frame'],
    'parts scanned together in units of more than ten blocks': [patched((b) => { for (let c = 0; c < 3; c += 1) b[sof + 11 + 3 * c] = 0x22; }), 'bad_scan'],
    'a progressive picture whose second pass has no table': [Buffer.concat([progressive.subarray(0, part(progressive, 0xc4, 2).at), progressive.subarray(part(progressive, 0xc4, 2).end)]), 'missing_tables'],
    'lossless (SOF3)': [patched((b) => { b[sof + 1] = 0xc3; }), 'unsupported_coding'],
    'arithmetic coding (SOF9)': [patched((b) => { b[sof + 1] = 0xc9; }), 'unsupported_coding'],
    'arithmetic conditioning (DAC)': [afterSoi(base, seg(0xcc, Buffer.from([0, 0]))), 'unsupported_coding'],
    'a line count given later (DNL)': [beforeEoi(base, seg(0xdc, Buffer.from([1, 0]))), 'unsupported_coding'],
    'a JPEG extension marker': [afterSoi(base, seg(0xf7, Buffer.from([0, 0]))), 'unsupported_coding'],
    'a quantization table cut short': [patched((b) => b.writeUInt16BE(b.readUInt16BE(dqt + 2) - 1, dqt + 2)), 'bad_table'],
    'an empty quantization segment': [afterSoi(base, seg(0xdb, Buffer.alloc(0))), 'bad_table'],
    'quantization table 4': [afterSoi(base, seg(0xdb, Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]))), 'bad_table'],
    'a Huffman table of class 2': [afterSoi(base, seg(0xc4, Buffer.concat([Buffer.from([0x20]), Buffer.alloc(16)]))), 'bad_table'],
    'Huffman table 4': [afterSoi(base, seg(0xc4, Buffer.concat([Buffer.from([0x04]), Buffer.alloc(16)]))), 'bad_table'],
    'a Huffman table of 257 symbols': [afterSoi(base, seg(0xc4, Buffer.concat([Buffer.from([0x00, 255, 2]), Buffer.alloc(14), Buffer.alloc(257)]))), 'bad_table'],
    'a Huffman table longer than its segment': [afterSoi(base, seg(0xc4, Buffer.concat([Buffer.from([0x00, 9]), Buffer.alloc(15), Buffer.alloc(8)]))), 'bad_table'],
    'EXIF relabelled as a quantization table': [afterSoi(base, seg(0xdb, exif(1).subarray(4))), 'bad_table'],
    'EXIF relabelled as a Huffman table': [afterSoi(base, seg(0xc4, exif(1).subarray(4))), 'bad_table'],
    'a restart interval of the wrong length': [afterSoi(base, seg(0xdd, Buffer.from([0, 4, 0]))), 'bad_table'],
    'FF FF 00 in the picture data': [stuffed, 'bad_stuffing'],
  };
  for (const [name, [buf, reason]] of Object.entries(cases)) malformed(buf, reason, name);
  for (const nothing of [Buffer.alloc(0), undefined, null, 'ÿØÿÙ', 12, {}, [0xff, 0xd8], new Uint8Array(base)]) {
    refused(nothing, 'not_jpeg', `not a file at all: ${typeof nothing}`);
  }
  assert.equal(inspectJpeg('ÿØÿÙ').reason, 'not_a_buffer');
  assert.equal(inspectJpeg(undefined).reason, 'not_a_buffer');
});

test('refused: cut off anywhere at all', () => {
  for (const name of ['baseline-256.jpg', 'progressive-256.jpg', 'metadata-256.jpg']) {
    const whole = fx(name);
    for (let length = 0; length < whole.length; length += 1) {
      const got = acceptPhoto(whole.subarray(0, length));
      assert.equal(got.ok, false, `${name} cut to ${length} bytes`);
      assert.ok(['not_jpeg', 'truncated'].includes(got.reason), `${name} cut to ${length} bytes: ${got.reason}`);
    }
    assert.equal(acceptPhoto(whole).ok, true);
  }
});

test('only square pictures from 96 to 512 pixels a side', () => {
  for (const side of [96, 97, 256, 384, 511, 512]) assert.equal(acceptPhoto(sized(side, side)).ok, true, `${side} px`);
  refused(sized(95, 95), 'too_small', '95 px');
  refused(sized(1, 1), 'too_small', '1 px');
  malformed(sized(513, 513), 'too_many_pixels', '513 px');
  malformed(sized(65535, 65535), 'too_many_pixels', 'a small file that says it is huge');
  malformed(sized(513, 96), 'too_many_pixels', 'too wide');
  malformed(sized(96, 513), 'too_many_pixels', 'too tall');
  for (const [w, h] of [[256, 255], [255, 256], [320, 240], [96, 512], [512, 96]]) {
    assert.equal(inspectJpeg(sized(w, h), PHOTO_LIMITS).ok, true);
    refused(sized(w, h), 'not_square', `${w} x ${h}`);
  }
  refused(fx('sideways-320x240.jpg'), 'not_square', 'the sideways fixture');
  // The general check has roomier limits of its own; a photo uses the strict ones.
  assert.equal(inspectJpeg(sized(1024, 600)).ok, true);
  assert.equal(inspectJpeg(sized(1025, 600)).reason, 'too_many_pixels');
  assert.equal(inspectJpeg(sized(600, 1025)).reason, 'too_many_pixels');
  assert.equal(inspectJpeg(sized(4000, 4000), { maxDim: 4000 }).ok, true);
});

test('only pictures that are already upright: EXIF orientation absent or 1', () => {
  assert.equal(inspectJpeg(fx('orientation-6-256.jpg'), PHOTO_LIMITS).orientation, 6);
  assert.equal(inspectJpeg(fx('sideways-320x240.jpg'), PHOTO_LIMITS).orientation, 6);
  refused(fx('orientation-6-256.jpg'), 'not_upright', 'a real file with orientation 6');
  for (const little of [true, false]) {
    for (const long of [false, true]) {
      for (let o = 1; o <= 8; o += 1) {
        const buf = afterSoi(base, exif(o, { little, long }));
        assert.equal(inspectJpeg(buf, PHOTO_LIMITS).orientation, o, `orientation ${o}`);
        if (o === 1) {
          const got = acceptPhoto(buf);
          assert.equal(got.ok, true);
          assert.ok(!got.bytes.includes('Exif'));
        } else refused(buf, 'not_upright', `orientation ${o}, ${little ? 'II' : 'MM'}${long ? ', long' : ''}`);
      }
    }
  }
  // Wherever the tag sits among the others, and in whichever EXIF block.
  refused(afterSoi(base, exif(6, { entriesBefore: 200 })), 'not_upright', 'the 201st entry');
  refused(afterSoi(base, Buffer.concat([exif(1), exif(3)])), 'not_upright', 'a second EXIF block');
  refused(beforeEoi(base, exif(8)), 'not_upright', 'EXIF after the picture');
  // Not an orientation at all: taken as upright, and dropped with the rest.
  for (const odd of [0, 9, 255]) assert.equal(acceptPhoto(afterSoi(base, exif(odd))).ok, true, `orientation value ${odd}`);
  // A broken EXIF block is not a reason to refuse: it is thrown away anyway.
  for (const broken of [text('Exif\0\0'), text('Exif\0\0II*\0\xff\xff\xff\xff'), text('Exif\0\0MM\0*\0\0\0\x08\xff\xff'), text('Exif\0\0XX'), text('Exif')]) {
    const got = acceptPhoto(afterSoi(base, seg(0xe1, broken)));
    assert.equal(got.ok, true);
    assert.ok(got.bytes.equals(acceptPhoto(base).bytes));
  }
});

test('the tables a picture needs are checked pass by pass, as a decoder would use them', () => {
  // The drawing's own files: each needs tables in a different way, and all pass.
  for (const name of HONEST) assert.equal(inspectJpeg(fx(name), PHOTO_LIMITS).ok, true, name);
  // The made-up progressive picture has a pass that refines the first values
  // and comes with no table of its own (two scans in a row): that is allowed.
  assert.match(markersOf(progressive), /da da/);
  // Up to ten blocks in a unit is fine (nearly every photo is stored as 2x2 + 1 + 1, which is six).
  const sampled = (second, third) => patched((b) => { b[sof + 14] = second; b[sof + 17] = third; });
  assert.equal(inspectJpeg(sampled(0x31, 0x31), PHOTO_LIMITS).ok, true, '4 + 3 + 3 blocks');
  assert.equal(inspectJpeg(sampled(0x41, 0x31), PHOTO_LIMITS).reason, 'bad_scan', '4 + 4 + 3 blocks');
  // A part scanned by itself may be as large as it likes: greyscale at 4x4.
  const grey = fx('grey-256.jpg');
  assert.equal(inspectJpeg(patched((b) => { b[part(grey, 0xc0).at + 11] = 0x44; }, grey), PHOTO_LIMITS).ok, true);
  // In a progressive picture a pass names two tables but uses one of them, or
  // none: only the one it uses has to be there.
  const passes = parts(progressive).filter((s) => s.marker === 0xda).map((s) => {
    const count = progressive[s.at + 4];
    return { at: s.at, count, first: progressive[s.at + 5 + 2 * count] === 0, refining: (progressive[s.at + 7 + 2 * count] >> 4) !== 0 };
  });
  const firstValues = passes.find((pass) => pass.first && !pass.refining);
  const refinement = passes.find((pass) => pass.first && pass.refining);
  const rest = passes.find((pass) => !pass.first);
  assert.ok(firstValues && refinement && rest, 'the fixture has all three kinds of pass');
  const naming = (pass, change) => patched((b) => { for (let c = 0; c < pass.count; c += 1) b[pass.at + 6 + 2 * c] = change(b[pass.at + 6 + 2 * c]); }, progressive);
  const unusedFirst = (tables) => 0x30 | (tables & 15);      // table 3 for the first values: never given
  const unusedRest = (tables) => (tables & 0xf0) | 3;         // table 3 for the rest: never given
  assert.equal(inspectJpeg(naming(rest, unusedFirst), PHOTO_LIMITS).ok, true, 'a pass over the rest does not use a first-value table');
  assert.equal(inspectJpeg(naming(firstValues, unusedRest), PHOTO_LIMITS).ok, true, 'a pass over the first values does not use a table for the rest');
  assert.equal(inspectJpeg(naming(refinement, () => 0x33), PHOTO_LIMITS).ok, true, 'a refining pass over the first values uses no table');
  assert.equal(inspectJpeg(naming(firstValues, unusedFirst), PHOTO_LIMITS).reason, 'missing_tables');
  assert.equal(inspectJpeg(naming(rest, unusedRest), PHOTO_LIMITS).reason, 'missing_tables');
  // A table given again later, or one nothing uses, changes nothing.
  const spare = seg(0xc4, Buffer.concat([Buffer.from([0x13]), Buffer.alloc(16)]));
  assert.equal(acceptPhoto(afterSoi(base, spare)).ok, true);
  assert.equal(acceptPhoto(beforeEoi(base, base.subarray(part(base, 0xdb).at, part(base, 0xdb).end))).ok, true);
});

test('at most 16 scans', () => {
  const last = parts(progressive).filter((s) => s.marker === 0xda).at(-1);
  const scan = progressive.subarray(last.at, last.end);
  const withScans = (extra) => beforeEoi(progressive, Buffer.concat(Array.from({ length: extra }, () => scan)));
  assert.equal(inspectJpeg(progressive, PHOTO_LIMITS).scans, 10);
  assert.equal(inspectJpeg(withScans(6), PHOTO_LIMITS).scans, 16);
  assert.equal(acceptPhoto(withScans(6)).ok, true, '16 scans');
  malformed(withScans(7), 'too_many_scans', '17 scans');
  malformed(withScans(200), 'too_many_scans', '210 scans');
});

test('at most 200 KB', () => {
  const limit = 200 * 1024;
  // Exactly at the limit (the padding after the end marker is dropped)...
  const full = Buffer.concat([base, Buffer.alloc(limit - base.length)]);
  assert.equal(full.length, limit);
  assert.ok(acceptPhoto(full).bytes.equals(acceptPhoto(base).bytes));
  // ...and one byte over.
  malformed(Buffer.concat([full, Buffer.alloc(1)]), 'too_large', 'one byte over');
  // A well-formed file that is simply big.
  const comment = seg(0xfe, Buffer.alloc(60_000, 0x20));
  malformed(afterSoi(base, Buffer.concat([comment, comment, comment, comment])), 'too_large', 'padded with comments');
  malformed(Buffer.alloc(5 * 1024 * 1024, 0xff), 'too_large', '5 MB');
});

test('refused: a file with Adobe’s colour marker', () => {
  const adobe = (rest) => seg(0xee, Buffer.concat([text('Adobe'), rest]));
  malformed(afterSoi(base, adobe(Buffer.from([0, 100, 0, 0, 0, 0, 1]))), 'adobe_marker', 'the usual 12 bytes');
  malformed(afterSoi(base, adobe(Buffer.alloc(0))), 'adobe_marker', 'only the word');
  malformed(afterSoi(base, adobe(Buffer.alloc(3000, 0x41))), 'adobe_marker', 'a long one');
  malformed(beforeEoi(base, adobe(Buffer.from([0, 100, 0, 0, 0, 0, 0]))), 'adobe_marker', 'after the picture');
  malformed(Buffer.concat([SOI, adobe(Buffer.from([0, 100, 0, 0, 0, 0, 1])), base.subarray(20)]), 'adobe_marker', 'in place of the JFIF header');
  // Other data under the same marker is not Adobe's: dropped like any other.
  const other = acceptPhoto(afterSoi(base, seg(0xee, text('adobe? no. Something else'))));
  assert.ok(other.bytes.equals(acceptPhoto(base).bytes));
});

test('at most 4 tables in a quantization segment', () => {
  const table = (id) => Buffer.concat([Buffer.from([id]), Buffer.alloc(64, 1)]);
  const wide = (id) => Buffer.concat([Buffer.from([0x10 | id]), Buffer.alloc(128, 1)]);
  const four = seg(0xdb, Buffer.concat([table(0), table(1), table(2), wide(3)]));
  const five = seg(0xdb, Buffer.concat([table(0), table(1), table(2), table(3), table(3)]));
  // Put first, the picture's own tables after them still apply.
  assert.equal(acceptPhoto(afterSoi(base, four)).ok, true, '4 tables');
  malformed(afterSoi(base, five), 'too_many_tables', '5 tables');
  malformed(afterSoi(base, seg(0xdb, Buffer.concat(Array.from({ length: 150 }, () => table(3))))), 'too_many_tables', '150 tables');
});

// A file that is a picture and, read as text, also a script: the trick is a
// first segment whose length bytes are 2F 2A, which read "/*".
const runsAsScript = (bytes) => {
  let called = null;
  try { new vm.Script(bytes.toString('latin1')).runInNewContext({ alert: (message) => { called = message; } }); } catch { return false; }
  return called;
};

test('files that are both a picture and a script are refused or come out harmless', () => {
  const body = base.subarray(20);     // everything after the start marker and the JFIF header
  const tail = text('*/ //');
  const padTo = (payload) => Buffer.concat([payload, Buffer.alloc(0x2f2a - 2 - payload.length)]);
  const polyglot = (first) => Buffer.concat([SOI, first, body.subarray(0, body.length - 2), tail, EOI]);
  const harmless = (bytes, name, { textGone = true } = {}) => {
    assert.ok(bytes.subarray(0, 20).equals(JFIF_START), name);
    assert.notEqual(bytes.toString('latin1', 4, 6), '/*', `${name}: no “/*” where the first length is`);
    assert.equal(runsAsScript(bytes), false, `${name}: what is kept is not a script`);
    assert.equal(bytes.includes('alert'), !textGone, name);
  };

  // 1. Through an Adobe segment.
  const viaAdobe = polyglot(seg(0xee, padTo(Buffer.concat([text('Adobe'), Buffer.from([0, 100, 0, 0, 0, 0, 1]), text('*/=alert("pwned")/*')]))));
  assert.equal(viaAdobe.toString('latin1', 4, 6), '/*');
  assert.equal(runsAsScript(viaAdobe), 'pwned', 'the test file really is a script');
  malformed(viaAdobe, 'adobe_marker', 'the Adobe polyglot');

  // 2. Through something dressed as a colour profile: accepted as a picture, and the script is gone.
  const viaProfile = polyglot(seg(0xe2, padTo(Buffer.concat([text('ICC_PROFILE\0'), Buffer.from([1, 1]), text('*/=alert("pwned-icc")/*')]))));
  assert.equal(runsAsScript(viaProfile), 'pwned-icc');
  const kept = acceptPhoto(viaProfile);
  assert.equal(kept.ok, true);
  harmless(kept.bytes, 'the colour-profile polyglot');
  assert.equal(markersOf(kept.bytes), 'e0 db db c0 c4 c4 c4 c4 da d9');

  // 3. Through a first quantization segment padded with 168 spare tables.
  const t8 = (first) => { const t = Buffer.alloc(65); t[0] = 0x03; first?.copy(t, 1); return t; };
  const t16 = () => { const t = Buffer.alloc(129); t[0] = 0x13; return t; };
  const tables = Buffer.concat([t8(text('*/=alert("pwned-dqt")/*')), ...Array.from({ length: 149 }, () => t8()), ...Array.from({ length: 18 }, () => t16())]);
  assert.equal(tables.length + 2, 0x2f2a);
  const viaTables = polyglot(Buffer.concat([Buffer.from([0xff, 0xdb, 0x2f, 0x2a]), tables]));
  assert.equal(runsAsScript(viaTables), 'pwned-dqt');
  malformed(viaTables, 'too_many_tables', 'the quantization-table polyglot');

  // The same through the other kinds of segment we keep or read past. Whatever
  // is accepted starts with our header, so no first length can read "/*".
  const huffman = (() => {
    // 44 tables of 256 symbols (273 bytes each) and one of 41: 12 072 bytes.
    const one = (symbols, first) => { const t = Buffer.alloc(17 + symbols); t[0] = 0x13; t[16] = Math.min(symbols, 255); t[15] = symbols - t[16]; first?.copy(t, 17); return t; };
    return Buffer.concat([one(256, text('*/=alert("pwned-dht")/*')), ...Array.from({ length: 43 }, () => one(256)), one(43)]);
  })();
  assert.equal(huffman.length + 2, 0x2f2a);
  const firsts = {
    'a Huffman-table segment': Buffer.concat([Buffer.from([0xff, 0xc4, 0x2f, 0x2a]), huffman]),
    'a comment': seg(0xfe, padTo(text('*/=alert("pwned-com")/*'))),
    'an EXIF block': seg(0xe1, padTo(text('Exif\0\0*/=alert("pwned-exif")/*'))),
    'a JFIF header': seg(0xe0, padTo(Buffer.concat([text('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]), text('*/=alert("pwned-jfif")/*')]))),
  };
  for (const [name, first] of Object.entries(firsts)) {
    const file = polyglot(first);
    assert.equal(file.toString('latin1', 4, 6), '/*', name);
    assert.match(String(runsAsScript(file)), /^pwned-/, `${name}: the test file really is a script`);
    const got = acceptPhoto(file);
    assert.equal(got.ok, true, name);
    // Huffman tables are part of the picture and are kept as they are, so
    // words hidden in spare ones stay in the file (as they can in the picture
    // data itself). They can no longer run: the file is not a script.
    harmless(got.bytes, name, { textGone: name !== 'a Huffman-table segment' });
  }
  // And every honest picture, once kept, is not a script either.
  for (const name of HONEST) assert.equal(runsAsScript(acceptPhoto(fx(name)).bytes), false, name);
});

test('anything after the end of the picture is dropped', () => {
  const clean = acceptPhoto(base).bytes;
  for (const tail of [text('PK\x03\x04 pretend zip <script>alert(1)</script>'), fx('grey-256.jpg'), Buffer.from([0x00]), Buffer.alloc(5000, 0xff), EOI]) {
    const joined = Buffer.concat([base, tail]);
    const found = inspectJpeg(joined, PHOTO_LIMITS);
    assert.equal(found.ok, true);
    assert.equal(found.trailingBytes, tail.length);
    const got = acceptPhoto(joined);
    assert.ok(got.bytes.equals(clean));
    assert.equal(inspectJpeg(got.bytes, PHOTO_LIMITS).trailingBytes, 0);
  }
});

test('fill bytes before markers are allowed, and not kept', () => {
  const padded = Buffer.concat([SOI, ...parts(base).map((s, n) => Buffer.concat([Buffer.alloc(1 + (n % 3), 0xff), base.subarray(s.at, s.end)]))]);
  assert.ok(padded.length > base.length + 10);
  assert.deepEqual(inspectJpeg(padded, PHOTO_LIMITS), inspectJpeg(base, PHOTO_LIMITS));
  assert.ok(acceptPhoto(padded).bytes.equals(acceptPhoto(base).bytes));
  // Restart markers inside the picture data are part of it, and kept.
  const restart = fx('restart-256.jpg');
  assert.ok(restart.includes(Buffer.from([0xff, 0xd0])));
  assert.equal(markersOf(acceptPhoto(restart).bytes), 'e0 db db c0 c4 c4 c4 c4 dd da d9');
});

test('thousands of damaged files: nothing throws, and whatever is accepted is clean', () => {
  // The same made-up "random" numbers on every run (xorshift), so a failure can be found again.
  let state = 0x9e3779b9;
  const rnd = (n) => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state % n; };
  const seeds = [...HONEST, 'orientation-6-256.jpg'].map(fx);
  const interesting = [0x00, 0xff, 0xd8, 0xd9, 0xda, 0xc0, 0xc2, 0xc4, 0xdb, 0xdd, 0xe0, 0xe1, 0xee, 0xfe, 0xd0, 0x01, 0x7f, 0x80];
  const count = { accepted: 0, reasons: new Set() };
  for (let i = 0; i < 4000; i += 1) {
    let b = Buffer.from(seeds[rnd(seeds.length)]);
    for (let edits = 1 + rnd(4); edits > 0 && b.length; edits -= 1) {
      const at = rnd(b.length);
      const kind = rnd(6);
      if (kind === 0) b[at] = rnd(256);
      else if (kind === 1) b[at] = interesting[rnd(interesting.length)];
      else if (kind === 2) b = b.subarray(0, at);
      else if (kind === 3) b = Buffer.concat([b.subarray(0, at), Buffer.from([0xff, interesting[rnd(interesting.length)]]), b.subarray(at)]);
      else if (kind === 4) b = Buffer.concat([b.subarray(0, at), b.subarray(Math.min(b.length, at + 1 + rnd(64)))]);
      else { const from = rnd(b.length); b = Buffer.concat([b.subarray(0, at), b.subarray(from, Math.min(b.length, from + 1 + rnd(200))), b.subarray(at)]); }
    }
    const where = `mutant ${i}`;
    let found;
    let got;
    assert.doesNotThrow(() => { found = inspectJpeg(b, PHOTO_LIMITS); }, where);
    assert.doesNotThrow(() => { got = acceptPhoto(b); }, where);
    if (!found.ok) {
      assert.deepEqual([found.width, found.height, typeof found.reason], [0, 0, 'string'], where);
      assert.throws(() => rebuildJpeg(b, PHOTO_LIMITS), (err) => err instanceof TypeError && err.reason === found.reason, where);
      assert.deepEqual(got, { ok: false, reason: b.length ? found.reason : 'not_jpeg' }, where);
      count.reasons.add(found.reason);
      continue;
    }
    // The structure is sound: rebuilding gives a clean file, whether or not it
    // is then the right shape for a photo.
    const rebuilt = rebuildJpeg(b, PHOTO_LIMITS);
    assert.ok(rebuilt.subarray(0, 20).equals(JFIF_START) && rebuilt.subarray(-2).equals(EOI), where);
    assert.ok(rebuilt.length <= b.length + 18, where);
    assert.ok(rebuildJpeg(rebuilt, PHOTO_LIMITS).equals(rebuilt), where);
    const again = inspectJpeg(rebuilt, PHOTO_LIMITS);
    assert.deepEqual(again, { ...found, orientation: 1, trailingBytes: 0 }, where);
    for (const { marker } of parts(rebuilt).slice(1)) assert.ok([0xdb, 0xc4, 0xdd, 0xc0, 0xc1, 0xc2, 0xda, 0xd9].includes(marker), `${where}: kept ${marker.toString(16)}`);
    if (got.ok) {
      count.accepted += 1;
      assert.ok(got.bytes.equals(rebuilt), where);
      assert.ok(found.width === found.height && found.width >= 96 && found.width <= 512 && found.orientation === 1, where);
    } else {
      assert.ok(['not_square', 'too_small', 'not_upright'].includes(got.reason), `${where}: ${got.reason}`);
    }
  }
  // The run really did reach both sides.
  assert.ok(count.accepted > 200, `${count.accepted} accepted`);
  assert.ok(count.reasons.size > 10, `${count.reasons.size} different refusals`);
});
