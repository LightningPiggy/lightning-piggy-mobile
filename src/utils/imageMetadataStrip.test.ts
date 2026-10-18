import { Buffer } from 'buffer';
import {
  detectImageMime,
  hasImageFilename,
  stripImageMetadataBytes,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
} from './imageMetadataStrip';

const bytes = (...parts: (number[] | Uint8Array)[]) => new Uint8Array(parts.flatMap((p) => [...p]));
const ascii = (text: string) => [...Buffer.from(text)];
const segment = (marker: number, payload: number[]) => [
  255,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 255,
  ...payload,
];
// IFD0 contains Orientation and a GPS IFD pointer; GPS payload must never survive.
const exif = (little: boolean, value = 6) => {
  const tiff = new Uint8Array(56);
  const view = new DataView(tiff.buffer);
  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 2, little);
  view.setUint16(10, 0x112, little);
  view.setUint16(12, 3, little);
  view.setUint32(14, 1, little);
  view.setUint16(18, value, little);
  view.setUint16(22, 0x8825, little);
  view.setUint16(24, 4, little);
  view.setUint32(26, 1, little);
  view.setUint32(30, 38, little);
  tiff.set(ascii('GPS secret coords'), 38);
  return [...ascii('Exif\0\0'), ...tiff];
};
const scan = segment(0xda, [1, 1, 0, 0, 63, 0]);
const pixels = [12, 34, 255, 0, 56, 255, 0xd0, 78];
const end = [255, 0xd9];

function pngChunk(type: string, payload: number[]) {
  const result = new Uint8Array(payload.length + 12);
  new DataView(result.buffer).setUint32(0, payload.length);
  result.set(ascii(type), 4);
  result.set(payload, 8);
  // Independent bit-at-a-time fixture CRC (production uses a lookup table).
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  new DataView(result.buffer).setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = pngChunk('IHDR', Array(13).fill(0));
const idat = pngChunk('IDAT', [9, 8, 7]);
const iend = pngChunk('IEND', []);

function webpChunk(type: string, payload: number[]) {
  const result = new Uint8Array(8 + payload.length + (payload.length % 2));
  result.set(ascii(type));
  new DataView(result.buffer).setUint32(4, payload.length, true);
  result.set(payload, 8);
  return result;
}
function webp(...chunks: Uint8Array[]) {
  const result = bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP'), ...chunks);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

describe('lossless file image metadata stripping', () => {
  it('drops JPEG EXIF GPS, XMP, IPTC and comments, preserving all other segments and scan bytes', () => {
    const kept = [
      ...segment(0xe0, ascii('JFIF')),
      ...segment(0xe2, ascii('ICC profile')),
      ...segment(0xee, ascii('Adobe')),
      ...segment(0xdb, [1, 2, 3]),
    ];
    const jpeg = bytes(
      [255, 0xd8],
      kept,
      segment(0xe1, ascii('Exif\0\0GPS secret')),
      segment(0xe1, ascii('XMP secret')),
      segment(0xed, ascii('IPTC secret')),
      segment(0xfe, ascii('comment secret')),
      scan,
      pixels,
      end,
      ascii('trailing secret'),
    );
    expect(stripJpegMetadata(jpeg)).toEqual(bytes([255, 0xd8], kept, scan, pixels, end));
  });

  it.each([true, false])('rebuilds only Orientation from %s-endian EXIF', (little) => {
    const stripped = stripJpegMetadata(
      bytes([255, 0xd8], segment(0xe1, exif(little)), scan, pixels, end),
    );
    expect(stripped.length).toBe(2 + 36 + scan.length + pixels.length + 2);
    expect([...stripped.subarray(2, 12)]).toEqual([255, 225, 0, 34, 69, 120, 105, 102, 0, 0]);
    expect(stripped[30]).toBe(6);
    expect(Buffer.from(stripped).includes(Buffer.from('GPS'))).toBe(false);
    expect(stripJpegMetadata(stripped)).toEqual(stripped);
  });

  it('removes metadata between progressive scans and rejects truncated streams', () => {
    const stripped = stripJpegMetadata(
      bytes([255, 0xd8], scan, pixels, segment(0xfe, ascii('secret')), scan, pixels, end),
    );
    expect(stripped).toEqual(bytes([255, 0xd8], scan, pixels, scan, pixels, end));
    expect(() => stripJpegMetadata(stripped.subarray(0, stripped.length - 1))).toThrow();
    expect(() => stripJpegMetadata(bytes([255, 0xd8, 255, 0xe1, 255, 255]))).toThrow();
  });

  it('discards invalid orientation and unsafe TIFF pointers', () => {
    const unsafe = exif(true);
    unsafe.splice(10, 4, 255, 255, 255, 255);
    for (const payload of [unsafe, exif(true, 9)]) {
      expect(
        stripJpegMetadata(bytes([255, 0xd8], segment(0xe1, payload), scan, pixels, end)),
      ).toEqual(bytes([255, 0xd8], scan, pixels, end));
    }
  });

  it('drops PNG eXIf, text and time chunks without changing image/colour chunks or CRCs', () => {
    const iccp = pngChunk('iCCP', [1, 2, 3]);
    const metadata = ['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].map((type) =>
      pngChunk(type, ascii('GPS secret')),
    );
    const stripped = stripPngMetadata(bytes(signature, ihdr, ...metadata, iccp, idat, iend));
    expect(stripped).toEqual(bytes(signature, ihdr, iccp, idat, iend));
    expect(() => stripPngMetadata(stripped.subarray(0, stripped.length - 1))).toThrow();
    const corrupt = stripped.slice();
    new DataView(corrupt.buffer).setUint32(8, 0xffffffff);
    expect(() => stripPngMetadata(corrupt)).toThrow();
  });

  it('drops WebP EXIF/XMP, fixes RIFF size and flags, preserves image and padded ICC chunks', () => {
    const vp8x = webpChunk('VP8X', [0x3e, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const image = webpChunk('VP8 ', [1, 2, 3, 4]);
    const icc = webpChunk('ICCP', [5, 6, 7]);
    const original = webp(
      vp8x,
      icc,
      webpChunk('EXIF', exif(true)),
      image,
      webpChunk('XMP ', ascii('GPS')),
    );
    const stripped = stripWebpMetadata(original);
    const cleanVp8x = vp8x.slice();
    cleanVp8x[8] = 0x32;
    expect(stripped).toEqual(webp(cleanVp8x, icc, image));
    expect(original[20]).toBe(0x3e);
    expect(() => stripWebpMetadata(original.subarray(0, original.length - 1))).toThrow();
    const corrupt = original.slice();
    new DataView(corrupt.buffer).setUint32(16, 0xffffffff, true);
    expect(() => stripWebpMetadata(corrupt)).toThrow();
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'])(
    'rejects malformed/unsupported %s for the native fallback',
    (mime) => expect(() => stripImageMetadataBytes(new Uint8Array([1, 2, 3]), mime)).toThrow(),
  );
});

it.each([
  [[255, 216], 'image/jpeg'],
  [[137, 80, 78, 71, 13, 10, 26, 10], 'image/png'],
  [[...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')], 'image/webp'],
  [ascii('GIF89a'), 'image/gif'],
  [ascii('II*\0'), 'image/tiff'],
  [ascii('MM\0*'), 'image/tiff'],
  [ascii('II+\0'), 'image/tiff'],
  [ascii('MM\0+'), 'image/tiff'],
  [[0, 0, 0, 24, ...ascii('ftypheic')], 'image/heif'],
  [[0, 0, 0, 24, ...ascii('ftypavif')], 'image/avif'],
  [ascii('%PDF-1.4'), undefined],
  [[], undefined],
])('detects image signatures in %j', (header, mime) => {
  expect(detectImageMime(new Uint8Array(header as number[]))).toBe(mime);
});

it.each([
  ['photo.TIFF', true],
  ['photo.dng', true],
  ['photo.jpeg', true],
  ['drawing.svg', true],
  ['document.pdf', false],
  ['photo.jpg.pdf', false],
])('recognizes the final image extension in %s', (name, expected) => {
  expect(hasImageFilename(name)).toBe(expected);
});

it('rejects a PNG with a corrupt IDAT CRC for native fallback', () => {
  const corruptIdat = idat.slice();
  corruptIdat[corruptIdat.length - 1] ^= 1;
  expect(() => stripPngMetadata(bytes(signature, ihdr, corruptIdat, iend))).toThrow();
  // Standard empty IEND CRC independently checks the fixture CRC generator.
  expect([...iend.subarray(8)]).toEqual([0xae, 0x42, 0x60, 0x82]);
});
