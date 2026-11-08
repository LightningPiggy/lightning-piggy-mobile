import type { Event } from 'nostr-tools';
import type { VerifiedEvent } from 'nostr-tools/pure';
import { TEST_RELAY_URL } from '../config/testRelayLockdown';
import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { pool, releaseNewIdleRelays } from './nostrPool';
import {
  deliverToPeerRelays,
  eventRecipient,
  MAX_EXTRA_RELAYS_PER_SEND,
  planPeerRoutes,
} from './peerOutboxDelivery';
import { clearPeerRelayListCache, getPeerRelayLists, peekPeerRelayLists } from './peerRelayLists';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTACTS_CACHE_KEY_BASE } from '../contexts/nostrCacheKeys';
import { __resetAccountSettingsCacheForTests } from './accountSettingsCache';
import { hasRepliedTo } from './dmRepliedPartners';
import { clearFollowGateStores, publishFollowSet } from './followSetEvents';
import { loadFofCache } from './friendsOfFriendsService';
import { perAccountKey } from './perAccountStorage';
import { WOT_STORAGE_KEY_BASE, type WotTier } from './wotSettingsService';

jest.mock('./nostrPool', () => ({
  pool: {
    publish: jest.fn((relays: string[]) => relays.map(() => Promise.resolve('saved'))),
    querySyncFilters: jest.fn(),
  },
  trackRelays: jest.fn(),
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  releaseNewIdleRelays: jest.fn(),
}));
jest.mock('./appRelayPrefs', () => ({
  enabledAppRelays: (_group: string, list: readonly string[]) => list,
}));
jest.mock('./safetySettingsMigration', () => ({
  ...jest.requireActual('./safetySettingsMigration'),
  ensureSafetySettingsMigrated: jest.fn(async () => {}),
}));
jest.mock('./dmRepliedPartners', () => ({
  loadRepliedPartners: jest.fn(async () => {}),
  hasRepliedTo: jest.fn(() => false),
}));
jest.mock('./friendsOfFriendsService', () => ({
  ...jest.requireActual('./friendsOfFriendsService'),
  loadFofCache: jest.fn(async () => null),
}));

const publish = jest.mocked(pool.publish);
const query = jest.mocked(pool.querySyncFilters);
const sender = 'e'.repeat(64);
const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);
const base = ['wss://base.example.com'];
/** Recipients the user picked: routed whatever the trust tier. */
const chosen = [alice, bob];

const wrapTo = (recipient: string, id = `wrap-${recipient.slice(0, 4)}`): VerifiedEvent =>
  ({
    id,
    pubkey: '0'.repeat(64),
    kind: 1059,
    created_at: 1,
    tags: [['p', recipient]],
    content: 'ciphertext',
    sig: '',
  }) as unknown as VerifiedEvent;

const inboxList = (pubkey: string, relays: string[]): Event => ({
  id: `inbox-${pubkey.slice(0, 4)}`,
  pubkey,
  kind: 10050,
  created_at: 100,
  tags: relays.map((url) => ['relay', url]),
  content: '',
  sig: '',
});

/** Answer lookups from a fixed set of published inbox lists. */
function publishedInboxes(lists: Record<string, string[]>) {
  query.mockImplementation(async (_relays, filters) =>
    (filters[0].authors ?? []).flatMap((pk) => (lists[pk] ? [inboxList(pk, lists[pk])] : [])),
  );
}

beforeEach(async () => {
  clearPeerRelayListCache();
  jest.clearAllMocks();
  query.mockReset();
  clearFollowGateStores();
  __resetAccountSettingsCacheForTests();
  await AsyncStorage.clear();
});

describe('planPeerRoutes', () => {
  it('routes each event to its own recipient, skipping relays already in the base set', () => {
    const lists: Record<string, string[]> = {
      [alice]: ['wss://base.example.com/', 'wss://alice.example.com/'],
      [bob]: ['wss://bob.example.com/'],
    };
    const routes = planPeerRoutes([wrapTo(alice), wrapTo(bob)], (pk) => lists[pk] ?? [], base);
    expect(routes.map((r) => [r.recipient, r.relays])).toEqual([
      [alice, ['wss://alice.example.com/']],
      [bob, ['wss://bob.example.com/']],
    ]);
  });

  it('shares the per-send cap fairly (round-robin) and counts a shared relay once', () => {
    const members = Array.from({ length: 6 }, (_, i) => String(i + 1).repeat(64));
    const relaysFor = (pk: string) => [
      'wss://shared.example.com/',
      ...[1, 2, 3].map((n) => `wss://${pk.slice(0, 2)}-${n}.example.com/`),
    ];
    const routes = planPeerRoutes(
      members.map((pk) => wrapTo(pk)),
      relaysFor,
      base,
      5,
    );
    const distinct = new Set(routes.flatMap((r) => r.relays));
    expect(distinct.size).toBe(5);
    // Every member gets the shared relay; the remaining budget goes one each, in order.
    expect(routes).toHaveLength(6);
    for (const route of routes) expect(route.relays[0]).toBe('wss://shared.example.com/');
    expect(routes.map((r) => r.relays.length)).toEqual([2, 2, 2, 2, 1, 1]);
  });

  it(`never exceeds ${MAX_EXTRA_RELAYS_PER_SEND} extra relays per send by default`, () => {
    const members = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(64, '0'));
    const relaysFor = (pk: string) =>
      [1, 2, 3, 4].map((n) => `wss://${pk.slice(-2)}-${n}.example.com/`);
    const routes = planPeerRoutes(
      members.map((pk) => wrapTo(pk)),
      relaysFor,
      base,
    );
    expect(new Set(routes.flatMap((r) => r.relays)).size).toBe(MAX_EXTRA_RELAYS_PER_SEND);
    // Round-robin: all ten members get their first relay before anyone gets a third.
    expect(routes).toHaveLength(10);
    expect(Math.max(...routes.map((r) => r.relays.length))).toBe(2);
  });

  it('ignores events without a valid recipient', () => {
    expect(eventRecipient({ tags: [['p', 'nope']] })).toBeUndefined();
    expect(
      planPeerRoutes([{ ...wrapTo(alice), tags: [] }], () => ['wss://x.example.com/'], base),
    ).toEqual([]);
  });
});

describe('deliverToPeerRelays', () => {
  it('publishes the same signed event to the recipient inbox, without re-signing', async () => {
    publishedInboxes({ [alice]: ['wss://alice.example.com'] });
    const wrap = wrapTo(alice);
    const report = await deliverToPeerRelays({
      events: [wrap],
      senderPubkey: sender,
      baseRelays: base,
      role: 'inbox',
      chosenRecipients: chosen,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toEqual(['wss://alice.example.com/']);
    expect(publish.mock.calls[0][1]).toBe(wrap);
    expect(report).toEqual({
      relays: ['wss://alice.example.com/'],
      accepted: ['wss://alice.example.com/'],
      cacheHits: 0,
    });
  });

  it('uses a cached list at once, with no lookup', async () => {
    publishedInboxes({ [alice]: ['wss://alice.example.com'] });
    await getPeerRelayLists(alice, { viewerPubkey: sender });
    query.mockClear();
    const report = await deliverToPeerRelays({
      events: [wrapTo(alice)],
      senderPubkey: sender,
      baseRelays: base,
      role: 'inbox',
      chosenRecipients: chosen,
    });
    expect(query).not.toHaveBeenCalled();
    expect(report.cacheHits).toBe(1);
    expect(publish).toHaveBeenCalledWith(['wss://alice.example.com/'], expect.anything());
  });

  it('publishes when a slow lookup resolves within the timeout', async () => {
    let answer!: (events: Event[]) => void;
    query.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const wrap = wrapTo(alice);
    const pending = deliverToPeerRelays({
      events: [wrap],
      senderPubkey: sender,
      baseRelays: base,
      role: 'inbox',
      chosenRecipients: chosen,
      lookupTimeoutMs: 1_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(publish).not.toHaveBeenCalled();
    answer([inboxList(alice, ['wss://alice.example.com'])]);
    await pending;
    expect(publish).toHaveBeenCalledWith(['wss://alice.example.com/'], wrap);
  });

  it('gives up on extras after the lookup timeout but still caches the late answer', async () => {
    let answer!: (events: Event[]) => void;
    query.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const report = await deliverToPeerRelays({
      events: [wrapTo(alice)],
      senderPubkey: sender,
      baseRelays: base,
      role: 'inbox',
      chosenRecipients: chosen,
      lookupTimeoutMs: 5,
    });
    expect(report.relays).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    answer([inboxList(alice, ['wss://alice.example.com'])]);
    await new Promise((r) => setTimeout(r, 0));
    expect(peekPeerRelayLists(alice, sender)?.status).toBe('ok');
  });

  it('still uses a fresh inbox when the retry of an expired kind outlasts the timeout', async () => {
    // A partial lookup (no EOSE) finds the inbox; the 10002 stays unknown.
    publishedInboxes({ [alice]: ['wss://alice.example.com'] });
    await getPeerRelayLists(alice, { viewerPubkey: sender });
    // 30 s later the unknown kind is re-looked up, and that retry hangs.
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 30_001);
    query.mockReturnValue(new Promise(() => {}));
    try {
      const wrap = wrapTo(alice);
      const report = await deliverToPeerRelays({
        events: [wrap],
        senderPubkey: sender,
        baseRelays: base,
        role: 'inbox',
        chosenRecipients: chosen,
        lookupTimeoutMs: 10,
      });
      expect(publish).toHaveBeenCalledWith(['wss://alice.example.com/'], wrap);
      expect(report.relays).toEqual(['wss://alice.example.com/']);
    } finally {
      jest.mocked(Date.now).mockRestore();
    }
  });

  it('never throws when the extra relays reject or the lookup fails', async () => {
    publishedInboxes({ [alice]: ['wss://alice.example.com'] });
    publish.mockImplementationOnce((relays) => relays.map(() => Promise.reject(new Error('no'))));
    await expect(
      deliverToPeerRelays({ events: [wrapTo(alice)], senderPubkey: sender, baseRelays: base, role: 'inbox', chosenRecipients: chosen }), // prettier-ignore
    ).resolves.toEqual({ relays: ['wss://alice.example.com/'], accepted: [], cacheHits: 0 });

    clearPeerRelayListCache();
    query.mockRejectedValue(new Error('No relay answered'));
    await expect(
      deliverToPeerRelays({ events: [wrapTo(bob)], senderPubkey: sender, baseRelays: base, role: 'inbox', chosenRecipients: chosen }), // prettier-ignore
    ).resolves.toEqual({ relays: [], accepted: [], cacheHits: 0 });
  });

  it('releases the one-off sockets it opened once the publishes finish', async () => {
    publishedInboxes({ [alice]: ['wss://alice.example.com'] });
    await deliverToPeerRelays({
      events: [wrapTo(alice)],
      senderPubkey: sender,
      baseRelays: base,
      role: 'inbox',
      chosenRecipients: chosen,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(releaseNewIdleRelays).toHaveBeenCalledWith(
      ['wss://alice.example.com/'],
      expect.any(Set),
    );
  });

  it('delivers a NIP-04 event to the read relays, not the inbox or write relays', async () => {
    query.mockResolvedValue([
      inboxList(alice, ['wss://inbox.example.com']),
      {
        ...inboxList(alice, []),
        id: 'nip65',
        kind: 10002,
        tags: [
          ['r', 'wss://read.example.com', 'read'],
          ['r', 'wss://write.example.com', 'write'],
        ],
      },
    ]);
    await deliverToPeerRelays({
      events: [{ ...wrapTo(alice), kind: 4 }],
      senderPubkey: sender,
      baseRelays: base,
      role: 'read',
      chosenRecipients: chosen,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toEqual(['wss://read.example.com/']);
  });

  it('keeps a test account on the test relay even when the inbox lists public relays', async () => {
    publishedInboxes({ [alice]: ['wss://public-inbox.example.com'] });
    const report = await deliverToPeerRelays({
      events: [wrapTo(alice)],
      senderPubkey: TEST_ACCOUNT_KEYS.little,
      baseRelays: ['wss://relay.damus.io'],
      role: 'inbox',
      chosenRecipients: chosen,
    });
    for (const [relays] of query.mock.calls) expect(relays).toEqual([TEST_RELAY_URL]);
    for (const [relays] of publish.mock.calls) expect(relays).toEqual([TEST_RELAY_URL]);
    expect(report.relays).toEqual([]);
  });
});

describe('deliverToPeerRelays trust gate (#1749)', () => {
  const carol = 'c'.repeat(64);
  beforeEach(() => {
    jest.mocked(hasRepliedTo).mockReturnValue(false);
    jest.mocked(loadFofCache).mockResolvedValue(null);
  });
  const relayOf = (pk: string) => `wss://${pk.slice(0, 4)}.example.com/`;
  const setTier = (tier: WotTier) =>
    AsyncStorage.setItem(perAccountKey(WOT_STORAGE_KEY_BASE, sender), JSON.stringify({ wotTier: tier })); // prettier-ignore
  const follow = (...pks: string[]) =>
    publishFollowSet(
      sender,
      pks.map((pubkey) => ({ pubkey, relay: null, petname: null, profile: null })),
    );
  /** A group send to every member, nobody chosen; the recipients routed to their inbox. */
  async function groupRouted(members: string[], chosenRecipients?: string[]): Promise<string[]> {
    publishedInboxes(Object.fromEntries(members.map((pk) => [pk, [relayOf(pk)]])));
    await deliverToPeerRelays({
      events: members.map((pk) => wrapTo(pk)),
      senderPubkey: sender,
      baseRelays: base,
      role: 'inbox',
      chosenRecipients,
    });
    return publish.mock.calls.map(([, event]) => eventRecipient(event as VerifiedEvent)!);
  }

  it('routes the chosen peer of a 1:1 even when they are a stranger', async () => {
    expect(await groupRouted([alice], [alice])).toEqual([alice]);
  });

  it('keeps a stranger group member on the usual set only', async () => {
    expect(await groupRouted([alice])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('routes only the followed member of a group, each wrap gated on its own', async () => {
    follow(bob);
    expect(await groupRouted([alice, bob])).toEqual([bob]);
  });

  it('reads follows from the contacts cache when the live gate has not hydrated', async () => {
    await AsyncStorage.setItem(
      perAccountKey(CONTACTS_CACHE_KEY_BASE, sender),
      JSON.stringify([{ pubkey: bob }]),
    );
    expect(await groupRouted([alice, bob])).toEqual([bob]);
  });

  it('routes someone the user has replied to under Friends', async () => {
    jest.mocked(hasRepliedTo).mockImplementation((_owner, pk) => pk === alice);
    expect(await groupRouted([alice, bob])).toEqual([alice]);
  });

  it('always routes the sender’s own copy', async () => {
    expect(await groupRouted([sender, alice])).toEqual([sender]);
  });

  it('counts an unset tier as Friends, not All', async () => {
    follow(alice);
    expect(await groupRouted([alice, bob])).toEqual([alice]);
  });

  it('adds the cached friends of friends under the FoF tier', async () => {
    await setTier('fof');
    follow(alice);
    jest.mocked(loadFofCache).mockResolvedValue({
      set: new Set([bob]),
      excludedFriends: 0,
      computedAt: 0,
      stale: true,
    });
    expect(await groupRouted([alice, bob, carol])).toEqual([alice, bob]);
  });

  it('keeps friends of friends out under the Friends tier', async () => {
    await setTier('friends');
    follow(alice);
    jest.mocked(loadFofCache).mockResolvedValue({
      set: new Set([bob]),
      excludedFriends: 0,
      computedAt: 0,
      stale: false,
    });
    expect(await groupRouted([alice, bob])).toEqual([alice]);
  });

  it('routes everyone under the All tier', async () => {
    await setTier('all');
    expect(await groupRouted([alice, bob])).toEqual([alice, bob]);
  });

  it('leaves recipients untrusted when storage fails (fail private)', async () => {
    follow(bob);
    const getItem = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('disk'));
    try {
      expect(await groupRouted([alice, bob], [alice])).toEqual([alice]);
    } finally {
      getItem.mockRestore();
    }
  });
});
