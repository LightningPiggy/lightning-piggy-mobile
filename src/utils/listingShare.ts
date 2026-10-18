import { enabledAppRelays } from '../services/appRelayPrefs';
// Sharing a Market listing (#1541) — pure helpers, no I/O.
//
// Both share paths carry the listing as a NIP-21 `nostr:naddr1…` reference
// (kind 30402 + seller + `d`, with Market relay hints), which other Nostr
// clients resolve and Lightning Piggy's chat renders as a product card.
//
// Why not a web link: the Lightning Piggy website has no per-product pages
// for Nostr listings (its `/market/p/<slug>` pages are still in an open PR,
// slug-based and build-time only — no naddr route; checked against the live
// site, 2026-10-14). njump is never used — it's slow and often broken. When
// the website gains an naddr route, add it to `listingShareContent` here.
import * as nip19 from 'nostr-tools/nip19';
import type { Event } from 'nostr-tools';
import { decodeNostrEntity, type NostrContentToken } from './nip27';
import { MARKET_RELAYS } from './marketListingsQuery';
import { LISTING_KIND } from './marketLikes';

type AddressRef = Extract<NostrContentToken, { type: 'address' }>;
const SHARE_LINE = /^nostr:naddr1[0-9a-z]+$/;

/** `naddr1…` for a kind-30402 listing, with the Market relays as hints; null otherwise. */
export function listingNaddr(event: Pick<Event, 'kind' | 'pubkey' | 'tags'>): string | null {
  if (event.kind !== LISTING_KIND) return null;
  const identifier = event.tags.find((t) => t[0] === 'd')?.[1];
  if (!identifier) return null;
  try {
    return nip19.naddrEncode({
      kind: event.kind,
      pubkey: event.pubkey,
      identifier,
      relays: enabledAppRelays('market', MARKET_RELAYS),
    });
  } catch {
    // An identifier over 255 bytes can't be TLV-encoded.
    return null;
  }
}

/**
 * What both share paths send: the listing title on the first line (readable
 * in any client) and the `nostr:naddr1…` reference alone on the second — the
 * shape `extractSharedListing` recognises as a product card.
 */
export function listingShareContent(
  title: string,
  naddr: string,
): { message: string; uri: string } {
  const uri = `nostr:${naddr}`;
  const label = title.replace(/\s+/g, ' ').trim();
  return { message: label && !SHARE_LINE.test(label) ? `${label}\n${uri}` : uri, uri };
}

/** Standalone references and a listing at the end of a message become cards.
 * Inline references followed by prose stay text. Never discard sender text. */
export function extractSharedListing(text: string): AddressRef | null {
  return (
    sharedListingParts(text).find((part): part is AddressRef => typeof part !== 'string') ?? null
  );
}

export function sharedListingParts(text: string): (string | AddressRef)[] {
  if (!text?.includes('naddr1')) return [text];
  const parts: (string | AddressRef)[] = [];
  const pattern = /nostr:naddr1[0-9a-z]+/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    const end = index + match[0].length;
    const before = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
    const after = text.slice(
      end,
      text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end),
    );
    const standalone = !before.trim() && !after.trim();
    const trailing = (index === 0 || /\s/.test(text[index - 1])) && !text.slice(end).trim();
    if (!standalone && !trailing) continue;
    const ref = decodeNostrEntity(match[0]);
    if (ref?.type !== 'address' || ref.kind !== LISTING_KIND) continue;
    const label = text.slice(start, index).trim();
    if (label) parts.push(label);
    parts.push(ref);
    start = end;
  }
  const rest = text.slice(start);
  if (rest.trim()) parts.push(start ? rest.trim() : rest);
  return parts;
}
