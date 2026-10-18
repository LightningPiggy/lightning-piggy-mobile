import type { Event } from 'nostr-tools';
import {
  AUTHOR_BATCH,
  DELETION_TAG_CHUNK,
  MARKET_RELAYS,
  MARKET_LISTING_KINDS,
  MAX_SNAPSHOT_RELAYS,
  OPEN_LISTING_LIMIT,
  OPEN_LISTING_WINDOW_DAYS,
  deletionFilters,
  listingFilters,
  marketSnapshotRelays,
  openListingFilters,
  openListingSince,
} from './marketListingsQuery';

const pk = (n: number) => n.toString(16).padStart(64, '0');
const listing = (kind: number, pubkey: string, d: string | null, id: string): Event => ({
  kind,
  pubkey,
  id,
  sig: '',
  content: '',
  created_at: 1,
  tags: d === null ? [] : [['d', d]],
});

describe('marketSnapshotRelays', () => {
  it('puts the marketplace relays first, then de-duplicated user relays', () => {
    expect(
      marketSnapshotRelays(['wss://Relay.Damus.io/', 'wss://nostr.mom', 'wss://nos.lol']),
    ).toEqual({
      urls: [...MARKET_RELAYS, 'wss://relay.damus.io', 'wss://nos.lol'],
      dropped: false,
    });
  });

  it('ignores non-wss urls and caps the relay count, reporting the overflow', () => {
    const user = Array.from({ length: 10 }, (_, i) => `wss://r${i}.example`);
    const { urls, dropped } = marketSnapshotRelays([
      'http://insecure.example',
      'ws://plain',
      ...user,
    ]);
    expect(urls).toHaveLength(MAX_SNAPSHOT_RELAYS);
    expect(urls.slice(0, MARKET_RELAYS.length)).toEqual(MARKET_RELAYS);
    expect(urls.some((u) => !u.startsWith('wss://'))).toBe(false);
    expect(dropped).toBe(true);
  });
});

describe('listingFilters', () => {
  it('asks only for listing kinds, in bounded author batches with a limit', () => {
    const authors = Array.from({ length: AUTHOR_BATCH * 2 + 1 }, (_, i) => pk(i));
    const filters = listingFilters(authors);
    expect(filters).toHaveLength(3);
    for (const f of filters) {
      expect(f.kinds).toEqual([30018, 30402]);
      expect(f.kinds).not.toContain(5);
      expect(f.authors!.length).toBeLessThanOrEqual(AUTHOR_BATCH);
      expect(f.limit).toBeGreaterThan(0);
    }
    expect(filters.flatMap((f) => f.authors)).toEqual(authors);
  });

  it('issues nothing for an empty follow list', () => {
    expect(listingFilters([])).toEqual([]);
  });
});

describe('deletionFilters', () => {
  it('targets the found listings by address and id, scoped to their authors', () => {
    const filters = deletionFilters([
      listing(30402, pk(1), 'jam', 'e1'),
      listing(30018, pk(2), 'pen', 'e2'),
    ]);
    expect(filters).toEqual([
      {
        kinds: [5],
        authors: [pk(1), pk(2)],
        '#a': [`30402:${pk(1)}:jam`, `30018:${pk(2)}:pen`],
        limit: 500,
      },
      { kinds: [5], authors: [pk(1), pk(2)], '#e': ['e1', 'e2'], limit: 500 },
    ]);
  });

  it('skips non-listing kinds and listings without a d tag (id still deletable)', () => {
    const filters = deletionFilters([
      listing(5, pk(1), 'x', 'del'),
      listing(30402, pk(3), null, 'e3'),
    ]);
    expect(filters).toEqual([{ kinds: [5], authors: [pk(3)], '#e': ['e3'], limit: 500 }]);
  });

  it('chunks long tag lists and narrows each chunk to its own authors', () => {
    const many = Array.from({ length: DELETION_TAG_CHUNK + 1 }, (_, i) =>
      listing(30402, pk(i), `d${i}`, `id${i}`),
    );
    const filters = deletionFilters(many);
    const aFilters = filters.filter((f) => f['#a']);
    expect(aFilters).toHaveLength(2);
    expect(aFilters[0]['#a']).toHaveLength(DELETION_TAG_CHUNK);
    expect(aFilters[1]).toMatchObject({ authors: [pk(DELETION_TAG_CHUNK)] });
  });

  it('returns no filters when nothing was found', () => {
    expect(deletionFilters([])).toEqual([]);
  });
});

describe('All scope (author-less) query', () => {
  it('asks for every listing kind from anyone, bounded by limit and since', () => {
    const since = openListingSince(Date.UTC(2026, 0, 91));
    expect(since).toBe(Date.UTC(2026, 0, 91) / 1000 - OPEN_LISTING_WINDOW_DAYS * 86400);
    const filters = openListingFilters(since);
    expect(filters).toEqual([{ kinds: MARKET_LISTING_KINDS, since, limit: OPEN_LISTING_LIMIT }]);
    expect(filters[0]).not.toHaveProperty('authors');
  });

  it('sizes the per-relay limit so every snapshot relay fits the listing budget', () => {
    expect(OPEN_LISTING_LIMIT * MAX_SNAPSHOT_RELAYS).toBeLessThanOrEqual(1200);
  });
});
