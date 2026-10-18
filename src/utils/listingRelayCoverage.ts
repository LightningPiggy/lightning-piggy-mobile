import type { Event } from 'nostr-tools';

export const listingDTag = (event: Event): string =>
  event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';

/** Inputs have already been signature-checked by the service. */
export function newestListing(events: readonly Event[]): Event | null {
  return events.reduce<Event | null>(
    (best, event) =>
      !best ||
      event.created_at > best.created_at ||
      (event.created_at === best.created_at && event.id < best.id)
        ? event
        : best,
    null,
  );
}

export function relayHasListing(events: readonly Event[], latest: Event): boolean {
  return events.some(
    (event) =>
      event.pubkey === latest.pubkey &&
      event.kind === 30402 &&
      listingDTag(event) === listingDTag(latest) &&
      newestListing([latest, event])?.id === event.id,
  );
}

export function listingRelayCoverage(
  latest: Event | null,
  relays: ReadonlyMap<string, readonly Event[]>,
) {
  const total = relays.size;
  const count = latest
    ? [...relays.values()].filter((events) => relayHasListing(events, latest)).length
    : 0;
  return { count, total, warning: count < Math.min(2, total), missing: !latest };
}
