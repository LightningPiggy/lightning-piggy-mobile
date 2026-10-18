import { useCallback, useEffect, useState } from 'react';
import { getBtcPrice } from '../services/fiatService';
import type { BtcRates } from '../utils/marketCheckoutPricing';

const MAX_RATE_RETRIES = 2;
const RATE_RETRY_MS = 3000;

export interface UseBtcRates {
  /** Spot price per currency: number, null (fetch failed) or absent (pending). */
  rates: BtcRates;
  /** Re-quote `currencies` fresh (served from cache while inside the TTL) and
   * commit them; resolves the fresh map so a submit can re-price with it. */
  refreshRates: (currencies: readonly string[]) => Promise<BtcRates>;
  /** Trigger another fetch round for failed quotes. */
  retry: () => void;
}

/**
 * BTC spot rates for the fiat currencies a checkout is priced in (the listing
 * price and/or shipping options). Lifted out of MarketCheckoutSheet: fetches
 * each missing or failed currency once per open, commits every result in ONE
 * state write (no per-result re-render), and retries a failed quote a bounded
 * number of times ~3 s apart. Never uses a stale rate — an expired quote must
 * not price a payable total.
 */
export function useBtcRates(currencies: readonly string[], active: boolean): UseBtcRates {
  const [rates, setRates] = useState<Record<string, number | null | undefined>>({});
  const [attempt, setAttempt] = useState(0);
  // Bumped per open so the fetch effect re-runs against the cleared map.
  const [epoch, setEpoch] = useState(0);
  const key = currencies.join(',');

  useEffect(() => {
    if (!active) return;
    setRates({});
    setAttempt(0);
    setEpoch((e) => e + 1);
  }, [active]);

  useEffect(() => {
    if (!active || epoch === 0) return;
    const wanted = key ? key.split(',') : [];
    const missing = wanted.filter((c) => !(c in rates) || rates[c] === null);
    if (missing.length === 0) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    Promise.all(
      missing.map((currency) =>
        getBtcPrice(currency, { allowStale: false })
          .then((price) => [currency, price] as const)
          .catch(() => [currency, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setRates((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      if (entries.some(([, price]) => price === null) && attempt < MAX_RATE_RETRIES) {
        retryTimer = setTimeout(() => setAttempt((a) => a + 1), RATE_RETRY_MS);
      }
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // `rates` intentionally omitted: the missing-or-failed filter prevents
    // refetch loops and depending on it would refire per result; `attempt`
    // and `epoch` are the deliberate triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, attempt, epoch]);

  const refreshRates = useCallback(async (list: readonly string[]): Promise<BtcRates> => {
    const entries = await Promise.all(
      list.map((currency) =>
        getBtcPrice(currency, { allowStale: false })
          .then((price) => [currency, price] as const)
          .catch(() => [currency, null] as const),
      ),
    );
    const fresh = Object.fromEntries(entries);
    if (entries.length > 0) setRates((prev) => ({ ...prev, ...fresh }));
    return fresh;
  }, []);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  return { rates, refreshRates, retry };
}
