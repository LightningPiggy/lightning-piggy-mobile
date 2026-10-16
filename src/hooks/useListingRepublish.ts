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
import { useCoalescedMap } from '../utils/useCoalescedMap';

/** One listing's row in the republish sheet; `results` fill in as relays answer. */
export interface RepublishSummary {
  key: string;
  title: string;
  results: ListingRepublishResult[];
  missing?: boolean;
  done: boolean;
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
  // The sheet opens the moment a run starts and fills in as relays answer.
  const [open, setOpen] = useState(false);
  const sheetOpen = useRef(false);
  const [finished, setFinished] = useState(false);
  const {
    map: items,
    setMap: setItems,
    enqueue,
    flush,
    reset,
  } = useCoalescedMap<RepublishSummary>();
  const [revision, setRevision] = useState(0);
  useFocusEffect(
    useCallback(() => {
      const abort = new AbortController();
      controller.current = abort;
      setSnapshot(null);
      sheetOpen.current = false;
      setOpen(false);
      if (pubkey)
        void fetchListingCoverage(pubkey, targetKey.split('\n'), listingsRef.current, abort.signal)
          .then((value) => {
            if (!abort.signal.aborted) setSnapshot(value);
          })
          .catch(() => {});
      return () => {
        abort.abort();
        // Leaving the screen stops the run, so don't leave its sheet spinning.
        sheetOpen.current = false;
        setOpen(false);
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
    async (selected: readonly Event[]) => {
      const abort = controller.current;
      if (!pubkey || !snapshot || running.current || !abort || abort.signal.aborted) return;
      running.current = true;
      setBusy(true);
      const rows = selected.map(
        (listing): RepublishSummary => ({
          key: listingDTag(listing),
          title: parseListingDraft(listing).title || listingDTag(listing),
          results: [],
          done: false,
        }),
      );
      reset();
      setItems(new Map(rows.map((row) => [row.key, row])));
      setFinished(false);
      sheetOpen.current = true;
      setOpen(true);
      const scheduler = createYieldScheduler({ signal: abort.signal, safetyEvery: 10 });
      try {
        for (const row of rows) {
          if (abort.signal.aborted) break;
          if (!newestSignedListing(snapshot, row.key)) {
            enqueue(row.key, { ...row, missing: true, done: true });
            continue;
          }
          const answered: ListingRepublishResult[] = [];
          const results = await republishListing(
            pubkey,
            row.key,
            snapshot,
            abort.signal,
            undefined,
            (result) => {
              answered.push(result);
              enqueue(row.key, { ...row, results: [...answered] });
            },
          );
          enqueue(row.key, { ...row, results, done: true });
          await scheduler.maybeYield();
        }
      } catch (error) {
        if (!abort.signal.aborted)
          Toast.show({ type: 'error', text1: t('market.republish.failed'), text2: String(error) });
      } finally {
        scheduler.dispose();
        if (!abort.signal.aborted) {
          flush();
          setFinished(true);
          // Closed mid-run: refresh the coverage pills now the run is over.
          if (!sheetOpen.current) setRevision((v) => v + 1);
        }
        running.current = false;
        setBusy(false);
      }
    },
    [pubkey, snapshot, t, reset, setItems, enqueue, flush],
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
  /** Closing only hides the sheet; a run in progress carries on. */
  const close = useCallback(() => {
    if (!sheetOpen.current) return;
    sheetOpen.current = false;
    setOpen(false);
    // Re-check coverage once nothing is publishing; a live run does it on finish.
    if (!running.current) setRevision((v) => v + 1);
  }, []);
  const progress = useMemo(
    () => ({ open, finished, items: [...items.values()] }),
    [open, finished, items],
  );
  return { coverage, busy, ready: !!snapshot, republish, republishAll, progress, close };
}
