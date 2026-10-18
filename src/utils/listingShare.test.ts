import * as nip19 from 'nostr-tools/nip19';
import {
  extractSharedListing,
  listingNaddr,
  listingShareContent,
  sharedListingParts,
} from './listingShare';
import { MARKET_RELAYS } from './marketListingsQuery';

const SELLER = 'a'.repeat(64);
const listing = { kind: 30402, pubkey: SELLER, tags: [['d', 'widget']] };

describe('listingNaddr', () => {
  it('encodes kind, seller and d with the Market relays as hints', () => {
    const naddr = listingNaddr(listing)!;
    const decoded = nip19.decode(naddr);
    expect(decoded.type).toBe('naddr');
    expect(decoded.data).toEqual({
      kind: 30402,
      pubkey: SELLER,
      identifier: 'widget',
      relays: MARKET_RELAYS,
    });
  });

  it('returns null for non-listings and listings without a d tag', () => {
    expect(listingNaddr({ ...listing, kind: 30018 })).toBeNull();
    expect(listingNaddr({ ...listing, tags: [] })).toBeNull();
  });
});

describe('listingShareContent (share link choice)', () => {
  const naddr = listingNaddr(listing)!;

  it('shares the title plus a nostr:naddr reference', () => {
    expect(listingShareContent('Piggy  bank\n', naddr)).toEqual({
      message: `Piggy bank\nnostr:${naddr}`,
      uri: `nostr:${naddr}`,
    });
  });

  it('never uses njump or any web URL (no naddr route on the website yet)', () => {
    const { message, uri } = listingShareContent('Piggy bank', naddr);
    expect(message).not.toMatch(/njump|https?:/);
    expect(uri.startsWith('nostr:naddr1')).toBe(true);
  });

  it('drops a title that is a standalone listing reference', () => {
    const other = listingNaddr({ ...listing, tags: [['d', 'other']] })!;
    const { message } = listingShareContent(`  nostr:${other}  `, naddr);
    expect(message).toBe(`nostr:${naddr}`);
    expect(sharedListingParts(message)).toEqual([
      expect.objectContaining({ identifier: 'widget' }),
    ]);
  });

  it('falls back to just the reference when the title is blank', () => {
    expect(listingShareContent('  ', naddr).message).toBe(`nostr:${naddr}`);
  });
});

describe('extractSharedListing', () => {
  const naddr = listingNaddr(listing)!;

  it('round-trips the share message into a listing reference', () => {
    const ref = extractSharedListing(listingShareContent('Piggy bank', naddr).message);
    expect(ref).toMatchObject({
      type: 'address',
      kind: 30402,
      pubkey: SELLER,
      identifier: 'widget',
    });
  });

  it('ignores a reference inside a sentence', () => {
    expect(extractSharedListing(`look at nostr:${naddr} please`)).toBeNull();
  });

  it('ignores addresses of other kinds', () => {
    const article = nip19.naddrEncode({ kind: 30023, pubkey: SELLER, identifier: 'post' });
    expect(extractSharedListing(`Post\nnostr:${article}`)).toBeNull();
  });

  it('ignores malformed references', () => {
    expect(extractSharedListing('Thing\nnostr:naddr1qqqqqq')).toBeNull();
  });
});

it('preserves warnings, sender titles, trailing text and every standalone listing', () => {
  const first = listingNaddr(listing)!;
  const second = listingNaddr({ ...listing, tags: [['d', 'other']] })!;
  const parts = sharedListingParts(
    `Scam warning\nSender title\nnostr:${first}\nDo not buy\nnostr:${second}\nAfterword`,
  );
  expect(parts).toEqual([
    'Scam warning\nSender title',
    expect.objectContaining({ identifier: 'widget' }),
    'Do not buy',
    expect.objectContaining({ identifier: 'other' }),
    'Afterword',
  ]);
});

it.each([' ', '\t', '\r\n'])(
  'recognises a listing as the final whitespace token (%j)',
  (separator) => {
    const uri = `nostr:${listingNaddr(listing)!}`;
    const message = `Bitcoin Satskull${separator}${uri}  `;
    expect(extractSharedListing(message)).toMatchObject({ identifier: 'widget' });
    expect(sharedListingParts(message)).toEqual([
      'Bitcoin Satskull',
      expect.objectContaining({ identifier: 'widget' }),
    ]);
  },
);
