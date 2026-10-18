import {
  loadAppRelayPrefs,
  setAppRelayEnabled,
  forgetAppRelayPrefs,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useRelayListEditor } from './useRelayListEditor';
import { fetchLatestReplaceable, publishToRelays } from '../services/nostrRelayLists';

const mockSign = jest.fn();
const ADOPTED = { adopted: true, baseline: 0 };
const mockApply = jest.fn().mockResolvedValue(ADOPTED);
const mockApplyInbox = jest.fn().mockResolvedValue(ADOPTED);
const PUBLISHED = [
  { url: 'wss://relay.primal.net', read: true, write: true },
  { url: 'wss://nostr.land', read: true, write: true },
];
let mockNip65: typeof PUBLISHED = PUBLISHED;
let mockPubkey = 'a'.repeat(64);
let mockInbox: string[] = [];
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({
    pubkey: mockPubkey,
    relays: PUBLISHED,
    nip65Relays: mockNip65,
    dmInboxRelays: mockInbox,
    signEvent: mockSign,
    applyPublishedRelayList: mockApply,
    applyPublishedDmInbox: mockApplyInbox,
  }),
}));
jest.mock('../services/nostrService', () => ({ DEFAULT_RELAYS: ['wss://default.example'] }));
// created_at of the list the app last adopted, per kind.
const mockStored: Record<number, number> = {};
jest.mock('../contexts/useNip65Relays', () => ({
  readAdoptedCreatedAt: jest.fn(async (_pk: string, kind: number) => mockStored[kind] ?? 0),
}));
jest.mock('../services/backgroundDmService', () => ({
  rearmBackgroundDmWatchForActiveIdentity: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/nostrRelayLists', () => ({
  fetchLatestReplaceable: jest.fn(),
  publishToRelays: jest.fn(),
}));
const fetchLatest = fetchLatestReplaceable as jest.Mock;
/** Network state per kind: 10002 → relay rows (as r tags), 10050 → inbox URLs. */
let net10002: { url: string; read: boolean; write: boolean }[] | null = null;
let net10050: string[] | null = ['wss://relay.damus.io'];
let net10002CreatedAt = 1;
const asEvent = (kind: number, tags: string[][]) => ({
  kind,
  tags,
  created_at: kind === 10002 ? net10002CreatedAt : 1,
});
function mockNetwork() {
  fetchLatest.mockImplementation(async (_pk: string, kind: number) => {
    if (kind === 10002)
      return net10002
        ? asEvent(
            10002,
            net10002.map((r) =>
              r.read && r.write ? ['r', r.url] : ['r', r.url, r.read ? 'read' : 'write'],
            ),
          )
        : null;
    return net10050
      ? asEvent(
          10050,
          net10050.map((u) => ['relay', u]),
        )
      : null;
  });
}
const publish = publishToRelays as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyInbox.mockResolvedValue(ADOPTED);
  mockApply.mockResolvedValue(ADOPTED);
  mockNip65 = PUBLISHED;
  mockPubkey = 'a'.repeat(64);
  mockInbox = [];
  net10002 = null; // network unchanged / unreachable → keep the cached list
  net10050 = ['wss://relay.damus.io'];
  net10002CreatedAt = 1;
  delete mockStored[10002];
  delete mockStored[10050];
  mockNetwork();
  mockSign.mockImplementation(async (e: object) => ({
    ...e,
    id: 'id',
    sig: 'sig',
    pubkey: 'a'.repeat(64),
  }));
});

async function setup() {
  const h = renderHook(() => useRelayListEditor());
  await waitFor(() => expect(h.result.current.inboxLoading).toBe(false));
  await waitFor(() => expect(h.result.current.nip65Loading).toBe(false));
  return h;
}

it('removes a published relay, adds one, and publishes a kind 10002 to old + new relays', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const { result } = await setup();
  act(() => {
    result.current.removeNip65('wss://nostr.land');
    result.current.addNip65('wss://nostr.mom');
  });
  let outcome;
  await act(async () => {
    outcome = await result.current.publishNip65();
  });
  expect(outcome).toMatchObject({ ok: true });
  const signed = mockSign.mock.calls[0][0];
  expect(signed.kind).toBe(10002);
  expect(signed.tags).toEqual([
    ['r', 'wss://relay.primal.net'],
    ['r', 'wss://nostr.mom'],
  ]);
  // The old list is replaced where it lived (nostr.land) as well as on the new relays.
  expect(publish.mock.calls[0][1]).toEqual(
    expect.arrayContaining(['wss://nostr.land', 'wss://nostr.mom', 'wss://purplepag.es']),
  );
  expect(mockApply).toHaveBeenCalledWith(
    'a'.repeat(64),
    [
      { url: 'wss://relay.primal.net', read: true, write: true },
      { url: 'wss://nostr.mom', read: true, write: true },
    ],
    expect.any(Number),
  );
});

it('refuses to publish an empty list or one with no write relay', async () => {
  const { result } = await setup();
  act(() => {
    result.current.toggleNip65('wss://relay.primal.net', 'write');
    result.current.toggleNip65('wss://nostr.land', 'write');
  });
  await act(async () => {
    expect(await result.current.publishNip65()).toEqual({ ok: false, error: 'no-write' });
  });
  act(() => {
    result.current.removeNip65('wss://relay.primal.net');
    result.current.removeNip65('wss://nostr.land');
  });
  await act(async () => {
    expect(await result.current.publishNip65()).toEqual({ ok: false, error: 'empty' });
  });
  expect(mockSign).not.toHaveBeenCalled();
});

it('rejects local/insecure relays when adding', async () => {
  const { result } = await setup();
  act(() => {
    expect(result.current.addNip65('ws://localhost:10547')).toBe(false);
    expect(result.current.addInbox('ws://relay.example')).toBe(false);
  });
});

it('does not adopt the list when no relay accepted it', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: false, message: 'timed out' }]);
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  await act(async () => {
    expect(await result.current.publishNip65()).toMatchObject({
      ok: false,
      error: 'none-accepted',
    });
  });
  expect(mockApply).not.toHaveBeenCalled();
});

it('publishes the DM inbox list as kind 10050', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const { result } = await setup();
  expect(result.current.inboxDraft).toEqual(['wss://relay.damus.io']);
  act(() => {
    result.current.removeInbox('wss://relay.damus.io');
    result.current.addInbox('wss://nostr.mom');
  });
  await act(async () => {
    expect(await result.current.publishInbox()).toMatchObject({ ok: true });
  });
  expect(mockSign.mock.calls[0][0]).toMatchObject({
    kind: 10050,
    tags: [['relay', 'wss://nostr.mom']],
  });
});

it('reports a declined signature without publishing', async () => {
  mockSign.mockResolvedValue(null);
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  await act(async () => {
    expect(await result.current.publishNip65()).toEqual({ ok: false, error: 'not-signed' });
  });
  expect(publish).not.toHaveBeenCalled();
});

it('loads the CURRENT published list before editing, so a stale cache is never published', async () => {
  // The cache says localhost (stale); the network has the list set in another client.
  const fresh = [
    { url: 'wss://relay.primal.net', read: true, write: true },
    { url: 'wss://nostr.mom', read: true, write: true },
  ];
  net10002 = fresh;
  const h = renderHook(() => useRelayListEditor());
  expect(h.result.current.nip65Loading).toBe(true);
  await act(async () => {
    // Publishing is blocked while the current list is loading.
    expect(await h.result.current.publishNip65()).toEqual({ ok: false, error: 'not-signed' });
  });
  await waitFor(() => expect(h.result.current.nip65Loading).toBe(false));
  expect(mockApply).toHaveBeenCalledWith('a'.repeat(64), fresh, expect.any(Number));
  expect(mockSign).not.toHaveBeenCalled();
});

it('blocks edits while the current lists are still loading', async () => {
  let release!: (v: null) => void;
  fetchLatest.mockImplementation((_pk: string, kind: number) =>
    kind === 10002 ? new Promise((r) => (release = r)) : Promise.resolve(null),
  );
  const h = renderHook(() => useRelayListEditor());
  expect(h.result.current.nip65Editable).toBe(false);
  act(() => {
    expect(h.result.current.addNip65('wss://nostr.mom')).toBe(false);
  });
  expect(h.result.current.nip65Dirty).toBe(false);
  await act(async () => release(null));
  await waitFor(() => expect(h.result.current.nip65Editable).toBe(true));
});

it('adopts exactly the signed list (non-public rows dropped), not the raw draft', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  // The current list still holds a local relay; it's shown but never published.
  mockNip65 = [
    { url: 'wss://relay.primal.net', read: true, write: true },
    { url: 'ws://localhost:10547', read: true, write: true },
  ];
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  await act(async () => {
    await result.current.publishNip65();
  });
  const adopted = mockApply.mock.calls.at(-1)?.[1];
  expect(adopted).toEqual([
    { url: 'wss://relay.primal.net', read: true, write: true },
    { url: 'wss://nostr.mom', read: true, write: true },
  ]);
});

it('starts READING newly published DM inbox relays (so DMs sent there arrive)', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const { result } = await setup();
  act(() => {
    result.current.addInbox('wss://nostr.mom');
  });
  await act(async () => {
    await result.current.publishInbox();
  });
  expect(mockApplyInbox).toHaveBeenCalledWith(
    'a'.repeat(64),
    ['wss://relay.damus.io', 'wss://nostr.mom'],
    expect.any(Number),
  );
});

it('freezes editing while a publish is in flight, so no edit is lost', async () => {
  let finish!: (v: unknown) => void;
  publish.mockReturnValue(new Promise((r) => (finish = r)));
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  let pending!: Promise<unknown>;
  act(() => {
    pending = result.current.publishNip65();
  });
  await waitFor(() => expect(result.current.publishing).toBe('nip65'));
  act(() => {
    expect(result.current.addNip65('wss://relay.snort.social')).toBe(false);
  });
  await act(async () => {
    expect(await result.current.publishInbox()).toEqual({ ok: false, error: 'busy' });
  });
  await act(async () => {
    finish([{ url: 'wss://relay.primal.net', ok: true }]);
    await pending;
  });
});

it("drops the previous account's draft when the identity changes", async () => {
  const h = await setup();
  act(() => {
    h.result.current.addNip65('wss://nostr.mom');
  });
  expect(h.result.current.nip65Dirty).toBe(true);
  mockPubkey = 'c'.repeat(64);
  h.rerender({});
  await waitFor(() => expect(h.result.current.nip65Loading).toBe(false));
  expect(h.result.current.nip65Dirty).toBe(false);
  expect(h.result.current.nip65Draft.some((r) => r.url === 'wss://nostr.mom')).toBe(false);
});

it('falls back to the known inbox list when the lookup fails (never treats it as empty)', async () => {
  mockInbox = ['wss://relay.primal.net', 'wss://nostr.mom'];
  net10050 = null; // lookup failed / timed out
  const { result } = await setup();
  expect(result.current.inboxDraft).toEqual(['wss://relay.primal.net', 'wss://nostr.mom']);
});

it('rejects an event signed by a different identity', async () => {
  mockSign.mockImplementation(async (e: object) => ({
    ...e,
    id: 'id',
    sig: 'sig',
    pubkey: 'c'.repeat(64),
  }));
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  await act(async () => {
    expect(await result.current.publishNip65()).toEqual({ ok: false, error: 'not-signed' });
  });
  expect(publish).not.toHaveBeenCalled();
});

it('does not adopt a publish that completes after the user switched accounts', async () => {
  let finish!: (v: unknown) => void;
  publish.mockReturnValue(new Promise((r) => (finish = r)));
  const h = await setup();
  act(() => {
    h.result.current.addNip65('wss://nostr.mom');
  });
  let pending!: Promise<unknown>;
  act(() => {
    pending = h.result.current.publishNip65();
  });
  await waitFor(() => expect(publish).toHaveBeenCalled());
  mockPubkey = 'c'.repeat(64); // switch identity while the publish is in flight
  h.rerender({});
  await act(async () => {
    finish([{ url: 'wss://relay.primal.net', ok: true }]);
    await pending;
  });
  expect(
    mockApply.mock.calls.some((c) =>
      (c[1] as { url: string }[]).some((r) => r.url === 'wss://nostr.mom'),
    ),
  ).toBe(false);
});

it('adopts an inbox list it discovers app-wide, so the app listens there', async () => {
  net10050 = ['wss://relay.primal.net', 'wss://nostr.mom'];
  await setup();
  expect(mockApplyInbox).toHaveBeenCalledWith(
    'a'.repeat(64),
    ['wss://relay.primal.net', 'wss://nostr.mom'],
    expect.any(Number),
  );
});

it('uses the inbox list the app learns about after the screen opened', async () => {
  net10050 = null; // lookup fails
  mockInbox = [];
  const h = await setup();
  expect(h.result.current.inboxDraft).toEqual([]);
  mockInbox = ['wss://relay.primal.net', 'wss://nostr.mom']; // provider finishes loading later
  h.rerender({});
  await waitFor(() =>
    expect(h.result.current.inboxDraft).toEqual(['wss://relay.primal.net', 'wss://nostr.mom']),
  );
});

it('looks up the inbox list on just-discovered NIP-65 write relays too', async () => {
  net10002 = [{ url: 'wss://new-write.example', read: false, write: true }];
  await setup();
  const inboxCall = fetchLatest.mock.calls.find((c) => c[1] === 10050);
  expect(inboxCall?.[2]).toContain('wss://new-write.example');
});

it('shows one row per relay and lets each permission be toggled independently', async () => {
  mockNip65 = [
    { url: 'wss://nos.lol', read: true, write: false },
    { url: 'wss://nos.lol', read: false, write: true },
  ];
  const { result } = await setup();
  expect(result.current.nip65Draft).toEqual([{ url: 'wss://nos.lol', read: true, write: true }]);
  act(() => {
    result.current.toggleNip65('wss://nos.lol', 'write');
  });
  expect(result.current.nip65Draft).toEqual([{ url: 'wss://nos.lol', read: true, write: false }]);
});

it('also publishes to the discovery/default relays so no stale copy survives there', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  await act(async () => {
    await result.current.publishNip65();
  });
  expect(publish.mock.calls[0][1]).toEqual(expect.arrayContaining(['wss://default.example']));
});

it('signs each update strictly newer than the existing list, even with clock skew', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const future = Math.floor(Date.now() / 1000) + 3600; // another client's clock is an hour ahead
  net10002CreatedAt = future;
  net10002 = [{ url: 'wss://relay.primal.net', read: true, write: true }];
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  await act(async () => {
    await result.current.publishNip65();
  });
  const first = mockSign.mock.calls[0][0].created_at;
  expect(first).toBeGreaterThan(future);
  act(() => {
    result.current.addNip65('wss://relay.snort.social');
  });
  await act(async () => {
    await result.current.publishNip65();
  });
  expect(mockSign.mock.calls[1][0].created_at).toBeGreaterThan(first);
});

it('finishes loading even if adopting the list fails (e.g. storage full)', async () => {
  mockApply.mockRejectedValueOnce(new Error('disk full'));
  net10002 = [{ url: 'wss://relay.primal.net', read: true, write: true }];
  const h = renderHook(() => useRelayListEditor());
  await waitFor(() => expect(h.result.current.nip65Loading).toBe(false));
  await waitFor(() => expect(h.result.current.inboxLoading).toBe(false));
});

it("does not carry one account's list timestamp into another's publish", async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  net10002CreatedAt = Math.floor(Date.now() / 1000) + 3600; // account A: future-dated list
  net10002 = [{ url: 'wss://relay.primal.net', read: true, write: true }];
  const h = await setup();
  net10002 = null; // account B has no published list
  mockPubkey = 'c'.repeat(64);
  mockSign.mockImplementation(async (e: object) => ({
    ...e,
    id: 'id',
    sig: 'sig',
    pubkey: 'c'.repeat(64),
  }));
  h.rerender({});
  await waitFor(() => expect(h.result.current.nip65Loading).toBe(false));
  act(() => {
    h.result.current.addNip65('wss://nostr.mom');
  });
  await act(async () => {
    await h.result.current.publishNip65();
  });
  const signedAt = mockSign.mock.calls.at(-1)?.[0].created_at;
  expect(signedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5);
});

it('keeps the known inbox list when the discovered copy is older (never restores stale relays)', async () => {
  mockInbox = ['wss://new-inbox.example'];
  net10050 = ['wss://old-inbox.example'];
  mockApplyInbox.mockResolvedValue({ adopted: false, baseline: 999 }); // the app refuses the older copy
  const { result } = await setup();
  expect(result.current.inboxDraft).toEqual(['wss://new-inbox.example']);
  // ...and the lookup searched the known inbox relays themselves.
  const inboxCall = fetchLatest.mock.calls.find((c) => c[1] === 10050);
  expect(inboxCall?.[2]).toContain('wss://new-inbox.example');
});

it("keeps edits and doesn't claim success when the app refuses the published list", async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  mockApply.mockResolvedValue({ adopted: false, baseline: 10 });
  await act(async () => {
    expect(await result.current.publishNip65()).toMatchObject({ ok: false, error: 'superseded' });
  });
  expect(result.current.nip65Dirty).toBe(true);
});

it("signs after the app's baseline even when the discovered copy was older", async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const future = Math.floor(Date.now() / 1000) + 3600;
  net10050 = ['wss://old.example']; // discovered copy (created_at 1)...
  mockApplyInbox.mockResolvedValueOnce({ adopted: false, baseline: future }); // ...refused: app holds a newer one
  const { result } = await setup();
  act(() => {
    result.current.addInbox('wss://nostr.mom');
  });
  await act(async () => {
    await result.current.publishInbox();
  });
  expect(mockSign.mock.calls.at(-1)?.[0].created_at).toBeGreaterThan(future);
});

it("signs after the app's stored baseline even when the lookup finds no list", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  mockStored[10002] = future;
  mockStored[10050] = future;
  net10002 = null;
  net10050 = null;
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
    result.current.addInbox('wss://nostr.mom');
  });
  await act(async () => {
    await result.current.publishNip65();
  });
  await act(async () => {
    await result.current.publishInbox();
  });
  expect(mockSign.mock.calls[0][0].created_at).toBeGreaterThan(future);
  expect(mockSign.mock.calls[1][0].created_at).toBeGreaterThan(future);
});

it("doesn't restore the previous account's draft when the switch lands during adoption", async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  let finishAdopt!: (v: unknown) => void;
  const h = await setup();
  mockApply.mockReturnValueOnce(new Promise((r) => (finishAdopt = r)));
  act(() => {
    h.result.current.addNip65('wss://nostr.mom');
  });
  let pending!: Promise<unknown>;
  act(() => {
    pending = h.result.current.publishNip65();
  });
  await waitFor(() =>
    expect(mockApply).toHaveBeenCalledWith('a'.repeat(64), expect.anything(), expect.any(Number)),
  );
  mockPubkey = 'c'.repeat(64); // switch identity while adoption awaits storage
  h.rerender({});
  await act(async () => {
    finishAdopt(ADOPTED);
    await pending;
  });
  await waitFor(() => expect(h.result.current.nip65Loading).toBe(false));
  expect(h.result.current.nip65Draft.some((r) => r.url === 'wss://nostr.mom')).toBe(false);
});

it('starts the inbox draft from the known list when loading fails (never publishes it empty)', async () => {
  mockInbox = ['wss://relay.primal.net', 'wss://nostr.mom'];
  mockApply.mockRejectedValueOnce(new Error('disk full'));
  net10002 = [{ url: 'wss://relay.primal.net', read: true, write: true }];
  const h = renderHook(() => useRelayListEditor());
  await waitFor(() => expect(h.result.current.inboxLoading).toBe(false));
  expect(h.result.current.inboxDraft).toEqual(['wss://relay.primal.net', 'wss://nostr.mom']);
});

it('signs a retry after the newer list that superseded the previous publish', async () => {
  publish.mockResolvedValue([{ url: 'wss://relay.primal.net', ok: true }]);
  const newer = Math.floor(Date.now() / 1000) + 3600;
  const { result } = await setup();
  act(() => {
    result.current.addNip65('wss://nostr.mom');
  });
  mockApply.mockResolvedValueOnce({ adopted: false, baseline: newer });
  await act(async () => {
    expect(await result.current.publishNip65()).toMatchObject({ error: 'superseded' });
  });
  await act(async () => {
    await result.current.publishNip65();
  });
  expect(mockSign.mock.calls[1][0].created_at).toBeGreaterThan(newer);
});

it('marks the shared draft dirty when details toggles a permission without publishing', async () => {
  const { result, rerender } = await setup();
  expect(result.current.nip65Dirty).toBe(false);
  act(() => result.current.toggleNip65('wss://relay.primal.net', 'read'));
  rerender({});
  expect(result.current.nip65Dirty).toBe(true);
  expect(result.current.nip65Draft[0]).toEqual({
    url: 'wss://relay.primal.net',
    read: false,
    write: true,
  });
  expect(mockSign).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it('displays only LAN lists and disables public edits for a locked identity', async () => {
  mockPubkey = [...TEST_ACCOUNT_PUBKEYS][0];
  const { result } = renderHook(() => useRelayListEditor());
  await waitFor(() => expect(result.current.inboxLoading).toBe(false));
  expect(result.current.nip65Draft).toEqual([{ url: TEST_RELAY_URL, read: true, write: true }]);
  expect(result.current.inboxDraft).toEqual([TEST_RELAY_URL]);
  expect(result.current.addNip65('wss://public.example')).toBe(false);
  expect(result.current.addInbox('wss://public.example')).toBe(false);
});

it('retries discovery on preference hydration and edits while preserving unsaved drafts', async () => {
  const owner = mockPubkey;
  await forgetAppRelayPrefs(owner);
  setCurrentUserPubkey(owner);
  const h = renderHook(() => useRelayListEditor());
  await waitFor(() => expect(h.result.current.nip65Loading).toBe(false));
  expect(fetchLatest.mock.calls[0][2]).not.toContain(RELAY_LIST_INDEXERS[0]);
  await act(async () => loadAppRelayPrefs(owner));
  await waitFor(() => expect(h.result.current.inboxLoading).toBe(false));
  expect(fetchLatest.mock.calls.at(-1)[2]).toContain(RELAY_LIST_INDEXERS[0]);
  act(() => {
    h.result.current.addNip65('wss://draft.example');
    h.result.current.addInbox('wss://inbox-draft.example');
  });
  await act(async () => setAppRelayEnabled(owner, 'indexers', RELAY_LIST_INDEXERS[0], false));
  await waitFor(() => expect(h.result.current.inboxLoading).toBe(false));
  expect(fetchLatest.mock.calls.at(-1)[2]).not.toContain(RELAY_LIST_INDEXERS[0]);
  expect(h.result.current.nip65Draft.some((r) => r.url === 'wss://draft.example')).toBe(true);
  expect(h.result.current.inboxDraft).toContain('wss://inbox-draft.example');
  h.unmount();
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(owner);
});
