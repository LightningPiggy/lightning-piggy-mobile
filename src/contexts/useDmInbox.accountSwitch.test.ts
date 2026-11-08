/**
 * Account-switch scoping for the DM inbox: one account's conversations must
 * never render under another (accounts share a phone in a family app).
 */
import { act, renderHook } from '@testing-library/react-native';
import type React from 'react';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { loadInboxEntries } from '../services/dmInbox';
import { fetchInboxDmEvents } from '../services/nostrService';
import { startLiveDmSubscription } from './nostrLiveDmSub';
import { useMarmotDmInbound } from './useMarmotDmInbound';
import { scheduleColdStartBackfill } from './dmColdStartBackfill';
import { useDmInbox, type UseDmInboxOptions } from './useDmInbox';

jest.mock('../services/nostrService', () => ({ fetchInboxDmEvents: jest.fn() }));
jest.mock('../services/amberService', () => ({}));
jest.mock('./nip46DmDecrypt', () => ({ nip46DecryptNip04: jest.fn() }));
jest.mock('./nostrSecretKeyCache', () => ({
  nip04PlaintextCache: { get: jest.fn(), set: jest.fn() },
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

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const PARTNER = 'c'.repeat(64);

const entry = (id: string): DmInboxEntry => ({
  id,
  partnerPubkey: PARTNER,
  fromMe: false,
  createdAt: 100,
  text: id,
  wireKind: 14,
});

const loadInboxEntriesMock = loadInboxEntries as jest.MockedFunction<typeof loadInboxEntries>;
const fetchMock = fetchInboxDmEvents as jest.MockedFunction<typeof fetchInboxDmEvents>;
const marmotMock = useMarmotDmInbound as jest.MockedFunction<typeof useMarmotDmInbound>;

const optionsFor = (pubkey: string): UseDmInboxOptions => ({
  pubkey,
  isLoggedIn: true,
  signerType: 'nsec',
  followPubkeys: new Set([PARTNER]),
  getReadRelays: () => ['wss://relay.example'],
});

const inboxByOwner: Record<string, DmInboxEntry[]> = {
  [A]: [entry('a-msg')],
  [B]: [entry('b-msg')],
};

beforeEach(() => {
  jest.clearAllMocks();
  loadInboxEntriesMock.mockImplementation(async (owner: string) => inboxByOwner[owner] ?? []);
  fetchMock.mockResolvedValue({ kind4: [], kind1059: [], complete: true } as unknown as Awaited<
    ReturnType<typeof fetchInboxDmEvents>
  >);
});

const renderInbox = (pubkey: string) =>
  renderHook((props: UseDmInboxOptions) => useDmInbox(props), {
    initialProps: optionsFor(pubkey),
  });

describe('useDmInbox account scoping', () => {
  it('arms exactly one inbox at login before any Messages focus and replaces its owner on account switch', () => {
    const stop = jest.fn();
    const start = jest.mocked(startLiveDmSubscription);
    start.mockClear();
    start.mockReturnValue(stop);
    const { result, rerender, unmount } = renderInbox(A);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ viewerPubkey: A }));
    act(() => result.current.armLiveDmSub());
    expect(start).toHaveBeenCalledTimes(1);
    rerender(optionsFor(B));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ viewerPubkey: B }));
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("hides the previous account's conversations from the first render after a switch", async () => {
    const { result, rerender } = renderInbox(A);
    await act(() => result.current.hydrateDmInboxFromCache(A));
    expect(result.current.dmInbox.map((e) => e.id)).toEqual(['a-msg']);

    // The add-account login path flips the pubkey without clearing the inbox.
    rerender(optionsFor(B));
    expect(result.current.dmInbox).toEqual([]);
  });

  it('drops a refresh that was in flight for the previous account', async () => {
    let releaseFetch: () => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFetch = () =>
            resolve({ kind4: [], kind1059: [], complete: true } as unknown as Awaited<
              ReturnType<typeof fetchInboxDmEvents>
            >);
        }),
    );
    const { result, rerender } = renderInbox(A);
    let refreshA: Promise<void> = Promise.resolve();
    await act(async () => {
      refreshA = result.current.refreshDmInbox({ force: true });
      // Let the stored-inbox early paint for A land.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    rerender(optionsFor(B));
    await act(async () => {
      releaseFetch();
      await refreshA;
    });
    expect(result.current.dmInbox).toEqual([]);
  });

  it("refreshes the new account immediately instead of inheriting the old account's TTL", async () => {
    const { result, rerender } = renderInbox(A);
    await act(() => result.current.refreshDmInbox());
    expect(fetchMock).toHaveBeenLastCalledWith(A, expect.any(Array), expect.any(Object));

    rerender(optionsFor(B));
    await act(() => result.current.refreshDmInbox());
    expect(fetchMock).toHaveBeenLastCalledWith(B, expect.any(Array), expect.any(Object));
    expect(result.current.dmInbox.map((e) => e.id)).toEqual(['b-msg']);
  });

  it('drops a teardown flush bound to the previous account (Marmot / live sub)', async () => {
    const { result, rerender } = renderInbox(A);
    const setterForA = marmotMock.mock.calls[marmotMock.mock.calls.length - 1][1] as React.Dispatch<
      React.SetStateAction<DmInboxEntry[]>
    >;
    rerender(optionsFor(B));
    await act(() => result.current.hydrateDmInboxFromCache(B));
    act(() => setterForA((prev) => [entry('late-a'), ...prev]));
    expect(result.current.dmInbox.map((e) => e.id)).toEqual(['b-msg']);
  });
  it('parks a hydrate issued before the hook renders the new account, then applies it', async () => {
    const { result, rerender } = renderInbox(A);
    // switchIdentity / login: setPubkey(B) then hydrate(B) — the hydrate can
    // resolve before the provider re-renders with B.
    await act(() => result.current.hydrateDmInboxFromCache(B));
    expect(result.current.dmInbox).toEqual([]);
    rerender(optionsFor(B));
    expect(result.current.dmInbox.map((e) => e.id)).toEqual(['b-msg']);
  });

  it('ignores a late hydrate for an account already switched away from, without blocking the new one', async () => {
    const { result, rerender } = renderInbox(A);
    rerender(optionsFor(B));
    await act(() => result.current.hydrateDmInboxFromCache(A));
    expect(result.current.dmInbox).toEqual([]);
    await act(() => result.current.hydrateDmInboxFromCache(B));
    expect(result.current.dmInbox.map((e) => e.id)).toEqual(['b-msg']);
  });

  it("aborts the previous account's in-flight refresh on a switch", async () => {
    let seenSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_pk, _relays, opts) => {
      seenSignal = opts?.signal;
      return new Promise(() => {});
    });
    const { result, rerender } = renderInbox(A);
    await act(async () => {
      void result.current.refreshDmInbox({ force: true });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(seenSignal?.aborted).toBe(false);
    rerender(optionsFor(B));
    expect(seenSignal?.aborted).toBe(true);
  });
});

it('serializes a rapid A → B → A refresh without joining cancelled work', async () => {
  let releaseA: () => void = () => {};
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseA = () => resolve({ kind4: [], kind1059: [], complete: true } as never);
      }),
  );
  const { result, rerender } = renderInbox(A);
  let first: Promise<void>;
  await act(async () => {
    first = result.current.refreshDmInbox({ force: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  rerender(optionsFor(B));
  await act(() => result.current.refreshDmInbox({ force: true }));
  rerender(optionsFor(A));
  let next: Promise<void>;
  let concurrent: Promise<void>;
  await act(async () => {
    next = result.current.refreshDmInbox({ force: true });
    concurrent = result.current.refreshDmInbox({ force: true });
    await Promise.resolve();
  });
  expect(fetchMock.mock.calls.filter(([owner]) => owner === A)).toHaveLength(1);
  await act(async () => {
    releaseA();
    await Promise.all([first!, next!, concurrent!]);
  });
  expect(fetchMock.mock.calls.filter(([owner]) => owner === A)).toHaveLength(2);
  expect(result.current.dmInbox.map((e) => e.id)).toEqual(['a-msg']);
});

it('invalidates the live subscription owner before old events can surface', () => {
  const { result, rerender } = renderInbox(A);
  act(() => result.current.armLiveDmSub());
  const subscribe = startLiveDmSubscription as jest.MockedFunction<typeof startLiveDmSubscription>;
  const oldSubscription = subscribe.mock.calls[subscribe.mock.calls.length - 1][0];
  expect(oldSubscription.isCurrentOwner?.()).toBe(true);
  rerender(optionsFor(B));
  expect(oldSubscription.isCurrentOwner?.()).toBe(false);
});

it('throttles automatic focus/reconnect refreshes for a minute, while user force still works', async () => {
  const clock = jest.spyOn(performance, 'now');
  clock.mockReturnValue(1000);
  try {
    const { result } = renderInbox(A);
    await act(() => result.current.refreshDmInbox());
    clock.mockReturnValue(46_000);
    await act(() => result.current.refreshDmInbox());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(61_000);
    await act(() => result.current.refreshDmInbox());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(() => result.current.refreshDmInbox({ force: true }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});

it('joins an in-flight user refresh even when the prior completion is still fresh', async () => {
  const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
  const { result } = renderInbox(A);
  await act(() => result.current.refreshDmInbox());
  let release!: () => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ kind4: [], kind1059: [], complete: true } as never);
      }),
  );
  let forced!: Promise<void>;
  let joined!: Promise<void>;
  let joinedResolved = false;
  await act(async () => {
    forced = result.current.refreshDmInbox({ force: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    joined = result.current.refreshDmInbox().then(() => {
      joinedResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(joinedResolved).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => {
    release();
    await Promise.all([forced, joined]);
  });
  expect(joinedResolved).toBe(true);
  clock.mockRestore();
});

afterEach(() => jest.restoreAllMocks());

it('does one incremental catch-up when an automatic view widens to non-follows', async () => {
  jest.spyOn(performance, 'now').mockReturnValue(1000);
  const { result } = renderInbox(A);
  await act(() => result.current.refreshDmInbox());
  await act(() => result.current.refreshDmInbox({ includeNonFollows: true }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(() => result.current.refreshDmInbox({ includeNonFollows: true }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does not schedule another cold backfill when the refresh fails', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  const { result } = renderInbox(A);
  await act(() => result.current.refreshDmInbox());
  expect(scheduleColdStartBackfill).toHaveBeenCalledWith(
    expect.objectContaining({ isColdStart: false }),
  );
});

it('waits for a tab-aborted warm refresh and starts the requested replacement', async () => {
  const { result } = renderInbox(A);
  await act(() => result.current.refreshDmInbox());
  let release!: () => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ kind4: [], kind1059: [], complete: true } as never);
      }),
  );
  const controller = new AbortController();
  let first!: Promise<void>;
  let replacement!: Promise<void>;
  await act(async () => {
    first = result.current.refreshDmInbox({ force: true, signal: controller.signal });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    controller.abort();
    replacement = result.current.refreshDmInbox({ force: true });
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => {
    release();
    await Promise.all([first, replacement]);
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
