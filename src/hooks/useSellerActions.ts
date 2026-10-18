import {
  isLegacyShopCollection,
  buildCollectionTemplate,
  type CollectionDraft,
} from '../utils/marketCollections';
import { saveSellerCurrency } from '../services/sellerPreferences';
import { SellerSigningError } from '../utils/sellerSigning';
import { signSellerMutation } from '../utils/sellerSigning';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Event } from 'nostr-tools';
import { useNostr } from '../contexts/NostrContext';
import {
  fetchLatestRevision,
  persistSellerSnapshot,
  publishSellerEvent,
  saveHiddenListings,
  sellerRelays,
} from '../services/marketSellerService';
import { addSellerEvents, sellerStoreState, setSellerHidden } from '../services/sellerEventStore';
import {
  COLLECTION_KIND,
  LISTING_KIND,
  SHIPPING_OPTION_KIND,
  buildDeletionTemplate,
  buildListingTemplate,
  buildShippingZoneTemplate,
  coordinateOf,
  nextCreatedAt,
  type EventTemplate,
  type ListingDraft,
  type ShippingZoneDraft,
  type ShopDraft,
} from '../utils/marketSellerEvents';
import { resolveCurrentRevision, type SaveOptions } from '../utils/marketSellerRevision';
import type { SellerSnapshot } from '../utils/marketSellerSnapshot';

export {
  SellerFetchError,
  StaleRevisionError,
  type SaveOptions,
} from '../utils/marketSellerRevision';

const sameEvent = (template: EventTemplate, previous: Event | undefined) =>
  !!previous &&
  previous.content === template.content &&
  JSON.stringify(previous.tags) === JSON.stringify(template.tags);

const dTagOf = (event: Event) => event.tags.find((t) => t[0] === 'd')?.[1] ?? '';

/** What the shop form was loaded from. */
export interface ShopBase {
  shop: Event | null;
  zoneCoordinates: string[];
  zoneEvents: Map<string, Event>;
}

/**
 * Sign + publish the seller's Gamma Markets events through the app's signer
 * abstraction (`useNostr().signEvent` — nsec, Amber or NIP-46) to the user's
 * write and marketplace relays, and drop each signed event into the shared store.
 *
 * Every edit first fetches the CURRENT revision (fail closed) so a cached or
 * stale form can't silently overwrite newer data published elsewhere.
 */
export function useSellerActions(_snapshot: SellerSnapshot) {
  const { pubkey, relays, signEvent } = useNostr();
  const identity = useRef({ pubkey, signEvent });
  if (identity.current.pubkey !== pubkey || identity.current.signEvent !== signEvent) {
    identity.current = { pubkey, signEvent };
  }
  const initiatingIdentity = identity.current;
  const relayList = useMemo(() => sellerRelays(relays), [relays]);
  const [busy, setBusy] = useState(false);

  const signAndPublish = useCallback(
    async (
      template: EventTemplate,
      previous?: Pick<Event, 'created_at'> | null,
      beforePublish?: () => Promise<void>,
    ): Promise<Event> => {
      if (!pubkey) throw new Error('Not signed in');
      const signed = await signSellerMutation({
        pubkey,
        template: { ...template, created_at: nextCreatedAt(Date.now() / 1000, previous) },
        isCurrent: () => identity.current === initiatingIdentity,
        sign: async (event) => (await signEvent(event)) as Event | null,
      });
      await beforePublish?.();
      if (identity.current !== initiatingIdentity)
        throw new SellerSigningError('Signing account changed');
      await publishSellerEvent(signed, relayList);
      addSellerEvents(pubkey, [signed]);
      void persistSellerSnapshot(pubkey);
      return signed;
    },
    [pubkey, signEvent, relayList, initiatingIdentity],
  );

  /** The current revision to build on, or throw (fetch failure / newer
   * revision than `base` without `force`). */
  const currentRevision = useCallback(
    (
      kind: number,
      dTag: string,
      base: Event | null,
      options: SaveOptions = {},
      onDeletedAt?: (deletedAt: number) => void,
      legacyOnly = false,
    ) => {
      if (!pubkey) throw new Error('Not signed in');
      return resolveCurrentRevision({
        fetchLatest: async () => {
          const result = await fetchLatestRevision({
            pubkey,
            kind,
            dTag,
            baseId: base?.id,
            relays: relayList,
          });
          const latest = result && 'event' in result ? result.event : (result as Event | null);
          if (
            legacyOnly &&
            (!latest || latest.pubkey !== pubkey || !isLegacyShopCollection(latest))
          )
            throw new SellerSigningError('Collection is no longer a legacy shop');
          return result;
        },
        base,
        force: options.force,
        onDeletedAt,
        onLatest: (latest) => addSellerEvents(pubkey, [latest]),
      });
    },
    [pubkey, relayList],
  );

  const run = useCallback(async <T>(task: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await task();
    } finally {
      setBusy(false);
    }
  }, []);

  /** Save changed shipping options after checking every revision. Currency
   * is an account/device preference, never a kind-30405 shop event. */
  const saveShop = useCallback(
    (shop: ShopDraft, zones: ShippingZoneDraft[], base: ShopBase, options: SaveOptions = {}) =>
      run(async () => {
        if (!pubkey) throw new Error('Not signed in');
        const zoneCoordinates = zones.map((z) =>
          coordinateOf(SHIPPING_OPTION_KIND, pubkey, z.dTag),
        );
        const removed = base.zoneCoordinates.filter((c) => !zoneCoordinates.includes(c));
        // Complete every conflict check before publishing the first mutation.
        const revisions = new Map<string, Event | null>();
        for (const coordinate of new Set([...zoneCoordinates, ...removed])) {
          revisions.set(
            coordinate,
            await currentRevision(
              SHIPPING_OPTION_KIND,
              coordinate.split(':').slice(2).join(':'),
              base.zoneEvents.get(coordinate) ?? null,
              options,
            ),
          );
        }
        for (const zone of zones) {
          const coordinate = coordinateOf(SHIPPING_OPTION_KIND, pubkey, zone.dTag);
          const previous = revisions.get(coordinate) ?? null;
          const template = buildShippingZoneTemplate(zone, previous ?? undefined);
          if (!sameEvent(template, previous ?? undefined)) await signAndPublish(template, previous);
        }
        if (removed.length > 0) {
          const newest = Math.max(0, ...removed.map((c) => revisions.get(c)?.created_at ?? 0));
          await signAndPublish(
            buildDeletionTemplate(
              removed.map((coordinate) => ({
                kind: SHIPPING_OPTION_KIND,
                coordinate,
                eventId: revisions.get(coordinate)?.id,
              })),
            ),
            { created_at: newest - 1 } as Event,
          );
        }
        if (identity.current !== initiatingIdentity)
          throw new SellerSigningError('Signing account changed');
        await saveSellerCurrency(pubkey, shop.currency);
      }),
    [pubkey, currentRevision, signAndPublish, run, initiatingIdentity],
  );

  /** Create or edit (same `d`) a listing. */
  const saveListing = useCallback(
    (draft: ListingDraft, base: Event | null, options: SaveOptions = {}) =>
      run(async () => {
        if (!pubkey) throw new Error('Not signed in');
        let deletedAt = -1;
        const current = base
          ? await currentRevision(LISTING_KIND, draft.dTag, base, options, (timestamp) => {
              deletedAt = timestamp;
            })
          : null;
        const signed = await signAndPublish(
          buildListingTemplate({
            draft,
            pubkey,
            nowSeconds: Math.floor(Date.now() / 1000),
            previous: current,
          }),
          // Address deletions suppress every revision at or before their
          // timestamp, even when the latest surviving revision is null.
          { created_at: Math.max(current?.created_at ?? -1, deletedAt) },
        );
        return signed;
      }),
    [pubkey, currentRevision, signAndPublish, run],
  );

  /** Re-sign a stored listing without the editor's lossy draft round-trip. */
  const resignListing = useCallback(
    (event: Event) =>
      run(async () => {
        if (!pubkey || event.pubkey !== pubkey || event.kind !== LISTING_KIND)
          throw new SellerSigningError('Unexpected listing author or kind');
        const current = await currentRevision(LISTING_KIND, dTagOf(event), event);
        return signAndPublish(
          {
            kind: event.kind,
            content: event.content,
            tags: event.tags.map((tag) => [...tag]),
          },
          current,
        );
      }),
    [pubkey, currentRevision, signAndPublish, run],
  );

  /** NIP-09 delete + hide locally until relays catch up. */
  const deleteListing = useCallback(
    (event: Event) =>
      run(async () => {
        if (!pubkey) throw new Error('Not signed in');
        const coordinate = coordinateOf(LISTING_KIND, pubkey, dTagOf(event));
        // `previous = event` dates the deletion after the revision it deletes.
        const deletion = await signAndPublish(
          buildDeletionTemplate([{ kind: LISTING_KIND, coordinate, eventId: event.id }]),
          event,
        );
        const hidden = new Map(sellerStoreState(pubkey).hidden);
        hidden.set(coordinate, Math.max(deletion.created_at, event.created_at));
        setSellerHidden(pubkey, hidden);
        await saveHiddenListings(pubkey, hidden);
        void persistSellerSnapshot(pubkey);
      }),
    [pubkey, signAndPublish, run],
  );

  const saveCollection = useCallback(
    (draft: CollectionDraft, base: Event | null, options: SaveOptions = {}) =>
      run(async () => {
        let deletedAt = -1;
        const latest = await currentRevision(COLLECTION_KIND, draft.dTag, base, options, (at) => {
          deletedAt = at;
        });
        return signAndPublish(buildCollectionTemplate(draft, latest), {
          created_at: Math.max(latest?.created_at ?? -1, deletedAt),
        });
      }),
    [currentRevision, signAndPublish, run],
  );
  const deleteCollection = useCallback(
    (event: Event, options: SaveOptions = {}, legacyOnly = false) =>
      run(async () => {
        if (!pubkey || event.pubkey !== pubkey || event.kind !== COLLECTION_KIND)
          throw new SellerSigningError('Unexpected collection author');
        const latest = await currentRevision(
          COLLECTION_KIND,
          dTagOf(event),
          event,
          options,
          undefined,
          legacyOnly,
        );
        if (legacyOnly && (!latest || latest.pubkey !== pubkey || !isLegacyShopCollection(latest)))
          throw new SellerSigningError('Collection is no longer a legacy shop');
        const target = latest ?? event;
        const coordinate = coordinateOf(COLLECTION_KIND, pubkey, dTagOf(event));
        const deletion = await signAndPublish(
          buildDeletionTemplate([{ kind: COLLECTION_KIND, coordinate, eventId: target.id }]),
          target,
          legacyOnly
            ? async () => {
                const current = await currentRevision(
                  COLLECTION_KIND,
                  dTagOf(event),
                  target,
                  {},
                  undefined,
                  true,
                );
                if (!current || current.pubkey !== pubkey || !isLegacyShopCollection(current))
                  throw new SellerSigningError('Collection is no longer a legacy shop');
              }
            : undefined,
        );
        const hidden = new Map(sellerStoreState(pubkey).hidden);
        hidden.set(coordinate, deletion.created_at);
        setSellerHidden(pubkey, hidden);
        await saveHiddenListings(pubkey, hidden);
        void persistSellerSnapshot(pubkey);
      }),
    [pubkey, currentRevision, signAndPublish, run],
  );

  const deleteLegacyCollection = useCallback(
    (event: Event, options: SaveOptions = {}) => deleteCollection(event, options, true),
    [deleteCollection],
  );

  return {
    deleteLegacyCollection,
    busy,
    saveShop,
    saveListing,
    resignListing,
    deleteListing,
    saveCollection,
    deleteCollection,
  };
}
