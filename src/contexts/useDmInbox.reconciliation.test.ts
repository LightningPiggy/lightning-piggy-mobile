/**
 * Account-switch scoping for the DM inbox: one account's conversations must
 * never render under another (accounts share a phone in a family app).
 */
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';
import { AmberSignerError } from '../services/amberErrors';
import { requestNip04Decrypt } from '../services/amberService';
import { InteractionManager } from 'react-native';
import { scheduleColdStartBackfill } from './dmColdStartBackfill';
import { COLD_INITIAL_WRAP_LIMIT } from './nostrDmCache';
import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureDmStoreMigrated } from './dmStoreMigrationRunner';
import { nip46DecryptNip04 } from './nip46DmDecrypt';
import { ingestInboxNip17ForSigner } from './inboxNip17Ingest';
import { selectKnownEventIds, upsertDmMessages, type DmMessageRow } from '../services/dmDb';
import { Kind4RetryStore } from './kind4RetryStore';
import { nip04PlaintextCache } from './nostrSecretKeyCache';
import { DECRYPT_YIELD_EVERY } from './nostrDecryptPacing';
import type { RawDmEvent, RawGiftWrapEvent } from '../services/nostrService';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { loadInboxEntries } from '../services/dmInbox';
import { fetchInboxDmEvents } from '../services/nostrService';
import { useDmInbox, type UseDmInboxOptions } from './useDmInbox';

jest.mock('../services/nostrService', () => ({ fetchInboxDmEvents: jest.fn() }));
jest.mock('../services/amberService', () => ({ requestNip04Decrypt: jest.fn() }));
jest.mock('./nip46DmDecrypt', () => ({ nip46DecryptNip04: jest.fn() }));
jest.mock('./nostrSecretKeyCache', () => ({
  nip04PlaintextCache: new (jest.requireActual('../utils/lru').LRUCache)({ max: 1000 }),
  getMemoisedSecretKey: jest.fn(),
}));
jest.mock('./inboxNip17Ingest', () => ({ ingestInboxNip17ForSigner: jest.fn(async () => null) }));
jest.mock('../services/dmInbox', () => ({ loadInboxEntries: jest.fn() }));
jest.mock('../services/dmDb', () => ({
  ...jest.requireActual('../services/dmDb'),
  selectKnownEventIds: jest.fn(async () => new Set()),
  upsertDmMessages: jest.fn(async () => undefined),
  updateDmDeliveryStatuses: jest.fn(async () => undefined),
  hasStoredWraps: jest.fn(async () => true),
  getConversationMessages: jest.fn(async () => []),
}));
jest.mock('./dmStoreMigrationRunner', () => ({ ensureDmStoreMigrated: jest.fn(async () => {}) }));
jest.mock('./nostrLiveDmSub', () => ({ startLiveDmSubscription: jest.fn(() => () => {}) }));
jest.mock('./nostrFetchConversation', () => ({ fetchConversationFor: jest.fn() }));
jest.mock('./conversationReadThrough', () => ({ loadInitialConversation: jest.fn() }));
jest.mock('./dmColdStartBackfill', () => ({ scheduleColdStartBackfill: jest.fn() }));
jest.mock('./dmDeliveryStorePersistence', () => ({
  bindDmDeliveryStorePersistence: jest.fn(async () => () => {}),
}));
jest.mock('./useMarmotDmInbound', () => ({ useMarmotDmInbound: jest.fn() }));

const OWNER = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const BASE = 1_760_000_000;
const event = (
  n: number,
  createdAt = BASE + n,
  sender = FRIEND,
): RawDmEvent & { kind: 4; sig: string } => ({
  id: n.toString(16).padStart(64, '0'),
  pubkey: sender,
  created_at: createdAt,
  kind: 4,
  tags: [['p', OWNER]],
  content: `encrypted-message-${n}?iv=fixture`,
  sig: 'd'.repeat(128),
});
const wrap: RawGiftWrapEvent = { ...event(900, BASE - 86_400), kind: 1059 };
const fetchMock = jest.mocked(fetchInboxDmEvents);
const decryptMock = jest.mocked(nip46DecryptNip04);
const ingestMock = jest.mocked(ingestInboxNip17ForSigner);
let rows: DmMessageRow[];
let relayEvents: RawDmEvent[];
let now: number;
const savedCursor = async () => {
  const saved = await AsyncStorage.getItem(`dm-kind4-retries:${OWNER}`);
  return saved ? String(JSON.parse(saved).cursor) : null;
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const renderInbox = (signerType: 'nip46' | 'amber' = 'nip46', relays = ['wss://relay.example']) =>
  renderHook((props: UseDmInboxOptions) => useDmInbox(props), {
    initialProps: {
      pubkey: OWNER,
      isLoggedIn: true,
      signerType,
      followPubkeys: new Set([FRIEND]),
      getReadRelays: () => relays,
    },
  });
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(scheduleColdStartBackfill).mockImplementation(() => undefined);
  await AsyncStorage.clear();
  nip04PlaintextCache.clear();
  rows = [];
  relayEvents = [event(1)];
  now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  jest.mocked(ensureDmStoreMigrated).mockResolvedValue(undefined);
  decryptMock.mockImplementation(async (ciphertext) => `Lunch tomorrow: ${ciphertext}`);
  jest
    .mocked(selectKnownEventIds)
    .mockImplementation(
      async (_owner, ids) =>
        new Set(rows.filter((r) => ids.includes(r.eventId)).map((r) => r.eventId)),
    );
  jest.mocked(upsertDmMessages).mockImplementation(async (batch) => {
    for (const row of batch) if (!rows.some((r) => r.eventId === row.eventId)) rows.push(row);
  });
  jest.mocked(loadInboxEntries).mockImplementation(async () =>
    rows.map(
      (r): DmInboxEntry => ({
        id: r.eventId,
        partnerPubkey: r.conversation,
        fromMe: r.fromMe,
        createdAt: r.createdAt,
        text: r.content,
        wireKind: 4,
      }),
    ),
  );
  fetchMock.mockImplementation(async (_owner, _relays, opts) => ({
    kind4: relayEvents.filter((e) => opts?.since === undefined || e.created_at >= opts.since - 120),
    kind1059: [wrap],
  }));
  ingestMock.mockResolvedValue(null);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('reconciles a suppressed reconnect at expiry with cursor and negative cache intact', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
  const { result, unmount } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  relayEvents.push(event(2, BASE + 300));
  const missedWrap = { ...wrap, id: 'e'.repeat(64), created_at: BASE - 172_000 };
  fetchMock.mockImplementation(async (_owner, _relays, opts) => ({
    kind4: relayEvents.filter((e) => opts?.since === undefined || e.created_at >= opts.since - 120),
    kind1059: [wrap, missedWrap],
  }));
  ingestMock.mockImplementation(async ({ wraps, bypassSkipSet }) => ({
    entries: wraps
      .filter((w) => w.id === missedWrap.id)
      .map(() => ({
        id: 'f'.repeat(64),
        partnerPubkey: FRIEND,
        fromMe: false,
        createdAt: BASE + 301,
        text: 'Train is delayed; meet at 18:30',
        wireKind: 14,
      })),
    alreadyKnown: 0,
    skipHits: bypassSkipSet ? 0 : 1,
    misses: 1,
    stored: 1,
    yields: 0,
  }));
  now = 4000;
  const focus = new AbortController();
  await act(() => result.current.refreshDmInbox({ signal: focus.signal }));
  focus.abort();
  // A reconnect shares the pending timer, which must outlive the tab's abort.
  await act(() => result.current.refreshDmInbox());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  now = 60_999;
  await act(async () => {
    await jest.advanceTimersByTimeAsync(56_999);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  now = 61_000;
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][2]?.since).toBe(BASE + 1);
  expect(ingestMock.mock.calls[1][0]).toMatchObject({
    wraps: [wrap, missedWrap],
    bypassSkipSet: false,
  });
  expect(result.current.dmInbox.some((e) => e.id === event(2).id)).toBe(true);
  expect(result.current.dmInbox.some((e) => e.text === 'Train is delayed; meet at 18:30')).toBe(
    true,
  );
  unmount();
  expect(jest.getTimerCount()).toBe(0);
});

it('cancels suppressed reconciliation on account switch and unmount', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
  const { result, rerender, unmount } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  await act(() => result.current.refreshDmInbox());
  expect(jest.getTimerCount()).toBe(1);
  rerender({
    pubkey: STRANGER,
    isLoggedIn: true,
    signerType: 'nip46',
    followPubkeys: new Set([FRIEND]),
    getReadRelays: () => ['wss://relay.example'],
  });
  expect(jest.getTimerCount()).toBe(0);
  await act(() => result.current.refreshDmInbox());
  await act(() => result.current.refreshDmInbox());
  expect(jest.getTimerCount()).toBe(1);
  unmount();
  expect(jest.getTimerCount()).toBe(0);
});

it('waits for an automatic pass then performs the stronger pull-to-refresh', async () => {
  const { result } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  const old = event(2, BASE - 600);
  relayEvents.push(old);
  now = 62_000;
  const started = deferred<void>();
  const release = deferred<Awaited<ReturnType<typeof fetchInboxDmEvents>>>();
  fetchMock.mockImplementationOnce(() => {
    started.resolve();
    return release.promise;
  });
  let automatic!: Promise<void>;
  let forced!: Promise<void>;
  await act(async () => {
    automatic = result.current.refreshDmInbox();
    await started.promise;
    forced = result.current.refreshDmInbox({ force: true });
  });
  await act(async () => {
    release.resolve({ kind4: [event(1)], kind1059: [wrap] });
    await Promise.all([automatic, forced]);
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2][2]).not.toHaveProperty('since');
  expect(ingestMock.mock.calls[2][0].bypassSkipSet).toBe(true);
  expect(rows.some((r) => r.eventId === old.id)).toBe(true);
});

it('replaces warm work aborted before migration/setup resolves without microtask sleeps', async () => {
  const { result } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  relayEvents.push(event(2, BASE + 300));
  const setup = deferred<void>();
  jest.mocked(ensureDmStoreMigrated).mockImplementationOnce(() => setup.promise);
  const ctrl = new AbortController();
  let first!: Promise<void>;
  let replacement!: Promise<void>;
  await act(async () => {
    first = result.current.refreshDmInbox({ force: true, signal: ctrl.signal });
    ctrl.abort();
    replacement = result.current.refreshDmInbox({ force: true });
    setup.resolve();
    await Promise.all([first, replacement]);
  });
  expect(rows.some((r) => r.eventId === event(2).id)).toBe(true);
  expect(fetchMock.mock.calls.at(-1)?.[2]?.signal?.aborted).toBe(false);
});

it('backfills non-follow kind-4 history older than the 120 second overlap when widening', async () => {
  const old = event(2, BASE - 600, STRANGER);
  relayEvents.push(old);
  const { result } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  expect(rows.some((r) => r.eventId === old.id)).toBe(false);
  await act(() => result.current.refreshDmInbox({ includeNonFollows: true }));
  expect(fetchMock.mock.calls[1][2]).not.toHaveProperty('since');
  expect(result.current.dmInbox.some((e) => e.id === old.id)).toBe(true);
});

it('persists a partial decrypt batch but preserves the cursor until all fetched messages are ingested', async () => {
  const { result } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  now = 62_000;
  // Newest first: advancing to the first batch loses the remaining older rows.
  relayEvents = Array.from({ length: DECRYPT_YIELD_EVERY + 3 }, (_, i) =>
    event(100 + i, BASE + 10000 - i * 200),
  );
  const ctrl = new AbortController();
  decryptMock.mockImplementation(async (ciphertext) => {
    ctrl.abort();
    return `Meet at the station: ${ciphertext}`;
  });
  await act(() => result.current.refreshDmInbox({ signal: ctrl.signal }));
  expect(rows.length).toBe(1 + DECRYPT_YIELD_EVERY);
  expect(await savedCursor()).toBe(String(BASE + 1));
  decryptMock.mockImplementation(async (ciphertext) => `Meet at the station: ${ciphertext}`);
  await act(() => result.current.refreshDmInbox());
  expect(rows.length).toBe(1 + relayEvents.length);
  expect(await savedCursor()).toBe(String(BASE + 10000));
});

it('preserves the cursor when persistence of decrypted kind-4 rows fails', async () => {
  const { result } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  now = 62_000;
  relayEvents.push(event(2, BASE + 500));
  jest.mocked(upsertDmMessages).mockRejectedValueOnce(new Error('database write failed'));
  await act(() => result.current.refreshDmInbox());
  expect(await savedCursor()).toBe(String(BASE + 1));
  await act(() => result.current.refreshDmInbox());
  expect(rows.some((r) => r.eventId === event(2).id)).toBe(true);
});

it('retains one TTL-governed reconnect after fetch resolves while wrap ingestion is pending', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
  const { result, unmount } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  now = 62_000;
  const started = deferred<void>();
  const release = deferred<Awaited<ReturnType<typeof ingestInboxNip17ForSigner>>>();
  ingestMock.mockImplementationOnce(() => {
    started.resolve();
    return release.promise;
  });
  let automatic!: Promise<void>;
  const joined: Promise<void>[] = [];
  const focus = new AbortController();
  await act(async () => {
    automatic = result.current.refreshDmInbox();
    await started.promise; // The relay snapshot is now fixed; ingestion is unfinished.
    relayEvents.push(event(2, BASE + 300));
    const liveSlice = Array.from({ length: COLD_INITIAL_WRAP_LIMIT }, (_, i) => ({
      ...wrap,
      id: (1000 + i).toString(16).padStart(64, '0'),
    }));
    const missedWrap = { ...wrap, id: 'e'.repeat(64), created_at: BASE - 172_000 };
    fetchMock.mockImplementation(async (_owner, _relays, opts) => ({
      kind4: relayEvents.filter(
        (e) => opts?.since === undefined || e.created_at >= opts.since - 120,
      ),
      kind1059: [...liveSlice, missedWrap],
    }));
    ingestMock.mockImplementation(async ({ wraps, bypassSkipSet }) => ({
      entries: wraps
        .filter((w) => w.id === missedWrap.id)
        .map(() => ({
          id: 'f'.repeat(64),
          partnerPubkey: FRIEND,
          fromMe: false,
          createdAt: BASE + 301,
          text: 'Missed outside the live subscription slice',
          wireKind: 14,
        })),
      alreadyKnown: 0,
      skipHits: bypassSkipSet ? 0 : liveSlice.length,
      misses: 1,
      stored: 1,
      yields: 0,
    }));
    joined.push(result.current.refreshDmInbox({ signal: focus.signal }));
    joined.push(result.current.refreshDmInbox());
    joined.push(result.current.refreshDmInbox());
    focus.abort();
    release.resolve(null);
    await Promise.all([automatic, ...joined]);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(1);
  expect(result.current.dmInbox.some((e) => e.id === event(2).id)).toBe(false);
  now = 121_999;
  await act(() => jest.advanceTimersByTimeAsync(59_999));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  now = 122_000;
  await act(() => jest.advanceTimersByTimeAsync(1));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2][2]).toMatchObject({ since: BASE + 1 });
  expect(fetchMock.mock.calls[2][2]).not.toHaveProperty('limit');
  expect(ingestMock.mock.calls[2][0].bypassSkipSet).toBe(false);
  expect(result.current.dmInbox.some((e) => e.id === event(2).id)).toBe(true);
  expect(
    result.current.dmInbox.some((e) => e.text === 'Missed outside the live subscription slice'),
  ).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  unmount();
});

it('completes cold and warm refreshes despite a persistent null kind-4 decrypt and backfills beyond the wrap cap', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
  const failed = event(2, BASE + 500);
  relayEvents.push(failed);
  decryptMock.mockImplementation(async (ciphertext) => {
    // The signer throws on invalid ciphertext; the hook converts it to null.
    if (ciphertext === failed.content) throw new Error('invalid ciphertext');
    return 'Lunch tomorrow at noon';
  });
  const wraps = Array.from({ length: COLD_INITIAL_WRAP_LIMIT + 3 }, (_, i) => ({
    ...wrap,
    id: (1000 + i).toString(16).padStart(64, '0'),
    created_at: BASE - i * 600,
  }));
  fetchMock.mockImplementation(async (_owner, _relays, opts) => ({
    kind4: relayEvents.filter((e) => opts?.since === undefined || e.created_at >= opts.since - 120),
    kind1059: wraps.slice(0, opts?.limit ?? wraps.length),
  }));
  ingestMock.mockImplementation(async ({ wraps: fetched }) => {
    const fresh = fetched.filter((w) => !rows.some((r) => r.eventId === w.id));
    await upsertDmMessages(
      fresh.map((w) => ({
        owner: OWNER,
        eventId: w.id,
        conversation: FRIEND,
        createdAt: w.created_at,
        sender: FRIEND,
        content: 'Wrap history survives failed legacy decrypt',
        fromMe: false,
        wireKind: 14,
      })),
    );
    return {
      entries: [],
      alreadyKnown: fetched.length - fresh.length,
      skipHits: 0,
      misses: fresh.length,
      stored: fresh.length,
      yields: 0,
    };
  });
  let backfill!: () => void;
  jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((task) => {
    if (typeof task === 'function') backfill = task;
    return { then: () => Promise.resolve(), done: () => undefined, cancel: () => undefined };
  });
  jest
    .mocked(scheduleColdStartBackfill)
    .mockImplementation(jest.requireActual('./dmColdStartBackfill').scheduleColdStartBackfill);
  const { result, unmount } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  expect(rows).toHaveLength(1 + COLD_INITIAL_WRAP_LIMIT);
  expect(await savedCursor()).toBe(String(failed.created_at));
  expect(backfill).toEqual(expect.any(Function));
  // Run the real backfill scheduler, then await its active flight through a
  // backfill-strength join so this test doesn't itself request reconciliation.
  now = 4000;
  await act(async () => {
    backfill();
    await result.current.refreshDmInbox({ backfill: true });
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][2]?.limit).toBe(COLD_INITIAL_WRAP_LIMIT);
  expect(fetchMock.mock.calls[1][2]).not.toHaveProperty('limit');
  expect(fetchMock.mock.calls[1][2]?.since).toBe(failed.created_at);
  expect(ingestMock.mock.calls[1][0].bypassSkipSet).toBe(false);
  expect(rows).toHaveLength(1 + wraps.length);
  expect(result.current.dmInbox.some((e) => e.id === wraps.at(-1)?.id)).toBe(true);
  expect(decryptMock.mock.calls.filter(([text]) => text === failed.content)).toHaveLength(1);
  relayEvents.push(event(3, BASE + 1000));
  // Two ordinary, timer-driven retries exhaust the counted budget. Backfill
  // completion renews TTL independently while the old failure pins history.
  now = 64_000;
  await act(() => jest.advanceTimersByTimeAsync(60_000));
  expect(decryptMock.mock.calls.filter(([text]) => text === failed.content)).toHaveLength(2);
  now = 184_000;
  await act(() => jest.advanceTimersByTimeAsync(120_000));
  expect(decryptMock.mock.calls.filter(([text]) => text === failed.content)).toHaveLength(3);
  expect(jest.getTimerCount()).toBe(0);
  expect(await savedCursor()).toBe(String(BASE + 1000));
  now = 245_000;
  await act(() => result.current.refreshDmInbox());
  expect(decryptMock.mock.calls.filter(([text]) => text === failed.content)).toHaveLength(3);
  now = 246_000;
  await act(() => result.current.refreshDmInbox());
  const fetches = fetchMock.mock.calls.length;
  await act(() => result.current.refreshDmInbox());
  expect(fetchMock).toHaveBeenCalledTimes(fetches); // Permanent failure renews TTL.
  await act(() => result.current.refreshDmInbox({ force: true }));
  expect(decryptMock.mock.calls.filter(([text]) => text === failed.content)).toHaveLength(4);
  unmount();
  expect(jest.getTimerCount()).toBe(0);
});

it('recovers an old DM after temporary signer failure and a newer arrival without force, across restart', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
  const old = event(1);
  decryptMock.mockRejectedValue(new Error('NIP-46 signer not connected'));
  const first = renderInbox();
  await act(() => first.result.current.refreshDmInbox());
  expect(await savedCursor()).toBe(String(old.created_at));
  first.unmount();
  nip04PlaintextCache.clear();
  // Restart while disconnected. A message outside the 120s overlap arrives.
  relayEvents.push(event(2, BASE + 600));
  decryptMock.mockImplementation(async (ciphertext) => {
    if (ciphertext === old.content) throw new Error('Signer temporarily unavailable');
    return 'Newer DM delivered';
  });
  const { result, unmount } = renderInbox();
  await act(() => result.current.refreshDmInbox());
  expect(await savedCursor()).toBe(String(old.created_at));
  expect(fetchMock.mock.calls.at(-1)?.[2]?.since).toBe(old.created_at);
  expect(rows.some((r) => r.eventId === event(2).id)).toBe(true);
  expect(rows.some((r) => r.eventId === old.id)).toBe(false);
  const metadata = JSON.parse((await AsyncStorage.getItem(`dm-kind4-retries:${OWNER}`))!).failures;
  expect(metadata.every((f: { attempts: number }) => f.attempts === 0)).toBe(true);
  decryptMock.mockResolvedValue('Recovered valid DM');
  now = 61_000;
  await act(() => jest.advanceTimersByTimeAsync(60_000));
  expect(rows.some((r) => r.eventId === old.id)).toBe(true);
  expect(result.current.dmInbox.some((e) => e.id === old.id)).toBe(true);
  expect(await savedCursor()).toBe(String(BASE + 600));
  expect(JSON.parse((await AsyncStorage.getItem(`dm-kind4-retries:${OWNER}`))!).failures).toEqual(
    [],
  );
  expect(jest.getTimerCount()).toBe(0);
  unmount();
});

it('recovers after three structured Amber availability failures beyond the overlap', async () => {
  jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
  const old = event(1);
  const amber = jest.mocked(requestNip04Decrypt);
  const failures = [
    new AmberSignerError('BUSY', 'busy', 'native busy'),
    new AmberSignerError('NO_RESULT', 'no-response', 'native no result'),
    new AmberSignerError('NO_ACTIVITY', 'unavailable', 'native no activity'),
  ];
  amber.mockImplementation(async (ciphertext) => {
    if (ciphertext === old.content && failures.length) throw failures.shift();
    return 'Delivered after Amber recovered';
  });
  const { result, unmount } = renderInbox('amber');
  await act(() => result.current.refreshDmInbox());
  relayEvents.push(event(2, BASE + 600));
  for (let attempt = 2; attempt <= 3; attempt++) {
    now = (attempt - 1) * 60_000 + 1000;
    await act(() => jest.advanceTimersByTimeAsync(60_000));
    expect(await savedCursor()).toBe(String(old.created_at));
    expect(rows.some((r) => r.eventId === old.id)).toBe(false);
  }
  expect(rows.some((r) => r.eventId === event(2).id)).toBe(true);
  expect(JSON.parse((await AsyncStorage.getItem(`dm-kind4-retries:${OWNER}`))!).failures).toEqual([
    expect.objectContaining({ id: old.id, attempts: 0 }),
  ]);
  now = 181_000;
  await act(() => jest.advanceTimersByTimeAsync(60_000));
  expect(amber.mock.calls.filter(([ct]) => ct === old.content)).toHaveLength(4);
  expect(fetchMock.mock.calls.at(-1)?.[2]?.since).toBe(old.created_at);
  expect(rows.some((r) => r.eventId === old.id)).toBe(true);
  expect(result.current.dmInbox.some((e) => e.id === old.id)).toBe(true);
  expect(await savedCursor()).toBe(String(BASE + 600));
  expect(jest.getTimerCount()).toBe(0);
  unmount();
});

// Full exhausted capacity plus 16 targets: the last target sits exactly at
// the old replay timestamp and must survive any unfinished pass.
it.each(['abort', 'database', 'metadata', 'exception', 'complete'] as const)(
  'commits overflow cursor and pruning only after the whole pass persists (%s)',
  async (outcome) => {
    const negatives = Array.from({ length: 10_000 }, (_, i) => [`exhausted-${i}`, 100]);
    const failures = Array.from({ length: 14 }, (_, i) => ({
      id: event(100 + i).id,
      createdAt: 220,
      attempts: 2,
      uncountedAttempts: 0,
      firstFailure: Date.now() - 300_000,
      lastAttempt: Date.now() - 300_000,
    }));
    // Start with the round-8 two-key format to exercise migration as well.
    const before = JSON.stringify(failures);
    const negativesBefore = JSON.stringify({ cursor: 150, entries: negatives });
    await AsyncStorage.setItem(`dm-kind4-retries:${OWNER}`, before);
    await AsyncStorage.setItem(`dm-kind4-exhausted:${OWNER}`, negativesBefore);
    relayEvents = Array.from({ length: 16 }, (_, i) => event(100 + i, i === 15 ? 100 : 220));
    const ctrl = new AbortController();
    let attempts = 0;
    decryptMock.mockImplementation(async () => {
      attempts++;
      if (outcome === 'abort' && attempts === 15) ctrl.abort();
      if (attempts < 15) throw new Error('invalid ciphertext');
      return 'Target safely persisted';
    });
    if (outcome === 'database')
      jest.mocked(upsertDmMessages).mockImplementationOnce(async (batch) => {
        rows.push(batch[0]);
        throw new Error('database write failed mid-batch');
      });
    if (outcome === 'metadata')
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('metadata write failed'));
    if (outcome === 'exception') ingestMock.mockRejectedValueOnce(new Error('ingestion failed'));
    const first = renderInbox('nip46', DEFAULT_RELAYS);
    await act(() => first.result.current.refreshDmInbox({ signal: ctrl.signal }));
    expect(attempts).toBe(outcome === 'abort' ? 15 : 16);
    const committed = new Kind4RetryStore(OWNER);
    await committed.load();
    if (outcome === 'complete') {
      expect(committed.committedCursor()).toBe(221);
      const saved = JSON.parse((await AsyncStorage.getItem(`dm-kind4-retries:${OWNER}`))!);
      expect(saved.entries.every(([, timestamp]: [string, number]) => timestamp >= 101)).toBe(true);
      expect(rows.some((r) => r.eventId === relayEvents[15].id)).toBe(true);
    } else {
      expect(committed.committedCursor()).toBe(150);
      expect(await AsyncStorage.getItem(`dm-kind4-retries:${OWNER}`)).toBe(before);
      expect(await AsyncStorage.getItem(`dm-kind4-exhausted:${OWNER}`)).toBe(negativesBefore);
    }
    first.unmount();
    if (outcome !== 'complete') {
      nip04PlaintextCache.clear();
      decryptMock.mockResolvedValue('Retried after restart');
      const second = renderInbox('nip46', DEFAULT_RELAYS);
      await act(() => second.result.current.refreshDmInbox());
      expect(fetchMock.mock.calls.at(-1)?.[2]?.since).toBe(150);
      expect(rows.some((r) => r.eventId === relayEvents[15].id)).toBe(true);
      expect(second.result.current.dmInbox.some((e) => e.id === relayEvents[15].id)).toBe(true);
      second.unmount();
    }
  },
);

it.each([false, true])(
  'filters stored non-friend order cards when hydrating Messages (%s)',
  async (includeNonFollows) => {
    relayEvents = [];
    const invoice: DmInboxEntry = {
      id: 'stored-invoice',
      partnerPubkey: STRANGER,
      fromMe: false,
      createdAt: BASE,
      wireKind: 16,
      text: '💳 Payment',
    };
    jest.mocked(loadInboxEntries).mockResolvedValue([invoice]);
    const { result } = renderInbox();
    await act(() => result.current.refreshDmInbox({ force: true, includeNonFollows }));
    expect(result.current.dmInbox).toEqual(includeNonFollows ? [invoice] : []);
  },
);
