import React from 'react';
import { shareFileAttachment } from './fileShare';
import * as remoteUrlPolicy from '../utils/remoteUrlPolicy';
import { parsePlainFileAttachment } from '../utils/fileAttachment';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import MessageFileBubble from '../components/MessageFileBubble';
import { parseFileAttachment } from '../utils/fileAttachment';
import { encodeMarmotMediaUrl } from '../utils/encryptedFileUrl';
import { FileVerificationError } from './fileDownload';
import { encryptMediaFile } from '@internet-privacy/marmot-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteAsync, getInfoAsync, moveAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { encryptFile } from './encryptedFile';
import { encodeEncryptedFileUrl } from '../utils/encryptedFileUrl';
import { parseVoiceNote } from '../utils/messageContent';
import {
  captureDecryptedMediaSession,
  namedFileExport,
  publishDecryptedPreview,
  deleteDecryptedFile,
  retainDecryptedFile,
  FILE_SHARE_RETENTION_MS,
  verifiedFileMetadata,
  DecryptedMediaCancelledError,
  LEGACY_CLEANUP_FLAG_KEY,
  __resetDecryptedMediaCacheForTests,
  cleanupLegacyDecryptedMedia,
  clearDecryptedMediaMemory,
  ownerDirName,
  mediaCacheKey,
  clearDecryptedMediaCache,
  peekDecryptedMedia,
  resolveDecryptedMedia,
  setDecryptedMediaOwner,
  wipeDecryptedMediaForOwner,
  type EncryptedMediaRef,
} from './decryptedMediaCache';

jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));
jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => {}),
}));

jest.mock('expo/fetch', () => ({
  fetch: async (...args: unknown[]) => {
    const res = await globalThis.fetch(...(args as Parameters<typeof globalThis.fetch>));
    if (res.body?.getReader) return res;
    let done = false;
    return {
      ...res,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (done) return { done: true };
            done = true;
            return { done: false, value: new Uint8Array(await res.arrayBuffer()) };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    };
  },
}));

// --- in-memory expo-file-system/legacy ------------------------------------
// path → base64 contents. Directories are implicit (any path prefix).
const mockFiles = new Map<string, string>();
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn(async (uri: string) => ({
    exists: mockFiles.has(uri),
    size: Buffer.from(mockFiles.get(uri) ?? '', 'base64').length,
    modificationTime: uri.includes('file-old') ? 0 : Date.now() / 1000,
  })),
  readAsStringAsync: jest.fn(async (uri: string) => mockFiles.get(uri) ?? ''),
  makeDirectoryAsync: jest.fn(async () => {}),
  writeAsStringAsync: jest.fn(async (uri: string, data: string) => {
    mockFiles.set(uri, data);
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    for (const k of [...mockFiles.keys()]) if (k === uri || k.startsWith(uri)) mockFiles.delete(k);
  }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const data = mockFiles.get(from);
    if (data === undefined) throw new Error('copy source missing');
    mockFiles.set(to, data);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const data = mockFiles.get(from);
    if (data === undefined) throw new Error(`move: ${from} missing`);
    mockFiles.delete(from);
    mockFiles.set(to, data);
  }),
  readDirectoryAsync: jest.fn(async (dir: string) =>
    [...mockFiles.keys()]
      .filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
      .map((k) => k.slice(dir.length)),
  ),
}));

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const URL_ = 'https://blossom.example/abc123';
const PLAIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const sealed = encryptFile(PLAIN);
const ref: EncryptedMediaRef = {
  url: URL_,
  kind: 'voice',
  mime: 'audio/mp4',
  keyHex: sealed.keyHex,
  nonceHex: sealed.nonceHex,
};
const wrongKeys: EncryptedMediaRef = { ...ref, keyHex: encryptFile(PLAIN).keyHex };

const fetchMock = jest.fn();
function cipherResponse() {
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: sealed.ciphertext.slice() };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}
function serveCiphertext() {
  fetchMock.mockImplementation(async () => cipherResponse());
}

const filesUnder = (owner: string) =>
  [...mockFiles.keys()].filter((k) =>
    k.startsWith(`file:///cache/decrypted/${ownerDirName(owner)}/`),
  );
const plaintextOf = (uri: string) => Buffer.from(mockFiles.get(uri) ?? '', 'base64');

beforeEach(async () => {
  jest.useRealTimers();
  mockFiles.clear();
  fetchMock.mockReset();
  serveCiphertext();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  __resetDecryptedMediaCacheForTests();
  await AsyncStorage.clear();
  // Pre-seed the flag so the scheduled legacy sweep is a no-op in most tests.
  await AsyncStorage.setItem(LEGACY_CLEANUP_FLAG_KEY, '1');
});

afterAll(() => __resetDecryptedMediaCacheForTests());

describe('decryptedMediaCache', () => {
  it('downloads a plain imeta file into the same account-scoped cache', async () => {
    setDecryptedMediaOwner(A);
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => PLAIN.slice().buffer });
    const uri = await resolveDecryptedMedia({
      url: URL_,
      kind: 'file',
      mime: 'application/pdf',
      encrypted: false,
      plaintextSha256: bytesToHex(sha256(PLAIN)),
    });
    expect([...plaintextOf(uri)]).toEqual([...PLAIN]);
    expect(uri).toContain(ownerDirName(A));
    expect(uri.endsWith('.pdf')).toBe(true);
  });

  it('downloads and authenticates a MIP-04 PDF into an account-scoped shareable temp file', async () => {
    const key = new Uint8Array(32).fill(17);
    const { encrypted, attachment } = encryptMediaFile(PLAIN, key, {
      version: 'encrypted-media-v2',
      mediaType: 'application/pdf',
      filename: 'invoice.pdf',
      plaintextSha256: bytesToHex(sha256(PLAIN)),
    });
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => encrypted.slice().buffer });
    const pdf: EncryptedMediaRef = {
      url: URL_,
      kind: 'file',
      mime: 'application/pdf',
      nonceHex: attachment.nonce,
      marmot: {
        version: attachment.version,
        keysHex: [bytesToHex(key)],
        filename: attachment.filename,
        plaintextSha256: attachment.plaintextSha256,
        ciphertextSha256: attachment.ciphertextSha256,
      },
    };
    setDecryptedMediaOwner(A);
    const uri = await resolveDecryptedMedia(pdf);
    expect(uri).toMatch(/file-.*\.pdf$/);
    expect([...plaintextOf(uri)]).toEqual([...PLAIN]);
    expect(await resolveDecryptedMedia(pdf)).toBe(uri);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      resolveDecryptedMedia({ ...pdf, marmot: { ...pdf.marmot!, keysHex: ['00'.repeat(32)] } }),
    ).rejects.toThrow();
  });

  it('decrypts once and reuses the file for the same account', async () => {
    setDecryptedMediaOwner(A);
    const uri = await resolveDecryptedMedia(ref);
    expect(uri.startsWith(`file:///cache/decrypted/${ownerDirName(A)}/voice-`)).toBe(true);
    expect(uri.endsWith('.m4a')).toBe(true);
    expect([...plaintextOf(uri)]).toEqual([...PLAIN]);
    expect(peekDecryptedMedia(ref)).toBe(uri);
    expect(await resolveDecryptedMedia(ref)).toBe(uri);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes outgoing plaintext on identity switch', async () => {
    setDecryptedMediaOwner(A);
    const uriA = await resolveDecryptedMedia(ref);
    setDecryptedMediaOwner(B);
    expect(peekDecryptedMedia(ref)).toBeNull();
    const uriB = await resolveDecryptedMedia(ref);
    expect(uriB).not.toBe(uriA);
    expect(filesUnder(A)).toEqual([]);
    expect(filesUnder(B)).toEqual([uriB]);
    // B decrypted for itself rather than reusing A's file.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wipe deletes the account's files and memory entries, and leaves others alone", async () => {
    const uriB = `file:///cache/decrypted/${ownerDirName(B)}/keep.m4a`;
    mockFiles.set(uriB, 'other account');
    setDecryptedMediaOwner(A);
    await resolveDecryptedMedia(ref);
    await clearDecryptedMediaCache(A);
    expect(filesUnder(A)).toEqual([]);
    expect(peekDecryptedMedia(ref)).toBeNull();
    expect(filesUnder(B)).toEqual([uriB]);
    // Signing back in, the next play decrypts again.
    setDecryptedMediaOwner(A);
    await resolveDecryptedMedia(ref);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never serves cached plaintext to a request with the wrong keys', async () => {
    setDecryptedMediaOwner(A);
    await resolveDecryptedMedia(ref);
    // Same URL, other keys: a different cache entry, so it must decrypt — and fail.
    expect(peekDecryptedMedia(wrongKeys)).toBeNull();
    await expect(resolveDecryptedMedia(wrongKeys)).rejects.toThrow();
    // Another account holding the URL with wrong keys gets nothing either.
    setDecryptedMediaOwner(B);
    await expect(resolveDecryptedMedia(wrongKeys)).rejects.toThrow();
    expect(filesUnder(B)).toEqual([]);
  });

  it('a decrypt in flight when the account is wiped writes nothing', async () => {
    setDecryptedMediaOwner(A);
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(cipherResponse());
        }),
    );
    const pending = resolveDecryptedMedia(ref);
    await new Promise((r) => setImmediate(r));
    await wipeDecryptedMediaForOwner(A);
    release();
    await expect(pending).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
    expect(filesUnder(A)).toEqual([]);
    expect(peekDecryptedMedia(ref)).toBeNull();
  });

  it('a decrypt in flight across an account switch or identity reset writes nothing', async () => {
    for (const end of [() => setDecryptedMediaOwner(B), () => clearDecryptedMediaMemory()]) {
      __resetDecryptedMediaCacheForTests();
      mockFiles.clear();
      setDecryptedMediaOwner(A);
      let release!: () => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(cipherResponse());
          }),
      );
      const pending = resolveDecryptedMedia(ref);
      await new Promise((r) => setImmediate(r));
      end();
      release();
      await expect(pending).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
      expect(filesUnder(A)).toEqual([]);
    }
  });

  it("a request made after A's sign-out is cancelled and never lands in B's folder", async () => {
    setDecryptedMediaOwner(A);
    await resolveDecryptedMedia(ref);
    fetchMock.mockClear();
    await wipeDecryptedMediaForOwner(A);
    const late = resolveDecryptedMedia(ref); // e.g. a bubble mounting mid-logout
    setDecryptedMediaOwner(B); // the successor account becomes active
    await expect(late).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(filesUnder(A)).toEqual([]);
    expect(filesUnder(B)).toEqual([]);
  });

  it('a cold-start waiter is cancelled if the owner changes again before it runs', async () => {
    const pending = resolveDecryptedMedia(ref);
    setDecryptedMediaOwner(A);
    setDecryptedMediaOwner(B);
    await expect(pending).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
    expect(filesUnder(A)).toEqual([]);
    expect(filesUnder(B)).toEqual([]);
  });

  it('never leaves a plaintext temp file behind when a write or move fails', async () => {
    setDecryptedMediaOwner(A);
    (writeAsStringAsync as jest.Mock).mockImplementationOnce(async (uri: string) => {
      mockFiles.set(uri, 'partial'); // e.g. disk full mid-write
      throw new Error('ENOSPC');
    });
    await expect(resolveDecryptedMedia(ref)).rejects.toThrow('ENOSPC');
    expect(filesUnder(A)).toEqual([]);
    (moveAsync as jest.Mock).mockRejectedValueOnce(new Error('move failed'));
    await expect(resolveDecryptedMedia(ref)).rejects.toThrow('move failed');
    expect(filesUnder(A)).toEqual([]);
  });

  it('a wipe waits for a publish already past its last check, then deletes it', async () => {
    setDecryptedMediaOwner(A);
    let releaseMove!: () => void;
    let moveStarted!: () => void;
    const started = new Promise<void>((r) => (moveStarted = r));
    // A move that reads the temp, then completes later (lands after a naive
    // folder delete would have run).
    (moveAsync as jest.Mock).mockImplementationOnce(
      async ({ from, to }: { from: string; to: string }) => {
        const data = mockFiles.get(from) as string;
        moveStarted();
        await new Promise<void>((r) => (releaseMove = r));
        mockFiles.delete(from);
        mockFiles.set(to, data);
      },
    );
    const pending = resolveDecryptedMedia(ref);
    await started;
    const wipe = wipeDecryptedMediaForOwner(A);
    await new Promise((r) => setImmediate(r));
    releaseMove();
    await wipe;
    await expect(pending).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
    expect(filesUnder(A)).toEqual([]);
  });

  it('a cancelled writer never deletes the file a newer request published (A → B → A)', async () => {
    setDecryptedMediaOwner(A);
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(cipherResponse());
        }),
    );
    const stale = resolveDecryptedMedia(ref);
    await new Promise((r) => setImmediate(r));
    setDecryptedMediaOwner(B);
    setDecryptedMediaOwner(A);
    const uri = await resolveDecryptedMedia(ref);
    release();
    await expect(stale).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
    expect(filesUnder(A)).toEqual([uri]);
    expect([...plaintextOf(uri)]).toEqual([...PLAIN]);
  });

  it('waits for an account to become active (cold start) before decrypting', async () => {
    const pending = resolveDecryptedMedia(ref);
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
    setDecryptedMediaOwner(A);
    const uri = await pending;
    expect(filesUnder(A)).toEqual([uri]);
  });

  it('gives up if no account becomes active', async () => {
    jest.useFakeTimers();
    const pending = resolveDecryptedMedia(ref);
    jest.advanceTimersByTime(15_000);
    await expect(pending).rejects.toThrow(/No active account/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes legacy device-wide files once, and on sign-out until it has run', async () => {
    await AsyncStorage.removeItem(LEGACY_CLEANUP_FLAG_KEY);
    mockFiles.set('file:///cache/lp-voice-abc.m4a', 'x');
    mockFiles.set('file:///cache/lp-img-def.jpg', 'x');
    mockFiles.set('file:///cache/ImagePicker-keep.jpg', 'x');
    await wipeDecryptedMediaForOwner(A);
    expect([...mockFiles.keys()]).toEqual(['file:///cache/ImagePicker-keep.jpg']);
    expect(await AsyncStorage.getItem(LEGACY_CLEANUP_FLAG_KEY)).toBe('1');
    // Already done: later runs don't list / delete again.
    mockFiles.set('file:///cache/lp-voice-new.m4a', 'x');
    await cleanupLegacyDecryptedMedia();
    expect(mockFiles.has('file:///cache/lp-voice-new.m4a')).toBe(true);
  });

  it('retries the legacy cleanup later if a file could not be deleted', async () => {
    await AsyncStorage.removeItem(LEGACY_CLEANUP_FLAG_KEY);
    mockFiles.set('file:///cache/lp-voice-stuck.m4a', 'x');
    (deleteAsync as jest.Mock).mockRejectedValueOnce(new Error('EBUSY'));
    await cleanupLegacyDecryptedMedia();
    expect(await AsyncStorage.getItem(LEGACY_CLEANUP_FLAG_KEY)).toBeNull();
    await cleanupLegacyDecryptedMedia();
    expect(mockFiles.size).toBe(0);
    expect(await AsyncStorage.getItem(LEGACY_CLEANUP_FLAG_KEY)).toBe('1');
  });

  it('schedules the legacy sweep when an account first becomes active', async () => {
    jest.useFakeTimers();
    await AsyncStorage.removeItem(LEGACY_CLEANUP_FLAG_KEY);
    mockFiles.set('file:///cache/lp-img-old.png', 'x');
    setDecryptedMediaOwner(A);
    expect(mockFiles.size).toBe(1);
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockFiles.size).toBe(0);
  });
});

it('rejects substituted plaintext and a missing hash without publishing', async () => {
  setDecryptedMediaOwner(A);
  fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => PLAIN.slice().buffer });
  for (const plaintextSha256 of ['00'.repeat(32), undefined]) {
    await expect(
      resolveDecryptedMedia({ url: URL_, kind: 'file', encrypted: false, plaintextSha256 }),
    ).rejects.toThrow('File failed verification');
    expect(filesUnder(A)).toEqual([]);
  }
});
it('does not reuse plaintext cached against another committed hash', async () => {
  setDecryptedMediaOwner(A);
  fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => PLAIN.slice().buffer });
  const plainRef: EncryptedMediaRef = {
    url: URL_,
    kind: 'file',
    encrypted: false,
    plaintextSha256: bytesToHex(sha256(PLAIN)),
  };
  const uri = await resolveDecryptedMedia(plainRef);
  expect(verifiedFileMetadata(uri)).toEqual({
    size: PLAIN.length,
    mime: 'application/octet-stream',
  });
  await expect(
    resolveDecryptedMedia({ ...plainRef, plaintextSha256: '00'.repeat(32) }),
  ).rejects.toThrow('verification');
  await deleteDecryptedFile(uri);
  expect(mockFiles.has(uri)).toBe(false);
  expect(peekDecryptedMedia(plainRef)).toBeNull();
});
it('evicts abandoned plaintext shares on disk', async () => {
  setDecryptedMediaOwner(A);
  const stale = `file:///cache/decrypted/${ownerDirName(A)}/file-old.bin`;
  mockFiles.set(stale, 'plaintext');
  fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => PLAIN.slice().buffer });
  await resolveDecryptedMedia({
    url: URL_,
    kind: 'file',
    encrypted: false,
    plaintextSha256: bytesToHex(sha256(PLAIN)),
  });
  expect(mockFiles.has(stale)).toBe(false);
});

it('re-verifies bounded disk plaintext before sharing and rejects a substituted cached file', async () => {
  setDecryptedMediaOwner(A);
  const plainRef: EncryptedMediaRef = {
    url: URL_,
    kind: 'file',
    encrypted: false,
    plaintextSha256: bytesToHex(sha256(PLAIN)),
  };
  const uri = `file:///cache/decrypted/${ownerDirName(A)}/file-${mediaCacheKey(plainRef)}.bin`;
  mockFiles.set(uri, Buffer.from(PLAIN).toString('base64'));
  expect(await resolveDecryptedMedia(plainRef)).toBe(uri);
  expect(fetchMock).not.toHaveBeenCalled();
  clearDecryptedMediaMemory();
  mockFiles.set(uri, Buffer.from('substituted').toString('base64'));
  await expect(resolveDecryptedMedia(plainRef)).rejects.toThrow('File failed verification');
  expect(mockFiles.has(uri)).toBe(false);
});

it('retains plaintext for a recipient read after chooser completion, then deletes it', async () => {
  jest.useFakeTimers();
  setDecryptedMediaOwner(A);
  fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => PLAIN.slice().buffer });
  const fileRef: EncryptedMediaRef = {
    url: URL_,
    kind: 'file',
    encrypted: false,
    plaintextSha256: bytesToHex(sha256(PLAIN)),
  };
  const uri = await resolveDecryptedMedia(fileRef);
  const release = retainDecryptedFile(uri);
  release(); // Android chooser returns before the recipient reads its URI.
  await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS - 1);
  expect([...plaintextOf(uri)]).toEqual([...PLAIN]);
  expect(peekDecryptedMedia(fileRef)).toBe(uri);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockFiles.has(uri)).toBe(false);
  expect(peekDecryptedMedia(fileRef)).toBeNull();
  expect(verifiedFileMetadata(uri)).toBeUndefined();
});
it('extends retention on repeated/concurrent shares and excludes them from sweeps', async () => {
  jest.useFakeTimers();
  setDecryptedMediaOwner(A);
  const uri = `file:///cache/decrypted/${ownerDirName(A)}/file-old.bin`;
  mockFiles.set(uri, Buffer.from(PLAIN).toString('base64'));
  const first = retainDecryptedFile(uri);
  const second = retainDecryptedFile(uri);
  first();
  first(); // Releasing is idempotent.
  await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS);
  expect(mockFiles.has(uri)).toBe(true); // Includes the cold-start sweep at 5s.
  second();
  await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS - 1);
  const again = retainDecryptedFile(uri);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockFiles.has(uri)).toBe(true);
  again();
  await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS);
  expect(mockFiles.has(uri)).toBe(false);
});
it('cleans expired abandoned shares on the next launch without a new download', async () => {
  jest.useFakeTimers();
  const dir = `file:///cache/decrypted/${ownerDirName(A)}/`;
  mockFiles.set(dir, '');
  mockFiles.set(`${dir}file-old.bin`, 'plaintext');
  setDecryptedMediaOwner(A);
  await jest.advanceTimersByTimeAsync(5000);
  expect(mockFiles.has(`${dir}file-old.bin`)).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('bounds retained shares and cancels deferred cleanup when the account is wiped', async () => {
  jest.useFakeTimers();
  setDecryptedMediaOwner(A);
  const dir = `file:///cache/decrypted/${ownerDirName(A)}/`;
  for (let i = 0; i < 16; i++) {
    const uri = `${dir}file-${i}.bin`;
    mockFiles.set(uri, 'plaintext');
    retainDecryptedFile(uri)();
  }
  expect(() => retainDecryptedFile(`${dir}file-extra.bin`)).toThrow('Too many');
  await wipeDecryptedMediaForOwner(A);
  expect(filesUnder(A)).toEqual([]);
  expect(() => retainDecryptedFile(`${dir}file-new.bin`)()).not.toThrow();
});

it.each(['ciphertext hash', 'plaintext hash', 'authentication'] as const)(
  'surfaces a Marmot %s failure through the real decrypt/share/bubble path',
  async (failure) => {
    const key = new Uint8Array(32).fill(17);
    const { encrypted, attachment } = encryptMediaFile(PLAIN, key, {
      version: 'encrypted-media-v2',
      mediaType: 'application/pdf',
      filename: 'invoice.pdf',
      plaintextSha256: bytesToHex(sha256(PLAIN)),
    });
    const downloaded = encrypted.slice();
    if (failure === 'ciphertext hash') downloaded[0] ^= 1;
    const file = parseFileAttachment(
      encodeMarmotMediaUrl({
        url: URL_,
        version: attachment.version,
        mime: attachment.mediaType,
        filename: attachment.filename,
        nonceHex: attachment.nonce,
        keysHex: [failure === 'authentication' ? '00'.repeat(32) : bytesToHex(key)],
        plaintextSha256:
          failure === 'plaintext hash' ? '00'.repeat(32) : attachment.plaintextSha256,
        ciphertextSha256: attachment.ciphertextSha256,
      }),
    )!;
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => downloaded.slice().buffer });
    setDecryptedMediaOwner(A);
    await expect(resolveDecryptedMedia({ ...file, kind: 'file' })).rejects.toBeInstanceOf(
      FileVerificationError,
    );
    const ui = render(
      React.createElement(MessageFileBubble, {
        id: 'verify',
        file,
        fromMe: false,
        footer: null,
      }),
    );
    fireEvent.press(ui.getByTestId('file-share-verify'));
    await waitFor(() => expect(ui.getByText('messageBubble.fileVerificationFailed')).toBeTruthy());
    expect(ui.queryByText('messageBubble.fileShareFailed')).toBeNull();
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(filesUnder(A)).toEqual([]);
    expect(peekDecryptedMedia({ ...file, kind: 'file' })).toBeNull();
  },
  // The first render loads RN's native component implementations on a cold
  // Jest cache. Coverage instrumentation on CI can exceed the 5s unit-test
  // budget; allow the real decrypt/share/render integration path to finish.
  30_000,
);

it('exports identical bytes under the sanitized name and retains them for delayed recipient reads', async () => {
  jest.useFakeTimers();
  setDecryptedMediaOwner(A);
  const uri = `file:///cache/decrypted/${ownerDirName(A)}/file-export.bin`;
  const bytes = Buffer.from('invoice content').toString('base64');
  mockFiles.set(uri, bytes);
  const release = retainDecryptedFile(uri);
  const target = await namedFileExport(uri, '../invoice.pdf');
  expect(target).toBe(`${uri}.share/invoice.pdf`);
  expect(mockFiles.get(target)).toBe(bytes);
  release();
  await jest.advanceTimersByTimeAsync(5000);
  expect(mockFiles.get(target)).toBe(bytes);
  await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS);
  expect(mockFiles.has(target)).toBe(false);
  expect(mockFiles.has(uri)).toBe(false);
  jest.useRealTimers();
});
it('removes named exports on account wipe', async () => {
  setDecryptedMediaOwner(A);
  const uri = `file:///cache/decrypted/${ownerDirName(A)}/file-export.bin`;
  mockFiles.set(uri, 'YQ==');
  const release = retainDecryptedFile(uri);
  const target = await namedFileExport(uri, 'report.csv');
  await wipeDecryptedMediaForOwner(A);
  expect(mockFiles.has(target)).toBe(false);
  release();
});

it.each(['https://127.0.0.1/x', 'http://example.com/x', 'https://example.com:8443/x'])(
  'never fetches blocked encrypted media %s',
  async (url) => {
    setDecryptedMediaOwner(A);
    await expect(resolveDecryptedMedia({ ...ref, url })).rejects.toThrow('Blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it.each([0, -1, NaN, 1.5, 50 * 1024 * 1024 + 1])(
  'rejects invalid advertised size %s before fetching',
  async (size) => {
    setDecryptedMediaOwner(A);
    await expect(resolveDecryptedMedia({ ...ref, size })).rejects.toThrow('size');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('honours the advertised size on download', async () => {
  setDecryptedMediaOwner(A);
  await expect(resolveDecryptedMedia({ ...ref, size: 1 })).rejects.toThrow('limit');
  expect(filesUnder(A)).toEqual([]);
  expect(await resolveDecryptedMedia({ ...ref, size: sealed.ciphertext.length })).toContain(
    'file:///',
  );
});

it('keys identical basenames by URL, keys, nonce and declared Marmot hashes', () => {
  const key = mediaCacheKey(ref);
  expect(mediaCacheKey({ ...ref })).toBe(key);
  for (const other of [
    { ...ref, url: 'https://other.example/abc123' },
    { ...ref, keyHex: wrongKeys.keyHex },
    { ...ref, nonceHex: '00'.repeat(12) },
    {
      ...ref,
      marmot: {
        version: 'encrypted-media-v1' as const,
        keysHex: ['11'.repeat(32)],
        filename: 'photo.jpg',
        plaintextSha256: '22'.repeat(32),
        ciphertextSha256: '33'.repeat(32),
      },
    },
  ])
    expect(mediaCacheKey(other)).not.toBe(key);
});
it('a returning identity waits for its old folder deletion before writing new media', async () => {
  setDecryptedMediaOwner(A);
  const uri = await resolveDecryptedMedia(ref);
  let release!: () => void;
  const original = (deleteAsync as jest.Mock).getMockImplementation()!;
  (deleteAsync as jest.Mock).mockImplementationOnce(async (path: string) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await original(path);
  });
  setDecryptedMediaOwner(B);
  setDecryptedMediaOwner(A);
  const pending = resolveDecryptedMedia(ref);
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  release();
  expect(await pending).toBe(uri);
  expect(filesUnder(A)).toEqual([uri]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('checks declared ciphertext hashes before decrypting or publishing', async () => {
  setDecryptedMediaOwner(A);
  const hash = bytesToHex(sha256(sealed.ciphertext));
  const good = { ...ref, sha256: hash };
  const uri = await resolveDecryptedMedia(good);
  expect([...plaintextOf(uri)]).toEqual([...PLAIN]);
  for (const hash of ['00'.repeat(32), 'invalid', '']) {
    const bad = { ...ref, sha256: hash };
    expect(mediaCacheKey(bad)).not.toBe(mediaCacheKey(good));
    expect(peekDecryptedMedia(bad)).toBeNull();
    await expect(resolveDecryptedMedia(bad)).rejects.toThrow('hash mismatch');
  }
  expect(filesUnder(A)).toEqual([uri]);
});

it.each(['memory', 'disk'])(
  'rejects malformed hashes after warming the %s cache without a hash',
  async (cache) => {
    setDecryptedMediaOwner(A);
    const uri = await resolveDecryptedMedia(ref);
    if (cache === 'disk') clearDecryptedMediaMemory();
    (getInfoAsync as jest.Mock).mockClear();
    fetchMock.mockClear();
    for (const hash of ['', 'invalid', '00'.repeat(31), 'gg'.repeat(32)]) {
      const bad = { ...ref, sha256: hash };
      expect(peekDecryptedMedia(bad)).toBeNull();
      await expect(resolveDecryptedMedia(bad)).rejects.toThrow('hash mismatch');
      expect(mediaCacheKey(bad)).not.toBe(mediaCacheKey(ref));
    }
    expect(getInfoAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(filesUnder(A)).toEqual([uri]);
    expect(await resolveDecryptedMedia(ref)).toBe(uri);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('rejects a kind-15 that declares an empty hash, end to end (encode → parse → resolve)', async () => {
  setDecryptedMediaOwner(A);
  const meta = { url: URL_, mime: 'audio/mp4', keyHex: sealed.keyHex, nonceHex: sealed.nonceHex };
  // The same path a received kind-15 takes: nip17Unwrap encodes the `x` tag
  // into the `#lpe` URL, the bubble parses it back into a media ref.
  const toRef = (sha256?: string): EncryptedMediaRef => {
    const parsed = parseVoiceNote(encodeEncryptedFileUrl({ ...meta, sha256 }));
    if (!parsed?.encrypted) throw new Error('expected an encrypted voice note');
    return {
      url: parsed.url,
      kind: 'voice',
      mime: parsed.mime,
      keyHex: parsed.keyHex,
      nonceHex: parsed.nonceHex,
      ...(parsed.sha256 !== undefined ? { sha256: parsed.sha256 } : {}),
    };
  };
  const uri = await resolveDecryptedMedia(toRef(undefined));
  const empty = toRef('');
  expect(empty.sha256).toBe('');
  expect(mediaCacheKey(empty)).not.toBe(mediaCacheKey(toRef(undefined)));
  expect(peekDecryptedMedia(empty)).toBeNull();
  await expect(resolveDecryptedMedia(empty)).rejects.toThrow('hash mismatch');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(filesUnder(A)).toEqual([uri]);
  // A correct declared hash still resolves.
  await expect(
    resolveDecryptedMedia(toRef(bytesToHex(sha256(sealed.ciphertext)))),
  ).resolves.toMatch(/\.m4a$/);
});

it('decrypts and verifies a NIP-17 PDF, failing closed on a changed ciphertext hash', async () => {
  setDecryptedMediaOwner(A);
  const sealed = encryptFile(PLAIN);
  const file = parseFileAttachment(
    encodeEncryptedFileUrl({
      url: 'https://example.com/file.bin',
      mime: 'application/pdf',
      keyHex: sealed.keyHex,
      nonceHex: sealed.nonceHex,
      sha256: sealed.sha256Hex,
      size: sealed.ciphertext.length,
      filename: 'invoice.pdf',
    }),
  )!;
  (globalThis.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    arrayBuffer: async () => sealed.ciphertext.buffer,
  });
  const uri = await resolveDecryptedMedia({ ...file, kind: 'file' });
  expect(verifiedFileMetadata(uri)?.size).toBe(PLAIN.length);
  await expect(
    resolveDecryptedMedia({ ...file, kind: 'file', sha256: '00'.repeat(32) }),
  ).rejects.toBeInstanceOf(FileVerificationError);
});

it('allows hashless plain text URLs only with the explicit classifier flag, preserving imeta hash requirements', async () => {
  setDecryptedMediaOwner(A);
  const ref: EncryptedMediaRef = {
    url: 'https://example.com/a.pdf',
    kind: 'file',
    encrypted: false,
  };
  (globalThis.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    arrayBuffer: async () => PLAIN.buffer,
  });
  await expect(resolveDecryptedMedia(ref)).rejects.toBeInstanceOf(FileVerificationError);
  const uri = await resolveDecryptedMedia({ ...ref, plainUrl: true });
  expect(verifiedFileMetadata(uri)?.size).toBe(PLAIN.length);
});

it('does not fetch file bubbles from an unfollowed sender before a user tap', () => {
  const file = parseFileAttachment(
    encodeEncryptedFileUrl({
      url: 'https://example.com/file.bin',
      mime: 'application/pdf',
      keyHex: '11'.repeat(32),
      nonceHex: '22'.repeat(12),
      sha256: '33'.repeat(32),
    }),
  )!;
  render(
    React.createElement(MessageFileBubble, {
      id: 'dm-no-fetch',
      file,
      fromMe: false,
      footer: null,
    }),
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(Sharing.shareAsync).not.toHaveBeenCalled();
});

it('waits for native preview publication before wiping the account, then rejects its stale URI', async () => {
  setDecryptedMediaOwner(A);
  const uri = `file:///cache/decrypted/${ownerDirName(A)}/file-preview.bin`;
  mockFiles.set(uri, 'YQ==');
  let finish!: () => void;
  const rendering = publishDecryptedPreview(uri, async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockFiles.set(`${uri}.preview-480.png`, 'YQ==');
    return `${uri}.preview-480.png`;
  });
  const rejected = expect(rendering).rejects.toThrow(DecryptedMediaCancelledError);
  await Promise.resolve();
  let wiped = false;
  const wipe = wipeDecryptedMediaForOwner(A).then(() => {
    wiped = true;
  });
  await Promise.resolve();
  expect(wiped).toBe(false);
  finish();
  await rejected;
  await wipe;
  expect(filesUnder(A)).toEqual([]);
});
it('removes the derived preview when a decrypted file expires', async () => {
  const uri = 'file:///cache/decrypted/account/file-pdf.bin';
  mockFiles.set(uri, 'YQ==');
  mockFiles.set(`${uri}.preview-480.png`, 'YQ==');
  await deleteDecryptedFile(uri);
  expect(mockFiles.has(`${uri}.preview-480.png`)).toBe(false);
});

it('rejects a deferred attachment bound to the previous account before downloading', async () => {
  setDecryptedMediaOwner(A);
  setDecryptedMediaOwner(B);
  await expect(resolveDecryptedMedia(ref, A)).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('retires captured sessions on switches, round trips, and account wipes', async () => {
  setDecryptedMediaOwner(A);
  const session = captureDecryptedMediaSession();
  expect(session.owner).toBe(A);
  session.assertCurrent();
  setDecryptedMediaOwner(B);
  expect(() => session.assertCurrent()).toThrow(DecryptedMediaCancelledError);
  setDecryptedMediaOwner(A);
  expect(() => session.assertCurrent()).toThrow(DecryptedMediaCancelledError);
  await clearDecryptedMediaCache(A);
  const fresh = captureDecryptedMediaSession(A);
  await wipeDecryptedMediaForOwner(A);
  expect(() => fresh.assertCurrent()).toThrow(DecryptedMediaCancelledError);
  expect(() => captureDecryptedMediaSession().assertCurrent()).toThrow(
    DecryptedMediaCancelledError,
  );
});

it.each([false, true])(
  'cancels a real share during download (return to original account=%s)',
  async (roundTrip) => {
    setDecryptedMediaOwner(A);
    jest.mocked(Sharing.shareAsync).mockClear();
    let finish!: () => void;
    const download = jest.spyOn(remoteUrlPolicy, 'fetchBounded').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ bytes: new TextEncoder().encode('%PDF-1.7') } as never);
        }),
    );
    try {
      const sharing = shareFileAttachment(
        parsePlainFileAttachment('https://example.com/invoice.pdf')!,
        async () => true,
        jest.fn(),
      );
      const rejected = expect(sharing).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
      await waitFor(() => expect(download).toHaveBeenCalled());
      setDecryptedMediaOwner(B);
      if (roundTrip) setDecryptedMediaOwner(A);
      finish();
      await rejected;
      expect(download).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(Sharing.shareAsync).not.toHaveBeenCalled();
      expect(filesUnder(B)).toEqual([]);
    } finally {
      download.mockRestore();
    }
  },
);

it.each(['export', 'preview'])(
  'cancels a deferred %s after an account round trip',
  async (operation) => {
    setDecryptedMediaOwner(A);
    const uri = `file:///cache/decrypted/${ownerDirName(A)}/file-export.bin`;
    mockFiles.set(uri, 'YQ==');
    const release = retainDecryptedFile(uri);
    const render = jest.fn(async () => `${uri}.preview-480.png`);
    const pending =
      operation === 'export'
        ? namedFileExport(uri, 'invoice.pdf')
        : publishDecryptedPreview(uri, render);
    const rejected = expect(pending).rejects.toBeInstanceOf(DecryptedMediaCancelledError);
    setDecryptedMediaOwner(B);
    setDecryptedMediaOwner(A);
    await rejected;
    expect(render).not.toHaveBeenCalled();
    expect(mockFiles.has(`${uri}.share/invoice.pdf`)).toBe(false);
    release();
  },
);
