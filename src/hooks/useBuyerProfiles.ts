import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import * as cache from '../services/zapSenderProfileStorage';
import { readOrderCounterpartyProfiles } from '../services/orderCounterpartyProfiles';

const EMPTY: ReadonlyMap<string, cache.CachedZapSenderProfile> = new Map();

/** Shared order-counterparty display data: Friends contacts first, then the
 * avatar cache, then one batch through the account's existing profile fetch.
 * A screen owns this lookup; rows never request profiles or subscribe. */
export function useBuyerProfiles(
  buyersKey: string,
): ReadonlyMap<string, cache.CachedZapSenderProfile> {
  const { pubkey, fetchProfilesForPubkeys } = useNostr();
  const { contacts } = useNostrContacts();
  const known = useMemo(() => {
    const wanted = new Set(buyersKey.split(','));
    return new Map(
      contacts.flatMap((c) =>
        wanted.has(c.pubkey) &&
        c.profile &&
        (c.profile.displayName?.trim() || c.profile.name?.trim() || c.petname?.trim())
          ? [
              [
                c.pubkey,
                {
                  ...c.profile,
                  name: c.profile.displayName || c.profile.name || c.petname,
                },
              ] as const,
            ]
          : [],
      ),
    );
  }, [buyersKey, contacts]);
  const [state, setState] = useState<{
    owner: string | null;
    key: string;
    profiles: ReadonlyMap<string, cache.CachedZapSenderProfile>;
  }>({ owner: null, key: '', profiles: EMPTY });
  useFocusEffect(
    useCallback(() => {
      if (!buyersKey || !pubkey) return;
      let cancelled = false;
      const authors = buyersKey.split(',');
      void (async () => {
        const cached = await readOrderCounterpartyProfiles(pubkey, authors);
        if (cancelled) return;
        setState({ owner: pubkey, key: buyersKey, profiles: cached });
        const missing = authors.filter((pk) => {
          const hit = cached.get(pk);
          return !known.has(pk) && !(hit?.displayName?.trim() || hit?.name?.trim());
        });
        if (!missing.length) return;
        const fetched = await fetchProfilesForPubkeys(missing);
        if (cancelled) return;
        // Display-only batch results must not populate verified payment fields.
        const display = new Map(
          [...fetched].map(
            ([pk, p]) =>
              [
                pk,
                {
                  npub: p.npub,
                  name: p.name,
                  displayName: p.displayName,
                  picture: p.picture,
                  nip05: null,
                },
              ] as const,
          ),
        );
        await cache.setMany(display);
        if (!cancelled)
          setState({ owner: pubkey, key: buyersKey, profiles: new Map([...cached, ...display]) });
      })().catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [buyersKey, pubkey, known, fetchProfilesForPubkeys]),
  );
  return useMemo(
    () =>
      new Map([
        ...(state.owner === pubkey && state.key === buyersKey ? state.profiles : EMPTY),
        ...known,
      ]),
    [state, pubkey, buyersKey, known],
  );
}
