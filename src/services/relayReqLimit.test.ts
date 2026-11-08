import * as expoFetch from 'expo/fetch';
import { discoverRelayReqLimit } from './relayReqLimit';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { TEST_ACCOUNT_PUBKEYS } from '../config/testRelayLockdown';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

beforeEach(() => jest.mocked(expoFetch.fetch).mockReset());
afterEach(() => {
  jest.restoreAllMocks();
  setCurrentUserPubkey(null);
});

test('test accounts in lockdown never make a NIP-11 request', async () => {
  const fetch = jest.spyOn(expoFetch, 'fetch');
  setCurrentUserPubkey([...TEST_ACCOUNT_PUBKEYS][0]);
  expect(await discoverRelayReqLimit('wss://lockdown.example.com/')).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

test('lockdown beginning before the deferred fetch runs sends no request', async () => {
  const fetch = jest.spyOn(expoFetch, 'fetch');
  const pending = discoverRelayReqLimit('wss://late.example.com/');
  setCurrentUserPubkey([...TEST_ACCOUNT_PUBKEYS][0]);
  expect(await pending).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

test('lockdown beginning during an in-flight request aborts it', async () => {
  let signal: AbortSignal | undefined;
  jest.spyOn(expoFetch, 'fetch').mockImplementation(((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  }) as unknown as typeof expoFetch.fetch);
  const pending = discoverRelayReqLimit('wss://slow.example.com/');
  await Promise.resolve();
  await Promise.resolve();
  expect(signal?.aborted).toBe(false);
  setCurrentUserPubkey([...TEST_ACCOUNT_PUBKEYS][0]);
  expect(signal?.aborted).toBe(true);
  expect(await pending).toBeUndefined();
});

test('NIP-11 discovery uses HTTPS, advertises NIP-11, caches and respects a smaller max', async () => {
  const fetch = (
    jest.spyOn(expoFetch, 'fetch') as unknown as jest.MockedFunction<typeof global.fetch>
  ).mockResolvedValue({
    ok: true,
    json: async () => ({ limitation: { max_subscriptions: 3 } }),
  } as Response);
  expect(await discoverRelayReqLimit('wss://relay.example.com/')).toBe(3);
  expect(await discoverRelayReqLimit('wss://relay.example.com/')).toBe(3);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    'https://relay.example.com/',
    expect.objectContaining({
      headers: { Accept: 'application/nostr+json' },
      signal: expect.anything(),
    }),
  );
});

test('bad documents and failures keep the conservative default, private relays are never fetched', async () => {
  const fetch = (
    jest.spyOn(expoFetch, 'fetch') as unknown as jest.MockedFunction<typeof global.fetch>
  ).mockResolvedValue({
    ok: true,
    json: async () => ({ limitation: { max_subscriptions: -1 } }),
  } as Response);
  expect(await discoverRelayReqLimit('wss://invalid.example.com/')).toBeUndefined();
  fetch.mockRejectedValueOnce(new Error('offline'));
  expect(await discoverRelayReqLimit('wss://offline.example.com/')).toBeUndefined();
  expect(await discoverRelayReqLimit('wss://127.0.0.1/')).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('concurrency is bounded to two and generous relay limits do not raise the app cap', async () => {
  const resolvers: ((value: Response) => void)[] = [];
  const fetch = (
    jest.spyOn(expoFetch, 'fetch') as unknown as jest.MockedFunction<typeof global.fetch>
  ).mockImplementation(
    () =>
      new Promise((r) => {
        resolvers.push(r);
      }),
  );
  const a = discoverRelayReqLimit('wss://a.example.com/');
  const b = discoverRelayReqLimit('wss://b.example.com/');
  expect(await discoverRelayReqLimit('wss://c.example.com/')).toBeUndefined();
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(2);
  // Both concurrent fetches must settle; use their own resolvers.
  for (const resolve of resolvers)
    resolve({
      ok: true,
      json: async () => ({ limitation: { max_subscriptions: 100 } }),
    } as Response);
  expect(await b).toBe(10);
  expect(await a).toBe(10);
});

test.each(['http://127.0.0.1/admin', 'http://192.168.1.1/admin'])(
  'NIP-11 discovery refuses redirects to %s without requesting the destination',
  async (destination) => {
    const requested: string[] = [];
    const fetch = (
      jest.spyOn(expoFetch, 'fetch') as unknown as jest.MockedFunction<typeof global.fetch>
    ).mockImplementation(async (input, init) => {
      requested.push(String(input));
      // Model fetch's default automatic redirect, including its destination
      // request, and the rejection required by redirect: 'error'.
      if (init?.redirect === 'error') throw new TypeError('Redirect refused');
      requested.push(destination);
      return {
        ok: true,
        json: async () => ({ limitation: { max_subscriptions: 1 } }),
      } as Response;
    });
    const url = `wss://redirect-${destination.includes('127') ? 'loopback' : 'private'}.example.com/`;
    expect(await discoverRelayReqLimit(url)).toBeUndefined();
    expect(requested).toEqual([url.replace(/^wss:/, 'https:')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      requested[0],
      expect.objectContaining({ redirect: 'error' }),
    );
  },
);
