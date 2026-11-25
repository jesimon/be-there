# Makes the small, made-up JPEGs in test/fixtures/ with Pillow (libjpeg-turbo).
# They are drawings, not photographs of anyone. Run: python3 make_fixtures.py <folder>
# canvas-384.jpg is not made here: it is what public/js/photo.js exports in
# Chromium from sideways-320x240.jpg (see the note in test/jpeg.test.js).
import io, os, struct, sys
from PIL import Image, ImageDraw, ImageCms

out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def picture(w=256, h=256, mode='RGB'):
    # Not symmetric, so a turn or a flip shows: red top left, green top right,
    # blue bottom left, yellow bottom right, a face-coloured circle in the middle.
    im = Image.new('RGB', (w, h), (200, 200, 200))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=(int(255 * y / h), 120, int(255 * (h - y) / h)))
    q = min(w, h) // 4
    d.rectangle([0, 0, q, q], fill=(255, 0, 0))
    d.rectangle([w - q, 0, w, q], fill=(0, 255, 0))
    d.rectangle([0, h - q, q, h], fill=(0, 0, 255))
    d.rectangle([w - q, h - q, w, h], fill=(255, 255, 0))
    d.ellipse([w // 3, h // 3, 2 * w // 3, 2 * h // 3], fill=(240, 200, 170))
    return im.convert(mode) if mode != 'RGB' else im


def save(name, im, **kw):
    p = os.path.join(out, name)
    im.save(p, 'JPEG', **kw)
    print(f'{name:28s} {os.path.getsize(p):6d} bytes')
    return p


def exif(orientation):
    ex = Image.Exif()
    ex[0x0112] = orientation
    ex[0x010F] = 'SENTINEL-MAKE'
    ex[0x0110] = 'SENTINEL-MODEL'
    ex[0x0132] = '2026:11:25 10:00:00'
    ex[0x8825] = {1: 'N', 2: (51.0, 30.0, 26.0), 3: 'W', 4: (0.0, 7.0, 39.0), 0x1d: '2026:11:25', 0x1b: b'SENTINEL-GPS-METHOD'}
    return ex


def inject(path, segments):
    b = open(path, 'rb').read()
    assert b[:2] == b'\xff\xd8'
    extra = b''.join(b'\xff' + bytes([m]) + struct.pack('>H', len(p) + 2) + p for m, p in segments)
    open(path, 'wb').write(b[:2] + extra + b[2:])
    print(f'{os.path.basename(path):28s} {os.path.getsize(path):6d} bytes (with extra segments)')


base = picture()
save('baseline-256.jpg', base, quality=82, subsampling=2)
save('progressive-256.jpg', base, quality=82, progressive=True)
save('grey-256.jpg', picture(mode='L'), quality=82)
save('restart-256.jpg', base, quality=82, restart_marker_blocks=4)

# Everything a phone or an editor might add: EXIF with a place and a camera, a
# colour profile, a comment, XMP and Photoshop data. The words SENTINEL-... let
# a test prove they are gone.
srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
p = save('metadata-256.jpg', base, quality=82, exif=exif(1), icc_profile=srgb, comment=b'SENTINEL-COMMENT taken at home, 12 Example Road')
inject(p, [
    (0xE1, b'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description SENTINEL-XMP="1"/></rdf:RDF></x:xmpmeta>'),
    (0xED, b'Photoshop 3.0\x008BIM\x04\x04\0\0\0\0\0\x10SENTINEL-IPTC-XX'),
])

# Pictures that are only upright if the EXIF "orientation 6" is obeyed: a
# square one, and one as a phone held upright takes it (stored 320 x 240,
# meant to be shown 240 x 320).
T = Image.Transpose
save('orientation-6-256.jpg', base.transpose(T.ROTATE_90), quality=82, exif=exif(6))
save('sideways-320x240.jpg', picture(240, 320).transpose(T.ROTATE_90), quality=82, exif=exif(6))
