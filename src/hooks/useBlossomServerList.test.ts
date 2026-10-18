import {
  loadAppRelayPrefs,
  setAppRelayEnabled,
  forgetAppRelayPrefs,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useBlossomServerList } from './useBlossomServerList';
import { fetchLatestReplaceable, publishToRelays } from '../services/nostrRelayLists';
import {
  DEFAULT_BLOSSOM_SERVER,
  setBlossomServer,
  setBlossomServers,
} from '../services/walletStorageService';

const PK = 'a'.repeat(64);
const mockSign = jest.fn();
let mockPubkey = 'a'.repeat(64);
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockPubkey, relays: [], signEvent: mockSign }),
}));
jest.mock('../services/nostrService', () => ({ DEFAULT_RELAYS: ['wss://default.example'] }));
jest.mock('../services/nostrRelayLists', () => ({
  fetchLatestReplaceable: jest.fn(),
  publishToRelays: jest.fn(),
}));
const fetchLatest = fetchLatestReplaceable as jest.Mock;
const publish = publishToRelays as jest.Mock;
const published = { kind: 10063, created_at: 1, tags: [['server', 'https://remote.example']] };

beforeEach(async () => {
  await AsyncStorage.clear();
  mockPubkey = PK;
  jest.clearAllMocks();
  fetchLatest.mockResolvedValue(null);
  mockSign.mockImplementation(async (e: object) => ({ ...e, id: 'i', sig: 's', pubkey: PK }));
});

it("keeps a server the user set before lists existed, and doesn't adopt a published list", async () => {
  await setBlossomServer('https://mine.example');
  fetchLatest.mockResolvedValue(published);
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.servers).toEqual(['https://mine.example']);
  expect(fetchLatest).not.toHaveBeenCalled();
});

it('adopts a published list on a default device, with editing frozen until it loads', async () => {
  let finish!: (v: unknown) => void;
  fetchLatest.mockReturnValue(new Promise((r) => (finish = r)));
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.servers).toEqual([DEFAULT_BLOSSOM_SERVER]));
  expect(result.current.editable).toBe(false);
  act(() => {
    result.current.addServer('https://mid-load.example');
  });
  await act(async () => finish(published));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.servers).toEqual(['https://remote.example']);
});

it('remembers unpublished changes across visits, and a successful publish clears them', async () => {
  const first = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(first.result.current.editable).toBe(true));
  act(() => {
    first.result.current.addServer('https://backup.example');
  });
  expect(first.result.current.dirty).toBe(true);
  first.unmount();

  const second = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(second.result.current.editable).toBe(true));
  expect(second.result.current.dirty).toBe(true);
  expect(second.result.current.servers).toEqual([DEFAULT_BLOSSOM_SERVER, 'https://backup.example']);

  publish.mockResolvedValueOnce([{ url: 'wss://default.example', ok: false }]);
  await act(async () => {
    expect(await second.result.current.publish()).toEqual({
      ok: false,
      error: 'none-accepted',
      results: [{ url: 'wss://default.example', ok: false }],
    });
  });
  expect(second.result.current.dirty).toBe(true);

  publish.mockResolvedValueOnce([{ url: 'wss://default.example', ok: true }]);
  await act(async () => {
    expect((await second.result.current.publish()).ok).toBe(true);
  });
  expect(second.result.current.dirty).toBe(false);
});

it('signs a publish after a future-dated published list', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.editable).toBe(true));
  act(() => {
    result.current.addServer('https://backup.example');
  });
  fetchLatest.mockResolvedValue({ ...published, created_at: future });
  publish.mockResolvedValueOnce([{ url: 'wss://default.example', ok: true }]);
  await act(async () => {
    await result.current.publish();
  });
  expect(mockSign.mock.calls.at(-1)[0].created_at).toBeGreaterThan(future);
});

it('keeps a list edited during a publish publishable on the next visit', async () => {
  const { result, unmount } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.editable).toBe(true));
  act(() => {
    result.current.addServer('https://backup.example');
  });
  publish.mockImplementationOnce(async () => {
    // Another screen instance edits the list before the relays answer.
    await setBlossomServers([DEFAULT_BLOSSOM_SERVER, 'https://newer.example']);
    return [{ url: 'wss://default.example', ok: true }];
  });
  await act(async () => {
    await result.current.publish();
  });
  unmount();
  const next = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(next.result.current.editable).toBe(true));
  expect(next.result.current.servers).toEqual([DEFAULT_BLOSSOM_SERVER, 'https://newer.example']);
  expect(next.result.current.dirty).toBe(true);
});

it('lets a list that was never published be published without an edit', async () => {
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.editable).toBe(true));
  expect(result.current.dirty).toBe(true);
});

it('treats a saved-but-unchanged default as unconfigured, adopting a published list', async () => {
  await setBlossomServer(DEFAULT_BLOSSOM_SERVER); // the old field saved it on blur
  fetchLatest.mockResolvedValue(published);
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.servers).toEqual(['https://remote.example']);
  expect(result.current.dirty).toBe(false); // adopted = already published
});

it("doesn't let one account's publish disable another account's Publish", async () => {
  const a = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(a.result.current.editable).toBe(true));
  publish.mockResolvedValueOnce([{ url: 'wss://default.example', ok: true }]);
  await act(async () => {
    await a.result.current.publish();
  });
  expect(a.result.current.dirty).toBe(false);
  a.unmount();

  mockPubkey = 'b'.repeat(64);
  mockSign.mockImplementation(async (e: object) => ({
    ...e,
    id: 'i',
    sig: 's',
    pubkey: mockPubkey,
  }));
  const b = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(b.result.current.editable).toBe(true));
  expect(b.result.current.dirty).toBe(true);
});

it('refuses to publish a list with no valid https server (never an empty list)', async () => {
  await setBlossomServer('http://legacy.example');
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.editable).toBe(true));
  await act(async () => {
    expect(await result.current.publish()).toEqual({ ok: false, error: 'no-valid-servers' });
  });
  expect(mockSign).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it("doesn't carry one account's future-dated list timestamp into another's publish", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  fetchLatest.mockImplementation(async (pk: string) =>
    pk === PK ? { ...published, created_at: future } : null,
  );
  publish.mockResolvedValue([{ url: 'wss://default.example', ok: true }]);
  const view = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(view.result.current.editable).toBe(true));
  await act(async () => {
    await view.result.current.publish(); // account A: signed after its future list
  });
  mockPubkey = 'b'.repeat(64);
  mockSign.mockImplementation(async (e: object) => ({
    ...e,
    id: 'i',
    sig: 's',
    pubkey: mockPubkey,
  }));
  view.rerender({});
  await waitFor(() => expect(view.result.current.editable).toBe(true));
  await act(async () => {
    await view.result.current.publish(); // account B
  });
  expect(mockSign.mock.calls.at(-1)[0].created_at).toBeLessThan(future);
});

it('ignores a second Publish tap while one is in flight (one signing prompt)', async () => {
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.editable).toBe(true));
  publish.mockResolvedValue([{ url: 'wss://default.example', ok: true }]);
  let first!: Promise<unknown>;
  let second!: Promise<unknown>;
  await act(async () => {
    first = result.current.publish();
    second = result.current.publish();
    await Promise.all([first, second]);
  });
  expect(await second).toEqual({ ok: false, error: 'busy' });
  expect(mockSign).toHaveBeenCalledTimes(1);
});

it('normalizes a legacy server before migrating it, so publishing clears the change', async () => {
  await setBlossomServer('https://mine.example/');
  const { result } = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(result.current.editable).toBe(true));
  expect(result.current.servers).toEqual(['https://mine.example']);
  act(() => {
    result.current.addServer('https://mine.example');
  });
  expect(result.current.servers).toEqual(['https://mine.example']); // no duplicate
  publish.mockResolvedValueOnce([{ url: 'wss://default.example', ok: true }]);
  await act(async () => {
    await result.current.publish();
  });
  expect(result.current.dirty).toBe(false);
});

it("doesn't apply an adopted list to the screen after switching account mid-load", async () => {
  fetchLatest.mockResolvedValue(published);
  // Hold the first storage write until the account has switched.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realSet = AsyncStorage.setItem;
  let held = false;
  AsyncStorage.setItem = (async (k: string, v: string) => {
    if (!held && k === 'blossom_servers_v1') {
      held = true;
      await gate;
    }
    return realSet(k, v);
  }) as typeof AsyncStorage.setItem;
  try {
    const view = renderHook(() => useBlossomServerList());
    await waitFor(() => expect(held).toBe(true));
    mockPubkey = 'b'.repeat(64);
    fetchLatest.mockResolvedValue(null);
    view.rerender({});
    await act(async () => release());
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    // The server list is device-wide, but B never published: Publish stays available.
    expect(view.result.current.dirty).toBe(true);
  } finally {
    AsyncStorage.setItem = realSet;
  }
});

it('signs after a previously published list even when a later lookup fails (new visit)', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  fetchLatest.mockResolvedValue({ ...published, created_at: future });
  publish.mockResolvedValue([{ url: 'wss://default.example', ok: true }]);
  const first = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(first.result.current.editable).toBe(true));
  await act(async () => {
    await first.result.current.publish();
  });
  first.unmount();

  fetchLatest.mockResolvedValue(null); // the next lookup fails
  const second = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(second.result.current.editable).toBe(true));
  act(() => {
    second.result.current.addServer('https://later.example');
  });
  await act(async () => {
    await second.result.current.publish();
  });
  expect(mockSign.mock.calls.at(-1)[0].created_at).toBeGreaterThan(future);
});

it('retries published-list discovery after hydration and indexer edits', async () => {
  await forgetAppRelayPrefs(PK);
  setCurrentUserPubkey(PK);
  const h = renderHook(() => useBlossomServerList());
  await waitFor(() => expect(h.result.current.loading).toBe(false));
  expect(fetchLatest.mock.lastCall[2]).not.toContain(RELAY_LIST_INDEXERS[0]);
  await act(async () => loadAppRelayPrefs(PK));
  await waitFor(() => expect(h.result.current.loading).toBe(false));
  expect(fetchLatest.mock.lastCall[2]).toContain(RELAY_LIST_INDEXERS[0]);
  await act(async () => setAppRelayEnabled(PK, 'indexers', RELAY_LIST_INDEXERS[0], false));
  await waitFor(() => expect(h.result.current.loading).toBe(false));
  expect(fetchLatest.mock.lastCall[2]).not.toContain(RELAY_LIST_INDEXERS[0]);
  act(() => h.result.current.addServer('https://draft.example'));
  await act(async () => setAppRelayEnabled(PK, 'indexers', RELAY_LIST_INDEXERS[0], true));
  await waitFor(() => expect(h.result.current.loading).toBe(false));
  expect(h.result.current.servers).toContain('https://draft.example');
  h.unmount();
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(PK);
});
