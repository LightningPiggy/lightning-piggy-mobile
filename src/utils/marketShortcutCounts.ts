import { MARKET_PRODUCTS, sellerOf } from '../data/marketProducts';
import { vendorNostrPubkey } from './marketVendors';
import type { Event } from 'nostr-tools';
import type { BuyerOrderEntry } from './orderThreads';
import type { ShopOrderStatus } from './shopOrderStatus';

/** Only orders with a next action belong in navigation badges. */
export function buyerActionCount(entries: readonly Pick<BuyerOrderEntry, 'status'>[]): number {
  return entries.reduce(
    (count, { status }) => count + Number(status === 'payNow' || status === 'invoiceExpired'),
    0,
  );
}

export function sellerActionCount(statuses: Iterable<ShopOrderStatus>): number {
  let count = 0;
  for (const status of statuses)
    if (status === 'needsInvoice' || status === 'invoiceExpired') count += 1;
  return count;
}

/** Verified own listings from the seller store or any loaded Market scope. */
export function hasOwnMarketListings(
  pubkey: string | null,
  events: Iterable<Pick<Event, 'pubkey' | 'kind'>>,
): boolean {
  if (!pubkey) return false;
  for (const event of events)
    if (event.kind === 30402 && event.pubkey.toLowerCase() === pubkey.toLowerCase()) return true;
  return false;
}

// Authored catalogue products (including dev-only test fixtures) have no
// kind-30402 event. Resolve their known vendor identity, never a display-name match.
const curatedSellers = new Set(
  MARKET_PRODUCTS.flatMap((product) => {
    const vendor = sellerOf(product);
    const pubkey = vendor ? vendorNostrPubkey(vendor) : null;
    return pubkey ? [pubkey] : [];
  }),
);
export function hasOwnCuratedMarketListings(pubkey: string | null): boolean {
  return !!pubkey && curatedSellers.has(pubkey.toLowerCase());
}
