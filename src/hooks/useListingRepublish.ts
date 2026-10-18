import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { Event } from 'nostr-tools';
import { useNostr } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import { Alert } from '../components/BrandedAlert';
import { Toast } from '../components/BrandedToast';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import {
  fetchListingCoverage,
  listingTargetRelays,
  newestSignedListing,
  republishListing,
  type ListingCoverageSnapshot,
  type ListingRepublishResult,
} from '../services/listingRepublish';
import { listingDTag, listingRelayCoverage } from '../utils/listingRelayCoverage';
import { parseListingDraft } from '../utils/marketSellerEvents';

export interface RepublishSummary {
  title: string;
  results: ListingRepublishResult[];
  missing?: boolean;
}

export function useListingRepublish(
  listings: readonly Event[],
  resignListing: (event: Event) => Promise<Event>,
) {
  const { pubkey, relays } = useNostr();
  const t = useTranslation();
  const targets = useMemo(
    () => (pubkey ? listingTargetRelays(pubkey, relays) : []),
    [pubkey, relays],
  );
  const targetKey = targets.join('\n');
  const listingKey = listings.map((event) => event.id).join(',');
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const [snapshot, setSnapshot] = useState<ListingCoverageSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [summary, setSummary] = useState<RepublishSummary[] | null>(null);
  const [revision, setRevision] = useState(0);
  useFocusEffect(
    useCallback(() => {
      const abort = new AbortController();
      controller.current = abort;
      setSnapshot(null);
      setSummary(null);
      if (pubkey)
        void fetchListingCoverage(pubkey, targetKey.split('\n'), listingsRef.current, abort.signal)
          .then((value) => {
            if (!abort.signal.aborted) setSnapshot(value);
          })
          .catch(() => {});
      return () => {
        abort.abort();
      };
      // Keys avoid duplicate queries when the store emits an unchanged snapshot.
      // revision explicitly re-arms after closing results or rebuilding.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pubkey, targetKey, listingKey, revision]),
  );

  const coverage = useMemo(() => {
    const out = new Map<string, ReturnType<typeof listingRelayCoverage>>();
    if (snapshot)
      for (const listing of listings) {
        const d = listingDTag(listing);
        out.set(d, listingRelayCoverage(newestSignedListing(snapshot, d), snapshot.relays));
      }
    return out;
  }, [snapshot, listings]);

  const run = useCallback(
    async (items: readonly Event[]) => {
      const abort = controller.current;
      if (!pubkey || !snapshot || running.current || !abort || abort.signal.aborted) return;
      running.current = true;
      setBusy(true);
      const scheduler = createYieldScheduler({ signal: abort.signal, safetyEvery: 10 });
      const results: RepublishSummary[] = [];
      try {
        for (const listing of items) {
          if (abort.signal.aborted) break;
          const d = listingDTag(listing);
          const exists = newestSignedListing(snapshot, d);
          results.push({
            title: parseListingDraft(listing).title || d,
            missing: !exists,
            results: exists ? await republishListing(pubkey, d, snapshot, abort.signal) : [],
          });
          await scheduler.maybeYield();
        }
        if (!abort.signal.aborted) setSummary(results);
      } catch (error) {
        if (!abort.signal.aborted)
          Toast.show({ type: 'error', text1: t('market.republish.failed'), text2: String(error) });
      } finally {
        scheduler.dispose();
        running.current = false;
        setBusy(false);
      }
    },
    [pubkey, snapshot, t],
  );

  const republish = useCallback(
    (event: Event) => {
      if (!coverage.get(listingDTag(event))?.missing) {
        void run([event]);
        return;
      }
      Alert.alert(t('market.republish.resign'), t('market.republish.confirm'), [
        { text: t('market.sell.cancel'), style: 'cancel' },
        {
          text: t('market.republish.resign'),
          onPress: () => {
            const abort = controller.current;
            if (running.current || !abort || abort.signal.aborted) return;
            running.current = true;
            setBusy(true);
            void resignListing(event)
              .then(() => {
                if (!abort.signal.aborted) setRevision((v) => v + 1);
              })
              .catch((error: unknown) => {
                if (abort.signal.aborted) return;
                Toast.show({
                  type: 'error',
                  text1: t('market.republish.failed'),
                  text2: String(error),
                });
              })
              .finally(() => {
                running.current = false;
                setBusy(false);
              });
          },
        },
      ]);
    },
    [coverage, run, resignListing, t],
  );
  const republishAll = useCallback(() => {
    void run(listings);
  }, [run, listings]);
  const close = useCallback(() => {
    setSummary(null);
    setRevision((v) => v + 1);
  }, []);
  return { coverage, busy, ready: !!snapshot, republish, republishAll, summary, close };
}
