import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useLocale } from '../contexts/LocaleContext';
import { balanceFetchedAt, subscribeBalanceFetches } from '../services/balanceFetchTimes';
import {
  readWidgetSnapshot,
  wipeWidgetSnapshotOnAccountChange,
  writeWidgetSnapshot,
} from '../services/widgetSnapshot';
import { handleWidgetAccountChange, wipeAllWidgetSnapshots } from '../services/widgetWipe';
import { createWidgetSnapshotWriter } from '../services/widgetSnapshotWriter';
import { refreshWalletWidgets } from '../widgets/refreshWalletWidgets';

/**
 * Keeps the home-screen widget's snapshot (#1849) in step with the
 * wallets: a debounced write whenever balances, connection, price, currency or
 * language change (or a balance re-fetch moves "Updated 14:32"), then a redraw
 * of any placed widget. Wipes the snapshot at once on sign-out and account
 * switch. Android and iPhone (refreshWalletWidgets.ios.ts copies the snapshot
 * into the App Group); no AppState handler and no per-event state — the
 * logic lives in services/widgetSnapshotWriter.ts.
 */
export function useWidgetSnapshotSync(): void {
  const enabled = Platform.OS === 'android' || Platform.OS === 'ios';
  const { wallets, walletsHydrated, currency } = useWallet();
  const { btcPrice } = useWalletLive();
  const { locale } = useLocale();
  const [writer] = useState(() =>
    createWidgetSnapshotWriter({
      read: readWidgetSnapshot,
      write: writeWidgetSnapshot,
      wipe: wipeAllWidgetSnapshots,
      refresh: refreshWalletWidgets,
      fetchedAt: balanceFetchedAt,
    }),
  );

  useEffect(() => {
    if (!enabled) return;
    const stopWipe = wipeWidgetSnapshotOnAccountChange((wiped) => {
      void handleWidgetAccountChange(writer, wiped).catch(() => undefined);
    });
    const stopFetches = subscribeBalanceFetches(() => writer.nudge());
    return () => {
      stopWipe();
      stopFetches();
      writer.dispose();
    };
  }, [enabled, writer]);

  useEffect(() => {
    if (!enabled) return;
    writer.update({ wallets, hydrated: walletsHydrated, locale, btcPrice, currency });
  }, [enabled, writer, wallets, walletsHydrated, btcPrice, currency, locale]);
}
