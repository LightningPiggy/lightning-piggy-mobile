/** Lossless metadata removal. Invalid/unsupported streams throw: callers must re-encode or abort. */
function invalid(): never {
  throw new Error('Invalid image byte stream');
}

function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function text(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Read only IFD0's inline SHORT Orientation; never copy pointers, thumbnails or other tags. */
function orientation(exif: Uint8Array): number | undefined {
  if (text(exif, 0, 6) !== 'Exif\0\0' || exif.length < 14) return;
  const tiff = new DataView(exif.buffer, exif.byteOffset + 6, exif.length - 6);
  const order = tiff.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return;
  const little = order === 0x4949;
  if (tiff.getUint16(2, little) !== 42) return;
  const ifd = tiff.getUint32(4, little);
  if (ifd < 8 || ifd + 2 > tiff.byteLength) return;
  const count = tiff.getUint16(ifd, little);
  if (ifd + 2 + count * 12 + 4 > tiff.byteLength) return;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (
      tiff.getUint16(entry, little) === 0x112 &&
      tiff.getUint16(entry + 2, little) === 3 &&
      tiff.getUint32(entry + 4, little) === 1
    ) {
      const value = tiff.getUint16(entry + 8, little);
      if (value >= 1 && value <= 8) return value;
    }
  }
}

function orientationSegment(value: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xe1,
    0,
    34,
    69,
    120,
    105,
    102,
    0,
    0,
    73,
    73,
    42,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    18,
    1,
    3,
    0,
    1,
    0,
    0,
    0,
    value,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  let sawScan = false;
  let keptOrientation = false;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!sawScan) invalid();
      parts.push(bytes.subarray(start, offset));
      // Trailing bytes are not image data and can contain metadata too.
      return join(parts);
    }
    if (marker === 0x01) {
      parts.push(bytes.subarray(start, offset));
      continue;
    }
    if (!marker || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (offset + 2 > bytes.length) invalid();
    const length = bytes[offset] * 256 + bytes[offset + 1];
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if (marker === 0xe1) {
      const value = orientation(bytes.subarray(offset + 2, end));
      if (value !== undefined && !keptOrientation) {
        parts.push(orientationSegment(value));
        keptOrientation = true;
      }
    } else if (marker !== 0xed && marker !== 0xfe) {
      parts.push(bytes.subarray(start, end));
    }
    offset = end;
    if (marker === 0xda) {
      sawScan = true;
      // Preserve entropy-coded data, stuffing and restart markers verbatim.
      const scanStart = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) {
          offset = next + 1;
        } else {
          break;
        }
      }
      parts.push(bytes.subarray(scanStart, offset));
    }
  }
  return invalid();
}

// One lookup per byte keeps validation linear even for large IDAT chunks.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (text(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n') invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset);
    const type = text(bytes, offset + 4, 4);
    const end = offset + 12 + size;
    if (end > bytes.length || (offset === 8 && (type !== 'IHDR' || size !== 13))) invalid();
    if (view.getUint32(end - 4) !== crc32(bytes, offset + 4, end - 4)) invalid();
    if (!['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) {
      parts.push(bytes.subarray(offset, end));
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (size !== 0 || !sawData) invalid();
      return join(parts);
    }
    offset = end;
  }
  return invalid();
}

export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (text(bytes, 0, 4) !== 'RIFF' || text(bytes, 8, 4) !== 'WEBP') invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
  const parts = [bytes.slice(0, 12)];
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = text(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) invalid();
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = bytes.slice(offset, end);
      if (type === 'VP8X') {
        if (size !== 10) invalid();
        chunk[8] &= ~0x0c; // Clear the EXIF/XMP presence flags.
      }
      parts.push(chunk);
    }
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') sawImage = true;
    offset = end;
  }
  if (offset !== bytes.length || !sawImage) invalid();
  const result = join(parts);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

/** Generic document providers may also omit an image's signature or MIME. */
export function hasImageFilename(filename: string): boolean {
  return /\.(?:jpe?g|jpe|jfif|png|webp|heics?|heifs?|hif|avif|gif|tiff?|bmp|ico|jp2|jxl|psd|dng|cr[23]|nef|nrw|arw|raf|orf|rw2|pef|srw|svg)$/i.test(
    filename,
  );
}

/** Recognize photo signatures even when a document provider returns generic MIME. */
export function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (text(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(text(bytes, 0, 6))) return 'image/gif';
  if (['II*\0', 'MM\0*', 'II+\0', 'MM\0+'].includes(text(bytes, 0, 4))) return 'image/tiff';
  if (text(bytes, 4, 4) === 'ftyp') {
    const brand = text(bytes, 8, 4);
    if (
      ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(
        brand,
      )
    ) {
      return 'image/heif';
    }
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
  }
}

export function stripImageMetadataBytes(bytes: Uint8Array, mime: string): Uint8Array {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
      return stripJpegMetadata(bytes);
    case 'image/png':
      return stripPngMetadata(bytes);
    case 'image/webp':
      return stripWebpMetadata(bytes);
    default:
      throw new Error('Image requires native re-encoding');
  }
}
