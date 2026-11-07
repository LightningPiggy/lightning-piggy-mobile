import { setRemoteMediaOwner } from './remoteMediaCache';
import { fetch as expoFetch } from 'expo/fetch';
import {
  getInfoAsync,
  writeAsStringAsync,
  moveAsync,
  deleteAsync,
  readDirectoryAsync,
} from 'expo-file-system/legacy';
import { resolveRemoteMedia, evictRemoteMedia, wipeRemoteMediaForOwner } from './remoteMediaCache';
import { PREVIEW_IMAGE_MAX_BYTES } from '../utils/remoteUrlPolicy';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
  readDirectoryAsync: jest.fn(async () => []),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  writeAsStringAsync: jest.fn(async () => {}),
}));
const mockFetch = expoFetch as unknown as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(writeAsStringAsync).mockImplementation(async () => {});
  jest.mocked(deleteAsync).mockImplementation(async () => {});
  setRemoteMediaOwner(null);
  setRemoteMediaOwner('reader');
  jest
    .mocked(getInfoAsync)
    .mockResolvedValue({ exists: false, isDirectory: false } as Awaited<
      ReturnType<typeof getInfoAsync>
    >);
});
it.each(['https://127.0.0.1/a.jpg', 'http://example.com/a.jpg', 'https://example.com:8443/a.jpg'])(
  'never fetches blocked plain media or og:image %s',
  async (url) => {
    await expect(resolveRemoteMedia(url)).rejects.toThrow('Blocked');
    await expect(resolveRemoteMedia(url, PREVIEW_IMAGE_MAX_BYTES)).rejects.toThrow('Blocked');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writeAsStringAsync).not.toHaveBeenCalled();
  },
);
it('downloads plain media once and supplies a local URI to the renderer', async () => {
  let sent = false;
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: new Uint8Array([1, 2, 3]) };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  });
  const [a, b] = await Promise.all([
    resolveRemoteMedia('https://example.com/a.jpg'),
    resolveRemoteMedia('https://example.com/a.jpg'),
  ]);
  expect(a).toBe(b);
  expect(a).toMatch(/^file:\/\/\/cache\/remote-media-/);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(writeAsStringAsync).toHaveBeenCalledWith(expect.stringContaining(`${a}.`), 'AQID', {
    encoding: 'base64',
  });
});
it('rejects oversized preview images without writing or caching them', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => String(PREVIEW_IMAGE_MAX_BYTES + 1) },
  });
  await expect(
    resolveRemoteMedia('https://example.com/cover.png', PREVIEW_IMAGE_MAX_BYTES),
  ).rejects.toThrow('limit');
  expect(writeAsStringAsync).not.toHaveBeenCalled();
});

function successfulFetch() {
  mockFetch.mockImplementation(async () => {
    let sent = false;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            sent
              ? { done: true }
              : ((sent = true), { done: false, value: new Uint8Array([1, 2, 3]) }),
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    };
  });
}

it('removes partial writes and retries without accepting an incomplete cache file', async () => {
  successfulFetch();
  const files = new Set<string>();
  jest
    .mocked(getInfoAsync)
    .mockImplementation(
      async (uri) =>
        ({ exists: files.has(uri), isDirectory: false }) as Awaited<
          ReturnType<typeof getInfoAsync>
        >,
    );
  jest.mocked(deleteAsync).mockImplementation(async (uri) => {
    files.delete(uri);
  });
  jest.mocked(writeAsStringAsync).mockImplementationOnce(async (uri) => {
    files.add(uri);
    throw new Error('disk write failed');
  });
  await expect(resolveRemoteMedia('https://example.com/retry.jpg')).rejects.toThrow(
    'disk write failed',
  );
  expect(files.size).toBe(0);
  const uri = await resolveRemoteMedia('https://example.com/retry.jpg');
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(moveAsync).toHaveBeenCalledWith({ from: expect.stringContaining(`${uri}.`), to: uri });
});

it('isolates accounts and wipes only the removed owner', async () => {
  successfulFetch();
  const a = await resolveRemoteMedia('https://example.com/shared.jpg');
  setRemoteMediaOwner('other');
  const b = await resolveRemoteMedia('https://example.com/shared.jpg');
  expect(a).not.toBe(b);
  await wipeRemoteMediaForOwner('reader');
  expect(deleteAsync).toHaveBeenCalledWith(a.slice(0, a.lastIndexOf('/') + 1), {
    idempotent: true,
  });
  expect(deleteAsync).not.toHaveBeenCalledWith(
    b.slice(0, b.lastIndexOf('/') + 1),
    expect.anything(),
  );
});

it('waits for an in-flight write and prevents plaintext publication after logout', async () => {
  successfulFetch();
  let finish!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest.mocked(writeAsStringAsync).mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const download = resolveRemoteMedia('https://example.com/slow.jpg');
  const rejected = expect(download).rejects.toThrow('cancelled');
  await writing;
  let wiped = false;
  const wipe = wipeRemoteMediaForOwner('reader').then(() => {
    wiped = true;
  });
  await Promise.resolve();
  expect(wiped).toBe(false);
  await expect(resolveRemoteMedia('https://example.com/late.jpg')).rejects.toThrow('unavailable');
  finish();
  await rejected;
  await wipe;
  expect(moveAsync).not.toHaveBeenCalled();
  expect(deleteAsync).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), { idempotent: true });
});

it('cancels a download that finishes after account removal before writing', async () => {
  let finish!: (response: unknown) => void;
  mockFetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const download = resolveRemoteMedia('https://example.com/network.jpg');
  const rejected = expect(download).rejects.toThrow('cancelled');
  await Promise.resolve();
  await Promise.resolve();
  await wipeRemoteMediaForOwner('reader');
  finish({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => ({ done: true }),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  });
  await rejected;
  expect(writeAsStringAsync).not.toHaveBeenCalled();
});

it('waits for a move already in progress before deleting the account folder', async () => {
  successfulFetch();
  let finish!: () => void;
  let started!: () => void;
  const moving = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest.mocked(moveAsync).mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const download = resolveRemoteMedia('https://example.com/moving.jpg');
  const rejected = expect(download).rejects.toThrow('cancelled');
  await moving;
  const wipe = wipeRemoteMediaForOwner('reader');
  expect(deleteAsync).not.toHaveBeenCalled();
  finish();
  await rejected;
  await wipe;
  const finalUri = jest.mocked(moveAsync).mock.calls[0][0].to;
  expect(deleteAsync).toHaveBeenLastCalledWith(finalUri.slice(0, finalUri.lastIndexOf('/') + 1), {
    idempotent: true,
  });
});

it('removes legacy unscoped plaintext files on account removal', async () => {
  const legacy = `remote-${'a'.repeat(64)}`;
  jest.mocked(readDirectoryAsync).mockResolvedValueOnce([legacy, 'other-cache']);
  await wipeRemoteMediaForOwner('reader');
  expect(deleteAsync).toHaveBeenCalledWith(`file:///cache/${legacy}`, { idempotent: true });
  expect(deleteAsync).not.toHaveBeenCalledWith('file:///cache/other-cache', expect.anything());
});

it('evicts exactly the cached file for a URL, so the next resolve downloads it again', async () => {
  const uri = await (async () => {
    let sent = false;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: new Uint8Array([1, 2, 3]) };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    });
    return resolveRemoteMedia('https://example.com/broken.jpg');
  })();
  jest.mocked(deleteAsync).mockClear();
  await evictRemoteMedia('https://example.com/broken.jpg');
  expect(deleteAsync).toHaveBeenCalledTimes(1);
  expect(deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
  // A blocked URL evicts nothing.
  await evictRemoteMedia('https://127.0.0.1/x.jpg');
  expect(deleteAsync).toHaveBeenCalledTimes(1);
});

it("never lets a stale decode error delete another view's fresh download of the same URL", async () => {
  const url = 'https://example.com/shared.jpg';
  mockFetch.mockImplementation(async () => {
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
            return { done: false, value: new Uint8Array([1, 2, 3]) };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    };
  });
  const now = jest.spyOn(Date, 'now');
  // Two thumbnails of one URL resolve the same (corrupt) copy at t=1000.
  now.mockReturnValue(1000);
  const uri = await resolveRemoteMedia(url);
  // Thumbnail A reports it broken and re-downloads a good copy at t=2000.
  now.mockReturnValue(2000);
  await evictRemoteMedia(url, undefined, 1000);
  await resolveRemoteMedia(url);
  jest.mocked(deleteAsync).mockClear();
  // Thumbnail B's late error for the copy it got at t=1000 leaves it alone...
  await evictRemoteMedia(url, undefined, 1000);
  expect(deleteAsync).not.toHaveBeenCalled();
  // ...while an error against the current copy still evicts it.
  await evictRemoteMedia(url, undefined, 2000);
  expect(deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
  now.mockRestore();
});
