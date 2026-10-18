import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { setRelayAuthAccount } from './relayAuth';
import { SimplePool } from 'nostr-tools/pool';
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { withRelayHealth } from './healthAwarePool';
import { querySyncAbortable } from './relayQuery';
import { openRelayReq } from './relayReqTransport';

jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
jest.mock('./relayHealth', () => ({
  selectHealthyRelays: (urls: string[]) => urls,
  noteNetworkActivity: jest.fn(),
}));
class TestPool extends withRelayHealth(SimplePool) {}
const url = 'wss://transport.example/';

test.each(['connection failed', 'connection timed out'])(
  'rejected connection promise (%s) rejects the read instead of succeeding empty',
  async (reason) => {
    const pool = new TestPool();
    jest.spyOn(pool, 'ensureRelay').mockRejectedValue(new Error(reason));
    await expect(
      querySyncAbortable(pool, [url], { kinds: [0] }, { rejectOnAllRelaysFailure: true }),
    ).rejects.toThrow('All relays failed to connect');
    pool.destroy();
  },
);

test('rejected AUTH promise rejects the read instead of succeeding empty', async () => {
  const pool = new TestPool();
  const relay = new AbstractRelay(url, { verifyEvent: (() => true) as never });
  Object.assign(relay, {
    challenge: 'test-challenge',
    _connected: true,
    connectionPromise: Promise.resolve(),
  });
  const secret = new Uint8Array(32).fill(2);
  setCurrentUserPubkey(getPublicKey(secret));
  jest.spyOn(relay, 'send').mockResolvedValue();
  jest.spyOn(relay, 'auth').mockRejectedValue(new Error('auth timed out'));
  jest.spyOn(pool, 'ensureRelay').mockResolvedValue(relay);
  setRelayAuthAccount({
    pubkey: getPublicKey(secret),
    signerType: 'nsec',
    ownRelays: [],
    sign: async (event) => finalizeEvent(event, secret),
  });
  const result = querySyncAbortable(
    pool,
    [url],
    { kinds: [0] },
    { rejectOnAllRelaysFailure: true },
  );
  const assertion = expect(result).rejects.toThrow('All relays failed to connect');
  await Promise.resolve();
  const sub = [...relay.openSubs.values()][0];
  sub.close('auth-required: authenticate first');
  await assertion;
  expect(relay.auth).toHaveBeenCalledTimes(1);
  expect(relay.openSubs.size).toBe(0);
  pool.destroy();
});

beforeEach(() => jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }));
afterEach(() => {
  setRelayAuthAccount(null);
  setCurrentUserPubkey(null);
  jest.useRealTimers();
});

test.each([
  ...['query', 'raw subscription'].flatMap((path) =>
    [1000, 5000].flatMap((delay) =>
      [
        'auth-required: authenticate first',
        'ERROR: auth-required: this event may only be read by its recipients',
        'eRrOr: AUTH-REQUIRED: authenticate first',
      ].map((reason) => [path, delay, reason] as const),
    ),
  ),
])(
  'nsec auto-auth re-arms %s after %i ms for %s and ignores the retired EOSE timer',
  async (path, signDelay, reason) => {
    const secret = new Uint8Array(32).fill(3);
    const pubkey = getPublicKey(secret);
    setCurrentUserPubkey(pubkey);
    const sign = jest.fn(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, signDelay as number));
      return finalizeEvent(event, secret);
    });
    setRelayAuthAccount({ pubkey, signerType: 'nsec', ownRelays: [], sign });
    const pool = new TestPool();
    const relay = new AbstractRelay(url, { verifyEvent: (() => true) as never });
    Object.assign(relay, {
      _connected: true,
      connectionPromise: Promise.resolve(),
    });
    const send = jest.spyOn(relay, 'send').mockImplementation(async (message) => {
      const [type, event] = JSON.parse(message);
      if (type === 'AUTH') {
        const state = relay as unknown as {
          openEventPublishes: Map<
            string,
            { resolve: (reason: string) => void; timeout: ReturnType<typeof setTimeout> }
          >;
        };
        const pending = state.openEventPublishes.get(event.id)!;
        clearTimeout(pending.timeout);
        pending.resolve('authenticated');
        state.openEventPublishes.delete(event.id);
      }
    });
    Object.assign(relay, { ws: { readyState: 1, send } });
    // The relay challenges on connect, before any REQ or CLOSED. The SDK
    // retains it, but the app must wait for auth-required before signing.
    relay._onmessage({ data: JSON.stringify(['AUTH', 'test-challenge']) } as MessageEvent);
    expect(sign).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    jest.spyOn(pool, 'ensureRelay').mockResolvedValue(relay);
    const event = finalizeEvent({ kind: 4, tags: [], content: 'DM', created_at: 1 }, secret);
    const received = jest.fn();
    const result =
      path === 'query'
        ? querySyncAbortable(pool, [url], { kinds: [4] }, {})
        : Promise.resolve(pool.subscribeRelay(relay, [{ kinds: [4] }], { onevent: received }, url));
    await Promise.resolve();
    const original = [...relay.openSubs.values()][0];
    relay._onmessage({
      data: JSON.stringify(['CLOSED', original.id, reason]),
    } as MessageEvent);
    await jest.advanceTimersByTimeAsync(signDelay as number);
    // Flush signing, SDK AUTH/OK and transport continuation.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          ['relay', url],
          ['challenge', 'test-challenge'],
        ],
      }),
    );
    expect(send.mock.calls.filter(([message]) => message.startsWith('["AUTH"'))).toHaveLength(1);
    expect(send.mock.calls.filter(([message]) => message.startsWith('["REQ"'))).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(Math.max(0, 4500 - (signDelay as number)));
    const retried = [...relay.openSubs.values()][0];
    expect(retried).toBeDefined();
    expect(retried).not.toBe(original);
    retried.onevent(event);
    retried.receivedEose();
    if (path === 'query') expect(await result).toEqual([event]);
    else expect(received).toHaveBeenCalledWith(event);
    pool.destroy();
  },
);

test.each([
  'policy: auth-required: authenticate first',
  'ERROR: policy: auth-required: authenticate first',
  'not-auth-required: authenticate first',
])('CLOSED %s never prompts a remote signer', async (reason) => {
  const secret = new Uint8Array(32).fill(5);
  const pubkey = getPublicKey(secret);
  setCurrentUserPubkey(pubkey);
  const sign = jest.fn(async (event) => finalizeEvent(event, secret));
  setRelayAuthAccount({ pubkey, signerType: 'nip46', ownRelays: [url], sign });
  const pool = new TestPool();
  const relay = new AbstractRelay(url, { verifyEvent: (() => true) as never });
  Object.assign(relay, {
    challenge: 'test-challenge',
    _connected: true,
    connectionPromise: Promise.resolve(),
  });
  jest.spyOn(relay, 'send').mockResolvedValue();
  const auth = jest.spyOn(relay, 'auth').mockResolvedValue('ok');
  const onclose = jest.fn();
  const request = openRelayReq(pool, url, [{ kinds: [4] }], { onclose }, relay);
  [...relay.openSubs.values()][0].close(reason);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(auth).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
  expect(onclose).toHaveBeenCalledWith([reason]);
  request.close();
  pool.destroy();
});

test.each([
  'auth-required: again',
  'ERROR: auth-required: this event may only be read by its recipients',
  'restricted: not allowed',
  'ERROR: restricted: not allowed',
])('CLOSED %s after successful AUTH terminates without looping', async (reason) => {
  const secret = new Uint8Array(32).fill(4);
  const pubkey = getPublicKey(secret);
  setCurrentUserPubkey(pubkey);
  const sign = jest.fn(async (event) => finalizeEvent(event, secret));
  setRelayAuthAccount({ pubkey, signerType: 'nsec', ownRelays: [], sign });
  const pool = new TestPool();
  const relay = new AbstractRelay(url, { verifyEvent: (() => true) as never });
  Object.assign(relay, {
    challenge: 'test-challenge',
    _connected: true,
    connectionPromise: Promise.resolve(),
  });
  jest.spyOn(relay, 'send').mockResolvedValue();
  jest.spyOn(relay, 'auth').mockResolvedValue('ok');
  jest.spyOn(pool, 'ensureRelay').mockResolvedValue(relay);
  const result = querySyncAbortable(
    pool,
    [url],
    { kinds: [4] },
    { rejectOnAllRelaysFailure: true },
  );
  const assertion = expect(result).rejects.toThrow('All relays failed');
  await Promise.resolve();
  [...relay.openSubs.values()][0].close('auth-required: first');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  [...relay.openSubs.values()][0].close(reason);
  await assertion;
  expect(sign).toHaveBeenCalledTimes(1);
  expect(relay.auth).toHaveBeenCalledTimes(1);
  pool.destroy();
});
