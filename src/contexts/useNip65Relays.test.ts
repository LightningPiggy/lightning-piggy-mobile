import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNip65Relays } from './useNip65Relays';
import {
  DM_INBOX_RELAYS_CACHE_KEY_BASE,
  RELAY_LIST_CACHE_KEY_BASE,
  RELAY_LIST_TIMESTAMP_KEY_BASE,
} from './nostrCacheKeys';
import { perAccountKey } from '../services/perAccountStorage';
import { fetchLatestReplaceable } from '../services/nostrRelayLists';
import { rearmBackgroundDmWatchForActiveIdentity } from '../services/backgroundDmService';

jest.mock('../services/nostrRelayLists', () => ({ fetchLatestReplaceable: jest.fn() }));
jest.mock('../services/backgroundDmService', () => ({
  rearmBackgroundDmWatchForActiveIdentity: jest.fn().mockResolvedValue(undefined),
}));
const mockFetchList = jest.fn();
let mockListCreatedAt = 100;
jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: ['wss://relay.damus.io'],
  // The list mock below, wrapped as {list, createdAt}.
  fetchRelayListEvent: jest.fn(async (...args: unknown[]) => {
    const list = await mockFetchList(...args);
    return list ? { list, createdAt: mockListCreatedAt } : null;
  }),
}));
const fetchLatest = fetchLatestReplaceable as jest.Mock;
const inboxEvent = (urls: string[], created_at = 100) => ({
  kind: 10050,
  created_at,
  tags: urls.map((u) => ['relay', u]),
});
const fetchList = mockFetchList;
const PK = 'a'.repeat(64);

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockListCreatedAt = 100;
  fetchList.mockResolvedValue([{ url: 'wss://relay.primal.net', read: true, write: true }]);
});

it("loads the user's own DM inbox relays alongside NIP-65, so the app reads them", async () => {
  fetchLatest.mockResolvedValue(inboxEvent(['wss://nostr.mom', 'wss://relay.snort.social']));
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.loadRelays(PK);
  });
  await waitFor(() =>
    expect(result.current.dmInboxRelays).toEqual(['wss://nostr.mom', 'wss://relay.snort.social']),
  );
});

it('adopts published DM inbox relays immediately and clears both lists on reset', async () => {
  fetchLatest.mockResolvedValue(null);
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom']);
    await result.current.applyPublishedRelayList(PK, [
      { url: 'wss://nostr.mom', read: true, write: true },
    ]);
  });
  expect(result.current.dmInboxRelays).toEqual(['wss://nostr.mom']);
  expect(result.current.nip65Relays).toHaveLength(1);
  act(() => result.current.resetRelayLists());
  expect(result.current.dmInboxRelays).toEqual([]);
  expect(result.current.nip65Relays).toEqual([]);
});

it('ignores a slow inbox load that finishes after an identity reset', async () => {
  let finish!: (v: unknown) => void;
  fetchLatest.mockReturnValue(new Promise((r) => (finish = r)));
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.loadRelays(PK);
  });
  act(() => result.current.resetRelayLists()); // logout / switch while still loading
  await act(async () => {
    finish(inboxEvent(['wss://old-account.example']));
  });
  expect(result.current.dmInboxRelays).toEqual([]);
});

it('a just-published inbox list is not overwritten by an older in-flight load', async () => {
  let finish!: (v: unknown) => void;
  fetchLatest.mockReturnValue(new Promise((r) => (finish = r)));
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.loadRelays(PK);
  });
  await act(async () => {
    await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom']);
  });
  await act(async () => {
    finish(inboxEvent(['wss://old-inbox.example'])); // older copy lands after the publish
  });
  expect(result.current.dmInboxRelays).toEqual(['wss://nostr.mom']);
});

it("looks up the DM inbox list on the user's NIP-65 write relays too", async () => {
  fetchList.mockResolvedValue([
    { url: 'wss://my-write.example', read: false, write: true },
    { url: 'wss://my-read.example', read: true, write: false },
  ]);
  fetchLatest.mockResolvedValue(null);
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.loadRelays(PK);
  });
  await waitFor(() => expect(fetchLatest).toHaveBeenCalled());
  const relays = fetchLatest.mock.calls[0][2] as string[];
  expect(relays).toContain('wss://my-write.example');
  expect(relays).not.toContain('wss://my-read.example');
});

it('a NIP-65 load finishing after an in-app publish does not overwrite it', async () => {
  let finish!: (v: unknown) => void;
  fetchList.mockReturnValue(new Promise((r) => (finish = r)));
  fetchLatest.mockResolvedValue(null);
  const { result } = renderHook(() => useNip65Relays());
  let loading!: Promise<unknown>;
  act(() => {
    loading = result.current.loadRelays(PK);
  });
  const published = [{ url: 'wss://nostr.mom', read: true, write: true }];
  await act(async () => {
    await result.current.applyPublishedRelayList(PK, published);
  });
  await act(async () => {
    finish([{ url: 'wss://stale.example', read: true, write: true }]);
    await loading;
  });
  expect(result.current.nip65Relays).toEqual(published);
});

it('a NIP-65 load finishing after an identity reset does not start an inbox load', async () => {
  let finish!: (v: unknown) => void;
  fetchList.mockReturnValue(new Promise((r) => (finish = r)));
  fetchLatest.mockResolvedValue(inboxEvent(['wss://old-account.example']));
  const { result } = renderHook(() => useNip65Relays());
  let loading!: Promise<unknown>;
  act(() => {
    loading = result.current.loadRelays(PK);
  });
  act(() => result.current.resetRelayLists());
  await act(async () => {
    finish([{ url: 'wss://relay.primal.net', read: true, write: true }]);
    await loading;
  });
  expect(fetchLatest).not.toHaveBeenCalled();
  expect(result.current.dmInboxRelays).toEqual([]);
});

it('re-arms the background DM watch when the inbox list changes, not when it is the same', async () => {
  fetchLatest.mockResolvedValue(null);
  const rearm = rearmBackgroundDmWatchForActiveIdentity as jest.Mock;
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom']);
  });
  expect(rearm).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom']);
  });
  expect(rearm).toHaveBeenCalledTimes(1);
});

it('re-arms the background DM watch when the NIP-65 list changes, not when it is the same', async () => {
  const rearm = rearmBackgroundDmWatchForActiveIdentity as jest.Mock;
  rearm.mockClear();
  const { result } = renderHook(() => useNip65Relays());
  const list = [{ url: 'wss://nostr.mom', read: true, write: true }];
  await act(async () => {
    await result.current.applyPublishedRelayList(PK, list);
  });
  expect(rearm).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.applyPublishedRelayList(PK, list);
  });
  expect(rearm).toHaveBeenCalledTimes(1);
});

it('never replaces a newer cached inbox list with an older relay copy', async () => {
  fetchList.mockResolvedValue(null);
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.applyPublishedDmInbox(PK, ['wss://new-inbox.example'], 500);
  });
  fetchLatest.mockResolvedValue(inboxEvent(['wss://old-inbox.example'], 400)); // older copy
  await act(async () => {
    await result.current.loadRelays(PK);
  });
  await waitFor(() => expect(fetchLatest).toHaveBeenCalled());
  expect(result.current.dmInboxRelays).toEqual(['wss://new-inbox.example']);
  // ...and the lookup searched the known inbox relays themselves.
  expect(fetchLatest.mock.calls.at(-1)?.[2]).toContain('wss://new-inbox.example');
});

it('adopts lists in memory even when the cache write fails', async () => {
  const original = AsyncStorage.setItem;
  (AsyncStorage as { setItem: unknown }).setItem = jest
    .fn()
    .mockRejectedValue(new Error('disk full'));
  try {
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom'], 1);
      await result.current.applyPublishedRelayList(PK, [
        { url: 'wss://nostr.mom', read: true, write: true },
      ]);
    });
    expect(result.current.dmInboxRelays).toEqual(['wss://nostr.mom']);
    expect(result.current.nip65Relays).toHaveLength(1);
  } finally {
    (AsyncStorage as { setItem: unknown }).setItem = original;
  }
});

it('refuses to adopt an inbox list older than the one already adopted', async () => {
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    expect(await result.current.applyPublishedDmInbox(PK, ['wss://new.example'], 500)).toEqual({
      adopted: true,
      baseline: 500,
    });
  });
  await act(async () => {
    expect(await result.current.applyPublishedDmInbox(PK, ['wss://old.example'], 400)).toEqual({
      adopted: false,
      baseline: 500,
    });
  });
  expect(result.current.dmInboxRelays).toEqual(['wss://new.example']);
});

it('refuses to adopt a NIP-65 list older than the one already adopted', async () => {
  const { result } = renderHook(() => useNip65Relays());
  const newer = [{ url: 'wss://new.example', read: true, write: true }];
  await act(async () => {
    await result.current.applyPublishedRelayList(PK, newer, 500);
  });
  await act(async () => {
    const r = await result.current.applyPublishedRelayList(
      PK,
      [{ url: 'wss://old.example', read: true, write: true }],
      400,
    );
    expect(r).toEqual({ adopted: false, baseline: 500 });
  });
  expect(result.current.nip65Relays).toEqual(newer);
});

it('does not adopt an inbox list if the identity is reset mid-call', async () => {
  const { result } = renderHook(() => useNip65Relays());
  let r!: Promise<unknown>;
  act(() => {
    r = result.current.applyPublishedDmInbox(PK, ['wss://old-account.example'], 1);
    result.current.resetRelayLists(); // switch/logout while it awaits storage
  });
  await act(async () => {
    expect(await r).toMatchObject({ adopted: false });
  });
  expect(result.current.dmInboxRelays).toEqual([]);
});

it('keeps a newer cached NIP-65 list when a relay serves an older copy after the TTL', async () => {
  const newer = [{ url: 'wss://nostr.mom', read: true, write: true }];
  const { result } = renderHook(() => useNip65Relays());
  await act(async () => {
    await result.current.applyPublishedRelayList(PK, newer, 500);
  });
  // Expire the cache TTL so loadRelays goes to the network.
  await AsyncStorage.setItem(perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, PK), '0');
  mockListCreatedAt = 100; // the relay copy predates the publish
  let read: string[] = [];
  await act(async () => {
    read = await result.current.loadRelays(PK);
  });
  expect(mockFetchList).toHaveBeenCalled();
  expect(result.current.nip65Relays).toEqual(newer);
  expect(read).toEqual(['wss://nostr.mom']);
});

it('keeps a newly adopted list even when saving its timestamp fails (storage full)', async () => {
  const realSet = AsyncStorage.setItem;
  AsyncStorage.setItem = jest.fn().mockRejectedValue(new Error('disk full'));
  try {
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom'], 500);
      await result.current.applyPublishedRelayList(
        PK,
        [{ url: 'wss://nostr.mom', read: true, write: true }],
        500,
      );
    });
    let inbox, nip65;
    await act(async () => {
      inbox = await result.current.applyPublishedDmInbox(PK, ['wss://old.example'], 100);
      nip65 = await result.current.applyPublishedRelayList(
        PK,
        [{ url: 'wss://old.example', read: true, write: true }],
        100,
      );
    });
    expect(inbox).toEqual({ adopted: false, baseline: 500 });
    expect(nip65).toEqual({ adopted: false, baseline: 500 });
    expect(result.current.dmInboxRelays).toEqual(['wss://nostr.mom']);
  } finally {
    AsyncStorage.setItem = realSet;
  }
});

describe('cold-start re-sets with unchanged content (relay subs must not re-arm)', () => {
  const list = () => [{ url: 'wss://relay.primal.net', read: true, write: true }];

  it('keeps the NIP-65 and inbox arrays when the network returns what the cache had', async () => {
    await AsyncStorage.setItem(
      perAccountKey(RELAY_LIST_CACHE_KEY_BASE, PK),
      JSON.stringify(list()),
    );
    await AsyncStorage.setItem(
      perAccountKey(DM_INBOX_RELAYS_CACHE_KEY_BASE, PK),
      JSON.stringify(['wss://nostr.mom']),
    );
    // Stale cache (no timestamp) → the network path re-parses both lists.
    fetchList.mockResolvedValue(list());
    fetchLatest.mockResolvedValue(inboxEvent(['wss://nostr.mom']));
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.loadRelaysFromCache(PK);
    });
    const nip65 = result.current.nip65Relays;
    await act(async () => {
      await result.current.loadRelays(PK);
    });
    await waitFor(() => expect(fetchLatest).toHaveBeenCalled());
    const inbox = result.current.dmInboxRelays;
    expect(inbox).toEqual(['wss://nostr.mom']);
    expect(result.current.nip65Relays).toBe(nip65);
    // A second refresh with the same lists keeps both identities.
    await act(async () => {
      await result.current.loadRelays(PK);
    });
    await waitFor(() => expect(fetchLatest).toHaveBeenCalledTimes(2));
    expect(result.current.nip65Relays).toBe(nip65);
    expect(result.current.dmInboxRelays).toBe(inbox);
  });

  it('adopts a list whose content changed', async () => {
    fetchLatest.mockResolvedValue(null);
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.applyPublishedRelayList(PK, list());
      await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom']);
    });
    const nip65 = result.current.nip65Relays;
    const inbox = result.current.dmInboxRelays;
    await act(async () => {
      await result.current.applyPublishedRelayList(PK, [
        { url: 'wss://relay.primal.net', read: true, write: false },
      ]);
      await result.current.applyPublishedDmInbox(PK, ['wss://nostr.mom', 'wss://auth.nostr1.com']);
    });
    expect(result.current.nip65Relays).not.toBe(nip65);
    expect(result.current.nip65Relays[0].write).toBe(false);
    expect(result.current.dmInboxRelays).not.toBe(inbox);
    expect(result.current.dmInboxRelays).toHaveLength(2);
  });
});

describe('relayListsHydrated (#1390: outbox leasing waits for it)', () => {
  it('stays false while the DM inbox read is pending, even with a fresh NIP-65 cache', async () => {
    // A fresh NIP-65 cache: loadRelays settles at once...
    await AsyncStorage.setItem(
      perAccountKey(RELAY_LIST_CACHE_KEY_BASE, PK),
      JSON.stringify([{ url: 'wss://relay.primal.net', read: true, write: true }]),
    );
    await AsyncStorage.setItem(
      perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, PK),
      String(Date.now()),
    );
    // ...but no inbox was ever cached, and the relays haven't answered yet.
    let answer!: (event: unknown) => void;
    fetchLatest.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.loadRelays(PK);
    });
    expect(result.current.relayListsHydrated).toBe(false);
    await act(async () => {
      answer(inboxEvent(['wss://inbox.example']));
    });
    await waitFor(() => expect(result.current.relayListsHydrated).toBe(true));
    expect(result.current.dmInboxRelays).toEqual(['wss://inbox.example']);
  });

  it('a cached inbox list (even an empty one) makes the inbox known before the relays answer', async () => {
    await AsyncStorage.setItem(perAccountKey(DM_INBOX_RELAYS_CACHE_KEY_BASE, PK), '[]');
    fetchLatest.mockReturnValueOnce(new Promise(() => {})); // never answers
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.loadRelays(PK);
    });
    await waitFor(() => expect(result.current.relayListsHydrated).toBe(true));
  });

  it('a failed discovery restores the expired cached list before it counts as known', async () => {
    const cachedList = [{ url: 'wss://cached-only.example', read: true, write: true }];
    await AsyncStorage.setItem(
      perAccountKey(RELAY_LIST_CACHE_KEY_BASE, PK),
      JSON.stringify(cachedList),
    );
    // Expired: the network is asked, and fails.
    await AsyncStorage.setItem(perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, PK), '1');
    fetchList.mockResolvedValueOnce(null);
    fetchLatest.mockResolvedValue(null);
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.loadRelays(PK);
    });
    // The cached relays are in the viewer's lists (so never leased as someone else's).
    expect(result.current.nip65Relays).toEqual(cachedList);
    await waitFor(() => expect(result.current.relayListsHydrated).toBe(true));
  });

  it('adopting just one list does not hydrate; both known does', async () => {
    fetchLatest.mockResolvedValue(null);
    const { result } = renderHook(() => useNip65Relays());
    await act(async () => {
      await result.current.applyPublishedRelayList(PK, [
        { url: 'wss://nostr.mom', read: true, write: true },
      ]);
    });
    expect(result.current.relayListsHydrated).toBe(false);
    await act(async () => {
      await result.current.applyPublishedDmInbox(PK, ['wss://inbox.example']);
    });
    expect(result.current.relayListsHydrated).toBe(true);
    await act(async () => {
      result.current.resetRelayLists();
    });
    expect(result.current.relayListsHydrated).toBe(false);
    // The inbox alone doesn't either.
    await act(async () => {
      await result.current.applyPublishedDmInbox(PK, ['wss://inbox.example']);
    });
    expect(result.current.relayListsHydrated).toBe(false);
  });

  it('hydrates when the editor adopts a NIP-65 list during discovery (the inbox read still runs)', async () => {
    fetchLatest.mockResolvedValue(null);
    let finish!: (list: unknown) => void;
    fetchList.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useNip65Relays());
    let loading!: Promise<string[]>;
    act(() => {
      loading = result.current.loadRelays(PK);
    });
    // The editor adopts a NIP-65 list mid-load: that invalidates the load's
    // generation, so it no longer adopts its own result...
    await act(async () => {
      await result.current.applyPublishedRelayList(PK, [
        { url: 'wss://nostr.mom', read: true, write: true },
      ]);
    });
    expect(result.current.relayListsHydrated).toBe(false);
    // ...but the load still settles, and still reads the inbox.
    await act(async () => {
      finish([{ url: 'wss://relay.primal.net', read: true, write: true }]);
      await loading;
    });
    await waitFor(() => expect(result.current.relayListsHydrated).toBe(true));
    expect(fetchLatest).toHaveBeenCalled();
  });

  it('a load for a previous identity, finishing after a reset, does not hydrate the next', async () => {
    fetchLatest.mockResolvedValue(null);
    let finish!: (list: unknown) => void;
    fetchList.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useNip65Relays());
    let loading!: Promise<string[]>;
    act(() => {
      loading = result.current.loadRelays(PK);
    });
    await act(async () => {
      result.current.resetRelayLists(); // logout / account switch mid-load
      finish([{ url: 'wss://relay.primal.net', read: true, write: true }]);
      await loading;
    });
    expect(result.current.relayListsHydrated).toBe(false);
  });
});
