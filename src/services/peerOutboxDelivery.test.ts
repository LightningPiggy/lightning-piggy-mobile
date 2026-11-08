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

const publish = jest.mocked(pool.publish);
const query = jest.mocked(pool.querySyncFilters);
const sender = 'e'.repeat(64);
const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);
const base = ['wss://base.example.com'];

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

beforeEach(() => {
  clearPeerRelayListCache();
  jest.clearAllMocks();
  query.mockReset();
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
      lookupTimeoutMs: 5,
    });
    expect(report.relays).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    answer([inboxList(alice, ['wss://alice.example.com'])]);
    await new Promise((r) => setTimeout(r, 0));
    expect(peekPeerRelayLists(alice, sender)?.status).toBe('ok');
  });

  it('never throws when the extra relays reject or the lookup fails', async () => {
    publishedInboxes({ [alice]: ['wss://alice.example.com'] });
    publish.mockImplementationOnce((relays) => relays.map(() => Promise.reject(new Error('no'))));
    await expect(
      deliverToPeerRelays({ events: [wrapTo(alice)], senderPubkey: sender, baseRelays: base, role: 'inbox' }), // prettier-ignore
    ).resolves.toEqual({ relays: ['wss://alice.example.com/'], accepted: [], cacheHits: 0 });

    clearPeerRelayListCache();
    query.mockRejectedValue(new Error('No relay answered'));
    await expect(
      deliverToPeerRelays({ events: [wrapTo(bob)], senderPubkey: sender, baseRelays: base, role: 'inbox' }), // prettier-ignore
    ).resolves.toEqual({ relays: [], accepted: [], cacheHits: 0 });
  });

  it('releases the one-off sockets it opened once the publishes finish', async () => {
    publishedInboxes({ [alice]: ['wss://alice.example.com'] });
    await deliverToPeerRelays({
      events: [wrapTo(alice)],
      senderPubkey: sender,
      baseRelays: base,
      role: 'inbox',
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
    });
    for (const [relays] of query.mock.calls) expect(relays).toEqual([TEST_RELAY_URL]);
    for (const [relays] of publish.mock.calls) expect(relays).toEqual([TEST_RELAY_URL]);
    expect(report.relays).toEqual([]);
  });
});
