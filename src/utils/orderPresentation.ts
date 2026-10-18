import type { MarketProduct } from '../data/marketProducts';

/** Remove only the checkout-generated trailing itemisation; never alter the sent message. */
export function buyerOrderNote(message?: string): string {
  return (message ?? '')
    .replace(
      /(?:^|\r?\n\r?\n)Subtotal: [\d,]+ sats\r?\nShipping \([^\r\n]*\): [\d,]+ sats\r?\nTotal: [\d,]+ sats\s*$/,
      '',
    )
    .trim();
}

export interface OrderItemPreview {
  ref: string;
  title: string;
  quantity: number;
  image?: string;
}
export type OrderListingPreview = Pick<OrderItemPreview, 'title' | 'image'>;

/** Coordinates, rather than product ids or titles, identify purchased listings. */
export function orderListingPreviews(
  listings: readonly { pubkey: string; tags: string[][] }[],
): ReadonlyMap<string, OrderListingPreview> {
  const result = new Map<string, OrderListingPreview>();
  for (const listing of listings) {
    const d = listing.tags.find((tag) => tag[0] === 'd')?.[1];
    if (!d) continue;
    result.set(`30402:${listing.pubkey}:${d}`, {
      title: listing.tags.find((tag) => tag[0] === 'title')?.[1] || d,
      image: listing.tags.find((tag) => tag[0] === 'image')?.[1],
    });
  }
  return result;
}

export function orderProductPreviews(products: readonly MarketProduct[]) {
  return orderListingPreviews(products.flatMap((p) => (p.listing ? [p.listing.event] : [])));
}

/** One thumbnail per distinct coordinate, with the total purchased quantity. */
export function distinctOrderItems(
  lines: readonly { ref: string; quantity: number; title?: string }[],
  listings?: ReadonlyMap<string, OrderListingPreview>,
): OrderItemPreview[] {
  const items = new Map<string, OrderItemPreview>();
  for (const line of lines) {
    const existing = items.get(line.ref);
    if (existing) existing.quantity += line.quantity;
    else {
      const listing = listings?.get(line.ref);
      items.set(line.ref, {
        ref: line.ref,
        title: line.title || listing?.title || line.ref.split(':').slice(2).join(':'),
        image: listing?.image,
        quantity: line.quantity,
      });
    }
  }
  return [...items.values()];
}

/** Keep structured address lines intact; display older comma-separated checkout addresses vertically. */
export function orderAddressLines(address: string): string[] {
  return address
    .split(address.includes('\n') ? /\r?\n/ : /,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Preserve checkout titles for text and thumbnails, then use catalogue titles or the d-tag. */
export function orderItemsSummary(
  lines: readonly { ref: string; quantity: number }[],
  titles?: Record<string, string>,
  listings?: ReadonlyMap<string, OrderListingPreview>,
): string {
  return distinctOrderItems(
    lines.map((line) => ({ ...line, title: titles?.[line.ref] })),
    listings,
  )
    .map((item) => `${item.title} × ${item.quantity}`)
    .join(', ');
}
