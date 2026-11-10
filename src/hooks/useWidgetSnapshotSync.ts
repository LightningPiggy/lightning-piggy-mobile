import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useLocale } from '../contexts/LocaleContext';
import {
  buildWidgetSnapshot,
  readWidgetSnapshot,
  snapshotFingerprint,
  wipeWidgetSnapshot,
  wipeWidgetSnapshotOnAccountChange,
  writeWidgetSnapshot,
  type WidgetSnapshot,
} from '../services/widgetSnapshot';
import { refreshWalletWidgets } from '../widgets/refreshWalletWidgets';

// Trailing debounce: a burst of balance / price / connection updates becomes
// one write. Never per relay event, never on the tap path.
const WRITE_DEBOUNCE_MS = 1500;
// An unchanged snapshot is still rewritten this often while updates keep
// arriving, so "updated N min ago" reflects that the app re-confirmed it.
const REWRITE_UNCHANGED_AFTER_MS = 5 * 60_000;

/**
 * Keeps the Android home-screen widget's snapshot (#1849) in step with the
 * wallets: a debounced write whenever balances, connection, price, currency
 * or language change, then a redraw of any placed widget. On sign-out and
 * account switch it wipes the snapshot at once, so the widget never shows
 * another account's wallets. Android only; adds no AppState handler and no
 * per-event state.
 */
export function useWidgetSnapshotSync(): void {
  const enabled = Platform.OS === 'android';
  const { wallets, walletsHydrated, currency } = useWallet();
  const { btcPrice } = useWalletLive();
  const { locale } = useLocale();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What this session last wrote (seeded from storage on the first write), so
  // a wallet that's offline right now keeps its last-confirmed time.
  const lastRef = useRef<{ snapshot: WidgetSnapshot | null; fingerprint: string; at: number }>(
    null,
  );
  // Bumped by a wipe so a write that was already being prepared is dropped.
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    return wipeWidgetSnapshotOnAccountChange((wiped) => {
      generationRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      lastRef.current = { snapshot: null, fingerprint: '', at: 0 };
      void wiped.then(() => refreshWalletWidgets(null)).catch(() => undefined);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !walletsHydrated) return;
    const generation = generationRef.current;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void (async () => {
        if (!lastRef.current) {
          const stored = await readWidgetSnapshot();
          lastRef.current = { snapshot: stored, fingerprint: '', at: 0 };
        }
        if (generation !== generationRef.current) return;
        const now = Date.now();
        const last = lastRef.current;
        if (wallets.length === 0) {
          if (last.snapshot === null && last.fingerprint === 'empty') return;
          lastRef.current = { snapshot: null, fingerprint: 'empty', at: now };
          await wipeWidgetSnapshot();
          await refreshWalletWidgets(null);
          return;
        }
        const snapshot = buildWidgetSnapshot(wallets, locale, {
          btcPrice,
          currency,
          now,
          previous: last.snapshot,
        });
        const fingerprint = snapshotFingerprint(snapshot);
        if (fingerprint === last.fingerprint && now - last.at < REWRITE_UNCHANGED_AFTER_MS) return;
        lastRef.current = { snapshot, fingerprint, at: now };
        await writeWidgetSnapshot(snapshot);
        if (generation !== generationRef.current) return;
        await refreshWalletWidgets(snapshot);
      })().catch((e: unknown) => {
        if (__DEV__) console.warn('[widget] snapshot write failed:', e);
      });
    }, WRITE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, wallets, walletsHydrated, btcPrice, currency, locale]);
}
