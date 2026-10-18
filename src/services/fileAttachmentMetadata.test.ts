import { Buffer } from 'buffer';
import { prepareFileAttachment } from './fileAttachmentMetadata';
import { stripImageMetadata } from './imageUploadService';

jest.mock('./imageUploadService', () => ({ stripImageMetadata: jest.fn() }));
const strip = jest.mocked(stripImageMetadata);

beforeEach(() => strip.mockReset());

it('passes PDF bytes, URI, MIME and filename through unchanged', async () => {
  const result = await prepareFileAttachment(
    'file:///document.pdf',
    'cGRm',
    'application/pdf',
    'a.pdf',
  );
  expect(result).toEqual({
    uri: 'file:///document.pdf',
    base64: 'cGRm',
    mime: 'application/pdf',
    filename: 'a.pdf',
  });
  expect(strip).not.toHaveBeenCalled();
});

it.each(['image/jpeg', 'application/octet-stream', '', 'application/pdf'])(
  'sanitizes JPEG signatures with provider MIME %s without native re-encoding',
  async (mime) => {
    const jpeg = Buffer.from([
      255, 216, 255, 225, 0, 5, 71, 80, 83, 255, 218, 0, 2, 1, 2, 255, 217,
    ]);
    const result = await prepareFileAttachment(
      'file:///a.jpg',
      jpeg.toString('base64'),
      mime,
      'a.jpg',
    );
    expect(Buffer.from(result.base64, 'base64')).toEqual(
      Buffer.from([255, 216, 255, 218, 0, 2, 1, 2, 255, 217]),
    );
    expect(result.mime).toBe('image/jpeg');
    expect(result.filename).toBe('a.jpg');
    expect(strip).not.toHaveBeenCalled();
  },
);

it.each([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/svg+xml',
])('re-encodes malformed/unsupported %s and updates MIME and extension', async (mime) => {
  strip.mockResolvedValue({ uri: 'file:///cache/clean.jpg', base64: 'Y2xlYW4=' });
  const result = await prepareFileAttachment('file:///a.gif', 'R1BT', mime, 'a.gif');
  expect(strip).toHaveBeenCalledWith('file:///a.gif', 'R1BT', { preserveGif: false });
  expect(result).toEqual({
    uri: 'file:///cache/clean.jpg',
    base64: 'Y2xlYW4=',
    mime: 'image/jpeg',
    filename: 'a.jpg',
  });
});

it('aborts on native failure instead of returning original image bytes', async () => {
  strip.mockRejectedValue(new Error('Cannot decode image'));
  await expect(
    prepareFileAttachment('file:///broken.jpg', 'R1BT', 'image/jpeg', 'a.jpg'),
  ).rejects.toThrow('Cannot decode image');
});

it.each([
  ['image/png', [137, 80, 78, 71, 13, 10, 26, 10]],
  ['image/webp', [...Buffer.from('RIFF'), 4, 0, 0, 0, ...Buffer.from('WEBP')]],
  ['image/heif', [0, 0, 0, 24, ...Buffer.from('ftypheic')]],
  ['image/gif', [...Buffer.from('GIF89a')]],
  ['image/tiff', [...Buffer.from('II*\0')]],
  ['image/tiff', [...Buffer.from('MM\0*')]],
])(
  're-encodes invalid or unsupported %s signatures even with generic MIME',
  async (_mime, header) => {
    strip.mockResolvedValue({ uri: 'file:///clean.jpg', base64: 'Y2xlYW4=' });
    const base64 = Buffer.from(header as number[]).toString('base64');
    const result = await prepareFileAttachment(
      'file:///opaque',
      base64,
      'application/octet-stream',
      'a',
    );
    expect(strip).toHaveBeenCalledWith('file:///opaque', base64, { preserveGif: false });
    expect(result.mime).toBe('image/jpeg');
  },
);

it.each(['photo.tiff', 'photo.dng', 'photo.jpg', 'drawing.svg'])(
  'does not pass generic-MIME %s through when its image header is missing',
  async (filename) => {
    strip.mockRejectedValue(new Error('Cannot decode image'));
    await expect(
      prepareFileAttachment('file:///opaque', 'R1BT', 'application/octet-stream', filename),
    ).rejects.toThrow('Cannot decode image');
    expect(strip).toHaveBeenCalledWith('file:///opaque', 'R1BT', { preserveGif: false });
  },
);

it('re-encodes a PNG with a corrupt chunk CRC instead of uploading those bytes', async () => {
  const png = Buffer.alloc(8 + 25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12);
  // All-zero CRC is invalid for this IHDR; its bounds are otherwise complete.
  strip.mockResolvedValue({ uri: 'file:///clean.png', base64: 'Y2xlYW4=' });
  const result = await prepareFileAttachment(
    'file:///bad.png',
    png.toString('base64'),
    'image/png',
    'bad.png',
  );
  expect(strip).toHaveBeenCalledWith('file:///bad.png', png.toString('base64'), {
    preserveGif: false,
  });
  expect(result.base64).toBe('Y2xlYW4=');
});
