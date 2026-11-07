import {
  deleteShareCopies,
  shareDirUri,
  sweepStaleSharedFiles,
  verifySharedImages,
  wipeSharedFiles,
} from './sharedFiles';
import { MAX_SHARED_IMAGE_BYTES, type IncomingShare } from '../utils/incomingShare';

// In-memory stand-in for expo-file-system's File / Directory API.
interface FakeEntry {
  bytes: Uint8Array;
  size?: number;
  mtime: number;
}
const mockFs = new Map<string, FakeEntry>();

jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return mockFs.has(this.uri);
    }
    get size() {
      const e = mockFs.get(this.uri);
      return e ? (e.size ?? e.bytes.length) : 0;
    }
    get modificationTime() {
      return mockFs.get(this.uri)?.mtime ?? null;
    }
    open() {
      const bytes = mockFs.get(this.uri)!.bytes;
      return { readBytes: (n: number) => bytes.slice(0, n), close: () => undefined };
    }
    rename(name: string) {
      const next = this.uri.slice(0, this.uri.lastIndexOf('/') + 1) + name;
      mockFs.set(next, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = next;
    }
    delete() {
      mockFs.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}${name}/`;
    }
    get exists() {
      return [...mockFs.keys()].some((k) => k.startsWith(this.uri));
    }
    delete() {
      for (const k of [...mockFs.keys()]) if (k.startsWith(this.uri)) mockFs.delete(k);
    }
    list() {
      return [...mockFs.keys()].filter((k) => k.startsWith(this.uri)).map((k) => new File(k));
    }
  }
  return { File, Directory, Paths: { cache: { uri: 'file:///cache/' } } };
});

const DIR = 'file:///cache/lp-share/';
const name = (n: number, ext: string) => `share-0000000${n}-aaaa-bbbb-cccc-0123456789ab.${ext}`;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Uint8Array.from([...'%PDF-1.7 xxxx'].map((c) => c.charCodeAt(0)));

const put = (uri: string, bytes: Uint8Array, extra: Partial<FakeEntry> = {}) =>
  mockFs.set(uri, { bytes, mtime: 0, ...extra });

const shareOf = (...uris: string[]): IncomingShare => ({
  text: null,
  images: uris.map((uri) => ({ uri, mimeType: 'image/jpeg' })),
  discard: [],
});

beforeEach(() => mockFs.clear());

describe('verifySharedImages', () => {
  it('keeps real images with their sniffed type', () => {
    put(DIR + name(1, 'jpg'), JPEG);
    const result = verifySharedImages(shareOf(DIR + name(1, 'jpg')));
    expect(result.images).toEqual([{ uri: DIR + name(1, 'jpg'), mimeType: 'image/jpeg' }]);
    expect(result.discard).toEqual([]);
  });

  it('renames a copy whose extension lies about its bytes', () => {
    put(DIR + name(1, 'jpg'), PNG);
    const result = verifySharedImages(shareOf(DIR + name(1, 'jpg')));
    expect(result.images).toEqual([{ uri: DIR + name(1, 'png'), mimeType: 'image/png' }]);
    expect(mockFs.has(DIR + name(1, 'png'))).toBe(true);
    expect(mockFs.has(DIR + name(1, 'jpg'))).toBe(false);
  });

  it('discards non-images, oversized, empty and missing copies', () => {
    put(DIR + name(1, 'jpg'), PDF);
    put(DIR + name(2, 'jpg'), JPEG, { size: MAX_SHARED_IMAGE_BYTES + 1 });
    put(DIR + name(3, 'jpg'), new Uint8Array());
    const uris = [1, 2, 3, 4].map((n) => DIR + name(n, 'jpg'));
    const result = verifySharedImages(shareOf(...uris));
    expect(result.images).toEqual([]);
    expect(result.discard).toEqual(uris);
  });

  it('never reads a file outside the share folder', () => {
    const secret = 'file:///data/files/secret.jpg';
    put(secret, JPEG);
    const result = verifySharedImages(shareOf(secret));
    expect(result.images).toEqual([]);
  });
});

describe('deleting shared copies', () => {
  it('deleteShareCopies only deletes owned copies', () => {
    const owned = DIR + name(1, 'jpg');
    const other = 'file:///cache/other.jpg';
    put(owned, JPEG);
    put(other, JPEG);
    deleteShareCopies([owned, other]);
    expect(mockFs.has(owned)).toBe(false);
    expect(mockFs.has(other)).toBe(true);
  });

  it('wipeSharedFiles empties the share folder and nothing else', () => {
    put(DIR + name(1, 'jpg'), JPEG);
    put(DIR + name(2, 'png'), PNG);
    put('file:///cache/other.jpg', JPEG);
    wipeSharedFiles();
    expect([...mockFs.keys()]).toEqual(['file:///cache/other.jpg']);
  });

  it('sweepStaleSharedFiles removes only copies older than the window', () => {
    put(DIR + name(1, 'jpg'), JPEG, { mtime: 1_000 });
    put(DIR + name(2, 'jpg'), JPEG, { mtime: 9_500 });
    sweepStaleSharedFiles(5_000, 10_000);
    expect([...mockFs.keys()]).toEqual([DIR + name(2, 'jpg')]);
  });

  it('shareDirUri points into the app cache', () => {
    expect(shareDirUri()).toBe(DIR);
  });
});
