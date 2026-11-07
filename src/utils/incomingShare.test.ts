import {
  appendSharedText,
  dmShareTarget,
  groupShareTarget,
  hasShareContent,
  isOwnedShareCopy,
  MAX_SHARED_IMAGES,
  MAX_SHARED_TEXT_CHARS,
  normalizeShareIntent,
  renamedForMime,
  sanitizeSharedText,
  shareCopies,
  sniffImageMime,
  someSharedItemsSkipped,
  toFileUri,
} from './incomingShare';

const DIR = 'file:///data/user/0/app/cache/lp-share/';
const copy = (n: number, ext = 'jpg') =>
  `${DIR}share-0000000${n}-aaaa-bbbb-cccc-0123456789ab.${ext}`;

describe('isOwnedShareCopy', () => {
  it('accepts a generated copy directly inside the share folder', () => {
    expect(isOwnedShareCopy(copy(1), DIR)).toBe(true);
    expect(isOwnedShareCopy(copy(1, 'PNG'), DIR.slice(0, -1))).toBe(true);
  });

  it.each([
    ['another app-private file', 'file:///data/user/0/app/files/secret.jpg'],
    [
      'the cache root',
      'file:///data/user/0/app/cache/share-00000001-aaaa-bbbb-cccc-0123456789ab.jpg',
    ],
    ['a content URI', 'content://media/external/images/media/1'],
    ['traversal out of the folder', `${DIR}../files/x.jpg`],
    ['encoded traversal', `${DIR}%2e%2e/files/x.jpg`],
    ['a nested path', `${DIR}sub/share-00000001-aaaa-bbbb-cccc-0123456789ab.jpg`],
    ['a sender-chosen name', `${DIR}holiday.jpg`],
    ['an unexpected extension', `${DIR}share-00000001-aaaa-bbbb-cccc-0123456789ab.pdf`],
  ])('rejects %s', (_label, uri) => {
    expect(isOwnedShareCopy(uri, DIR)).toBe(false);
  });

  it('rejects everything when the folder is unknown', () => {
    expect(isOwnedShareCopy(copy(1), null)).toBe(false);
  });
});

describe('sniffImageMime', () => {
  const bytes = (...parts: (number[] | string)[]) =>
    Uint8Array.from(
      parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
    );

  it('recognises the supported formats by their magic numbers', () => {
    expect(sniffImageMime(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'))).toBe('image/jpeg');
    expect(sniffImageMime(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(
      'image/png',
    );
    expect(sniffImageMime(bytes('GIF89a', [1, 0, 1, 0]))).toBe('image/gif');
    expect(sniffImageMime(bytes('GIF87a'))).toBe('image/gif');
    expect(sniffImageMime(bytes('RIFF', [0, 0, 0, 0], 'WEBP'))).toBe('image/webp');
    expect(sniffImageMime(bytes([0, 0, 0, 0x18], 'ftyp', 'heic'))).toBe('image/heic');
    expect(sniffImageMime(bytes([0, 0, 0, 0x18], 'ftyp', 'mif1'))).toBe('image/heic');
  });

  it('rejects anything else, whatever it claims to be', () => {
    expect(sniffImageMime(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffImageMime(bytes('<svg xmlns='))).toBeNull();
    expect(sniffImageMime(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
    expect(sniffImageMime(bytes([0, 0, 0, 0x18], 'ftyp', 'mp42'))).toBeNull();
    expect(sniffImageMime(bytes([0xff, 0xd8]))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });
});

describe('renamedForMime', () => {
  it('fixes an extension that does not match the bytes', () => {
    expect(renamedForMime('share-1.jpg', 'image/png')).toBe('share-1.png');
    expect(renamedForMime('share-1.png', 'image/gif')).toBe('share-1.gif');
  });

  it('leaves a matching name alone', () => {
    expect(renamedForMime('share-1.jpg', 'image/jpeg')).toBeNull();
    expect(renamedForMime('share-1.HEIC', 'image/heic')).toBeNull();
  });
});

describe('sanitizeSharedText', () => {
  it('keeps plain text and links as plain text', () => {
    expect(sanitizeSharedText('  look https://example.com/x?y=1  ')).toBe(
      'look https://example.com/x?y=1',
    );
    expect(sanitizeSharedText('lightning:lnbc1...')).toBe('lightning:lnbc1...');
  });

  it('removes control and direction-override characters, normalises line endings', () => {
    expect(sanitizeSharedText('a\u0000b\u202ec\u2066d\r\ne\rf\tg')).toBe('abcd\ne\nf\tg');
  });

  it('removes every bidi mark, embedding, override and isolate', () => {
    const bidi = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e'];
    const isolates = ['\u2066', '\u2067', '\u2068', '\u2069'];
    expect(sanitizeSharedText(`x${[...bidi, ...isolates].join('')}y`)).toBe('xy');
  });

  it('removes zero-width and invisible format characters', () => {
    expect(sanitizeSharedText('\ufeffexa\u200bmple\u200c.com\u2060/\u200dpath')).toBe(
      'example.com/path',
    );
  });

  it('removes other invisible characters that could fake line breaks or hide text', () => {
    const invisible = ['\u00ad', '\u180e', '\u2028', '\u2029', '\ufff9', '\ufffa', '\ufffb'];
    const fillers = ['\u3164', '\uffa0'];
    expect(sanitizeSharedText(`x${[...invisible, ...fillers].join('')}y`)).toBe('xy');
  });

  it('keeps the joiner inside an emoji sequence', () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    const heart = '\u2764\ufe0f\u200d\u{1F525}';
    expect(sanitizeSharedText(`hi ${family} ${heart}`)).toBe(`hi ${family} ${heart}`);
  });

  it('caps the length and drops empty text', () => {
    expect(sanitizeSharedText('x'.repeat(MAX_SHARED_TEXT_CHARS + 50))).toHaveLength(
      MAX_SHARED_TEXT_CHARS,
    );
    expect(sanitizeSharedText('  \u0000 \n ')).toBeNull();
    expect(sanitizeSharedText(null)).toBeNull();
  });
});

describe('normalizeShareIntent', () => {
  it('keeps text and owned image copies', () => {
    const share = normalizeShareIntent(
      {
        text: ' hello ',
        files: [{ path: copy(1).slice('file://'.length), mimeType: 'IMAGE/JPEG' }],
      },
      DIR,
    );
    expect(share).toEqual({
      text: 'hello',
      images: [{ uri: copy(1), mimeType: 'image/jpeg' }],
      discard: [],
    });
    expect(hasShareContent(share)).toBe(true);
  });

  it('falls back to the web URL when there is no text', () => {
    expect(normalizeShareIntent({ webUrl: 'https://example.com' }, DIR).text).toBe(
      'https://example.com',
    );
  });

  it('ignores paths it does not own — never even scheduling them for deletion', () => {
    const share = normalizeShareIntent(
      {
        files: [
          { path: 'file:///data/user/0/app/files/wallet.db', mimeType: 'image/jpeg' },
          { path: 'content://evil/1', mimeType: 'image/png' },
        ],
      },
      DIR,
    );
    expect(share.images).toEqual([]);
    expect(share.discard).toEqual([]);
    expect(hasShareContent(share)).toBe(false);
  });

  it('caps the number of images and discards the rest', () => {
    const files = Array.from({ length: MAX_SHARED_IMAGES + 2 }, (_, i) => ({
      path: copy(i % 10).replace('aaaa', `a${String(i).padStart(3, '0')}`),
      mimeType: 'image/jpeg',
    }));
    const share = normalizeShareIntent({ files }, DIR);
    expect(share.images).toHaveLength(MAX_SHARED_IMAGES);
    expect(share.discard).toHaveLength(2);
    expect(shareCopies(share)).toHaveLength(MAX_SHARED_IMAGES + 2);
  });
});

describe('someSharedItemsSkipped', () => {
  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: copy(i), mimeType: 'image/jpeg' }));
  const kept = (n: number) => ({
    text: null,
    images: files(n).map((f) => ({ uri: f.path, mimeType: 'image/jpeg' })),
    discard: [],
  });

  it('flags photos the native cap dropped before JS saw them (12 offered, 10 kept)', () => {
    expect(someSharedItemsSkipped({ files: files(10), lpOfferedFileCount: 12 }, kept(10))).toBe(
      true,
    );
  });

  it('flags files the native type / size checks dropped', () => {
    expect(someSharedItemsSkipped({ files: files(3), lpOfferedFileCount: 4 }, kept(3))).toBe(true);
  });

  it('stays quiet when everything offered was kept', () => {
    expect(someSharedItemsSkipped({ files: files(10), lpOfferedFileCount: 10 }, kept(10))).toBe(
      false,
    );
  });

  it('counts native and JS rejections against one total, not twice', () => {
    // 12 offered, 10 passed on, 1 of those failed the byte sniff: still one notice.
    const intent = { files: files(10), lpOfferedFileCount: 12 };
    expect(someSharedItemsSkipped(intent, kept(9))).toBe(true);
  });

  it('without the native count, behaves as before: kept vs passed on', () => {
    expect(someSharedItemsSkipped({ files: files(10) }, kept(10))).toBe(false);
    expect(someSharedItemsSkipped({ files: files(3) }, kept(2))).toBe(true);
    expect(someSharedItemsSkipped({ files: files(3), lpOfferedFileCount: null }, kept(3))).toBe(
      false,
    );
  });

  it.each([NaN, -1, 2.5, Infinity])('ignores a nonsensical native count (%p)', (count) => {
    expect(someSharedItemsSkipped({ files: files(3), lpOfferedFileCount: count }, kept(3))).toBe(
      false,
    );
  });

  it('never reports fewer offered than were passed on', () => {
    expect(someSharedItemsSkipped({ files: files(3), lpOfferedFileCount: 1 }, kept(2))).toBe(true);
  });

  it('is quiet for a text-only share', () => {
    expect(someSharedItemsSkipped({ text: 'hi' }, { ...kept(0), text: 'hi' })).toBe(false);
  });
});

describe('small helpers', () => {
  it('toFileUri adds the scheme to absolute paths only', () => {
    expect(toFileUri('/a/b.jpg')).toBe('file:///a/b.jpg');
    expect(toFileUri('file:///a/b.jpg')).toBe('file:///a/b.jpg');
    expect(toFileUri('content://x/1')).toBe('content://x/1');
  });

  it('appendSharedText keeps what was typed', () => {
    expect(appendSharedText('', 'shared')).toBe('shared');
    expect(appendSharedText('hi  \n', 'shared')).toBe('hi\nshared');
  });

  it('share targets are per thread', () => {
    expect(dmShareTarget('ABC', 'marmot')).toBe('dm:marmot:abc');
    expect(dmShareTarget('abc', 'nip17')).not.toBe(dmShareTarget('abc', 'marmot'));
    expect(groupShareTarget('g1')).toBe('group:g1');
  });
});
