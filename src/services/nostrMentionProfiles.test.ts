import { __resetMentionProfilesForTests, subscribeMentionProfile } from './nostrMentionProfiles';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { querySyncAbortable } from './relayQuery';
import * as storage from './zapSenderProfileStorage';

jest.mock('./nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('./relayQuery', () => ({ querySyncAbortable: jest.fn() }));
jest.mock('./zapSenderProfileStorage', () => ({
  peekSync: jest.fn(() => null),
  getMany: jest.fn(async () => new Map()),
  setMany: jest.fn(),
  subscribeProfilesChanged: jest.fn(() => () => {}),
}));
const query = jest.mocked(querySyncAbortable);
const relays = Array.from({ length: 10 }, (_, i) => `wss://relay-${i}`);
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useFakeTimers();
  jest.clearAllMocks();
  __resetMentionProfilesForTests();
  query.mockResolvedValue([]);
});
afterEach(() => {
  __resetMentionProfilesForTests();
  jest.useRealTimers();
});

it('batches 200 distinct mentions, caps filters and relays, and deduplicates repeated pubkeys', async () => {
  const receivers = Array.from({ length: 200 }, () => jest.fn());
  receivers.forEach((receive, i) => subscribeMentionProfile(`${i}`, relays, receive));
  subscribeMentionProfile('0', relays, jest.fn());
  await jest.advanceTimersByTimeAsync(300);
  expect(query).toHaveBeenCalledTimes(4);
  expect(query.mock.calls.flatMap(([, , filter]) => filter.authors)).toHaveLength(200);
  for (const [, urls, filter, opts] of query.mock.calls) {
    expect(urls).toHaveLength(6);
    expect(filter.authors!.length).toBeLessThanOrEqual(64);
    expect(filter.limit).toBe(filter.authors!.length * 2);
    expect(opts.signal?.aborted).toBe(false);
  }
  receivers.forEach((receive) => expect(receive).toHaveBeenCalledTimes(1));
});

it('cancels queued work on blur and aborts an active batch only after its last owner leaves', async () => {
  const cancel = subscribeMentionProfile('queued', relays, jest.fn());
  cancel();
  await jest.advanceTimersByTimeAsync(60);
  expect(query).not.toHaveBeenCalled();
  let finish!: (events: never[]) => void;
  query.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const receive = jest.fn();
  const a = subscribeMentionProfile('a', relays, receive);
  const b = subscribeMentionProfile('b', relays, receive);
  await jest.advanceTimersByTimeAsync(60);
  const signal = query.mock.calls[0][3].signal!;
  a();
  expect(signal.aborted).toBe(false);
  b();
  expect(signal.aborted).toBe(true);
  finish([]);
  await jest.advanceTimersByTimeAsync(60);
  expect(receive).not.toHaveBeenCalled();
});

it('uses only matching cosmetic metadata and never persists unverified payment fields', async () => {
  query.mockResolvedValue([
    {
      kind: 0,
      pubkey: 'a',
      created_at: 1,
      content: JSON.stringify({ name: 'Alice', picture: 'avatar', lud16: 'forged@payment' }),
    },
    { kind: 0, pubkey: 'stranger', created_at: 2, content: '{"name":"Unsolicited"}' },
  ] as never);
  const receive = jest.fn();
  subscribeMentionProfile('a', relays, receive);
  await jest.advanceTimersByTimeAsync(60);
  expect(receive).toHaveBeenCalledWith({ name: 'Alice', picture: 'avatar' });
  expect(storage.setMany).not.toHaveBeenCalled();
  subscribeMentionProfile('a', relays, receive);
  await jest.advanceTimersByTimeAsync(60);
  expect(query).toHaveBeenCalledTimes(1);
});

it('requeues a returning owner skipped during disk lookup without delivering or caching a miss', async () => {
  let finishDisk!: (profiles: Map<string, never>) => void;
  let finishQuery!: (events: never[]) => void;
  jest.mocked(storage.getMany).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDisk = resolve;
      }),
  );
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishQuery = resolve;
      }),
  );
  const receiveA = jest.fn();
  const receiveB = jest.fn();
  subscribeMentionProfile('a', relays, receiveA);
  const blurB = subscribeMentionProfile('b', relays, receiveB);
  await jest.advanceTimersByTimeAsync(60);
  blurB();
  finishDisk(new Map<string, never>());
  await jest.advanceTimersByTimeAsync(0);
  expect(query.mock.calls[0][2].authors).toEqual(['a']);
  subscribeMentionProfile('b', relays, receiveB);
  finishQuery([]);
  await jest.advanceTimersByTimeAsync(0);
  expect(receiveA).toHaveBeenCalledTimes(1);
  expect(receiveB).not.toHaveBeenCalled();
  query.mockResolvedValue([
    { kind: 0, pubkey: 'b', created_at: 1, content: '{"name":"Bob"}' },
  ] as never);
  await jest.advanceTimersByTimeAsync(60);
  expect(query.mock.calls[1][2].authors).toEqual(['b']);
  expect(receiveB).toHaveBeenCalledTimes(1);
  expect(receiveB).toHaveBeenCalledWith({ name: 'Bob', picture: null });
});

it('retries only missing authors once on write relays and indexers in a shared batch', async () => {
  query
    .mockResolvedValueOnce([
      { kind: 0, pubkey: 'a', created_at: 1, content: '{"name":"Alice"}' },
    ] as never)
    .mockResolvedValueOnce([
      { kind: 0, pubkey: 'b', created_at: 1, content: '{"display_name":"Bob"}' },
    ] as never);
  const receive = jest.fn();
  const retry = ['wss://write', 'wss://purplepag.es', 'wss://user.kindpag.es'];
  subscribeMentionProfile('a', relays, receive, retry);
  subscribeMentionProfile('b', relays, receive, retry);
  subscribeMentionProfile('c', relays, receive, retry);
  await jest.advanceTimersByTimeAsync(1000);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1][1]).toEqual(retry);
  expect(query.mock.calls[1][2].authors).toEqual(['b', 'c']);
  expect(query.mock.calls[1][3].signal).toBe(query.mock.calls[0][3].signal);
  expect(receive).toHaveBeenCalledWith({ name: 'Bob', picture: null });
  subscribeMentionProfile('c', relays, jest.fn(), retry);
  await jest.advanceTimersByTimeAsync(1000);
  expect(query).toHaveBeenCalledTimes(2);
});

it('coalesces late member/cache writes for already-subscribed consumers', async () => {
  const receive = jest.fn();
  subscribeMentionProfile('a', relays, receive);
  await jest.advanceTimersByTimeAsync(60);
  const changed = jest.mocked(storage.subscribeProfilesChanged).mock.calls.at(-1)![0];
  jest
    .mocked(storage.peekSync)
    .mockReturnValueOnce({ name: 'Late member', picture: null } as never);
  receive.mockClear();
  changed();
  changed();
  changed();
  expect(receive).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(60);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(receive).toHaveBeenCalledWith({ name: 'Late member', picture: null });
});

it('tries the fallback after a failed read query and aborts it on the last blur', async () => {
  query.mockRejectedValueOnce(new Error('read relay disconnected'));
  query.mockImplementationOnce(
    (_pool, _relays, _filter, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
  );
  const receive = jest.fn();
  const blur = subscribeMentionProfile('a', relays, receive, ['wss://write']);
  await jest.advanceTimersByTimeAsync(60);
  expect(query).toHaveBeenCalledTimes(2);
  const signal = query.mock.calls[1][3].signal!;
  blur();
  expect(signal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(1000);
  expect(receive).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(2);
});

it('keeps a late cache name when an in-flight relay miss completes', async () => {
  let finish!: (events: never[]) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const receive = jest.fn();
  subscribeMentionProfile('a', relays, receive);
  await jest.advanceTimersByTimeAsync(60);
  jest.mocked(storage.peekSync).mockReturnValueOnce({ name: 'Late local', picture: null } as never);
  finish([]);
  await jest.advanceTimersByTimeAsync(0);
  expect(receive).toHaveBeenLastCalledWith({ name: 'Late local', picture: null });
});

it('uses the Messages non-follow profile cache before relay lookup', async () => {
  await AsyncStorage.setItem(
    'nonfollow_profiles_viewer',
    JSON.stringify({
      a: { npub: 'npub-test', displayName: 'Cached Messages peer', lud16: 'untrusted' },
    }),
  );
  const receive = jest.fn();
  subscribeMentionProfile('a', relays, receive, ['wss://write'], 'viewer');
  await jest.advanceTimersByTimeAsync(60);
  expect(receive).toHaveBeenCalledWith({ name: 'Cached Messages peer', picture: null });
  expect(query).not.toHaveBeenCalled();
});

it('observes the screen-owned member batch without querying and receives its cache write', async () => {
  const receive = jest.fn();
  const cancel = subscribeMentionProfile('member', relays, receive, [], null, false);
  await jest.advanceTimersByTimeAsync(120);
  expect(query).not.toHaveBeenCalled();
  expect(storage.getMany).not.toHaveBeenCalled();
  expect(receive).not.toHaveBeenCalled();

  jest.mocked(storage.peekSync).mockReturnValueOnce({
    name: 'Member name',
    displayName: null,
    picture: null,
  } as never);
  const notify = jest.mocked(storage.subscribeProfilesChanged).mock.calls[0][0];
  notify();
  await jest.advanceTimersByTimeAsync(60);
  expect(receive).toHaveBeenCalledWith({ name: 'Member name', picture: null });
  expect(query).not.toHaveBeenCalled();
  cancel();
});

it('keeps mention relay configuration when a cache-only sender row subscribes', async () => {
  subscribeMentionProfile('mention', ['wss://mention'], jest.fn(), ['wss://retry']);
  subscribeMentionProfile('member', ['wss://other'], jest.fn(), [], null, false);
  await jest.advanceTimersByTimeAsync(120);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0][1]).toEqual(['wss://mention']);
  expect(query.mock.calls[1][1]).toEqual(['wss://retry']);
  expect(query.mock.calls[0][2].authors).toEqual(['mention']);
});

it('cancels queued lookup when only a cache-only listener remains and still observes storage', async () => {
  const blur = subscribeMentionProfile('a', relays, jest.fn());
  const receive = jest.fn();
  const stopObserving = subscribeMentionProfile('a', relays, receive, [], null, false);
  blur();
  await jest.advanceTimersByTimeAsync(120);
  expect(storage.getMany).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();

  jest
    .mocked(storage.peekSync)
    .mockReturnValueOnce({ name: 'Cached Alice', picture: null } as never);
  jest.mocked(storage.subscribeProfilesChanged).mock.calls.at(-1)![0]();
  await jest.advanceTimersByTimeAsync(60);
  expect(receive).toHaveBeenCalledWith({ name: 'Cached Alice', picture: null });
  stopObserving();
});

it('aborts active work after the last lookup listener leaves despite cache-only listeners', async () => {
  query.mockImplementationOnce(
    (_pool, _relays, _filter, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
  );
  const first = subscribeMentionProfile('a', relays, jest.fn(), ['wss://retry']);
  const second = subscribeMentionProfile('a', relays, jest.fn(), ['wss://retry']);
  const receive = jest.fn();
  subscribeMentionProfile('a', relays, receive, [], null, false);
  const stopObserving = subscribeMentionProfile('a', relays, jest.fn(), [], null, false);
  await jest.advanceTimersByTimeAsync(60);
  const signal = query.mock.calls[0][3].signal!;
  stopObserving();
  first();
  first();
  expect(signal.aborted).toBe(false);
  second();
  expect(signal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(120);
  expect(query).toHaveBeenCalledTimes(1);
  expect(receive).not.toHaveBeenCalled();
});

it('excludes cache-only keys after disk lookup and from retries while other lookups remain', async () => {
  let finishDisk!: (profiles: Map<string, never>) => void;
  let finishQuery!: (events: never[]) => void;
  jest.mocked(storage.getMany).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDisk = resolve;
      }),
  );
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishQuery = resolve;
      }),
  );
  subscribeMentionProfile('a', relays, jest.fn(), ['wss://retry']);
  const blurB = subscribeMentionProfile('b', relays, jest.fn(), ['wss://retry']);
  const blurC = subscribeMentionProfile('c', relays, jest.fn(), ['wss://retry']);
  subscribeMentionProfile('b', relays, jest.fn(), [], null, false);
  subscribeMentionProfile('c', relays, jest.fn(), [], null, false);
  await jest.advanceTimersByTimeAsync(60);
  blurB();
  finishDisk(new Map<string, never>());
  await jest.advanceTimersByTimeAsync(0);
  expect(query.mock.calls[0][2].authors).toEqual(['a', 'c']);
  blurC();
  expect(query.mock.calls[0][3].signal!.aborted).toBe(false);
  finishQuery([]);
  await jest.advanceTimersByTimeAsync(120);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1][2].authors).toEqual(['a']);
  expect(query.mock.calls[1][1]).toEqual(['wss://retry']);
});
