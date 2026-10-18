import { useAppRelayPrefs } from './useAppRelayPrefs';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import { DEFAULT_RELAYS } from '../services/nostrService';
import {
  peekEmbed,
  resolveEmbed,
  type EmbedRef,
  type EmbedResult,
} from '../services/nostrEmbedCache';
import { embedKey } from '../utils/nip27';

/**
 * The event behind a NIP-27 `nostr:note…` / `nevent…` / `naddr…` reference,
 * resolved through the batched, cached `nostrEmbedCache`. A cached result
 * paints on the first frame; otherwise `loading` is true until the batch
 * settles (one state update per card).
 */
export function useEmbeddedEvent(ref: EmbedRef): {
  result: EmbedResult | undefined;
  loading: boolean;
} {
  const { relays } = useNostr();
  const relayScope = useAppRelayPrefs();
  const key = embedKey(ref);
  const readRelaysKey = useMemo(
    () =>
      relays
        .filter((r) => r.read)
        .map((r) => r.url)
        .join('|'),
    [relays],
  );
  const [state, setState] = useState<{ key: string; result: EmbedResult | undefined }>(() => ({
    key,
    result: peekEmbed(key),
  }));

  const relayPlan = `${relayScope}:${readRelaysKey}`;
  const previousPlan = useRef(relayPlan);
  useEffect(() => {
    const retryMissing = previousPlan.current !== relayPlan;
    previousPlan.current = relayPlan;
    const cached = peekEmbed(key);
    if (cached && (cached.event || !retryMissing)) {
      setState((prev) =>
        prev.key === key && prev.result === cached ? prev : { key, result: cached },
      );
      return;
    }
    setState({ key, result: undefined });
    let cancelled = false;
    const controller = new AbortController();
    const readRelays = readRelaysKey
      ? readRelaysKey.split('|')
      : enabledAppRelays('default', DEFAULT_RELAYS);
    void resolveEmbed(ref, readRelays, controller.signal, retryMissing).then((result) => {
      if (!cancelled) setState({ key, result });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `ref` is identified by `key`; a new object for the same ref is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readRelaysKey, relayPlan]);

  const result = state.key === key ? state.result : undefined;
  return { result, loading: result === undefined };
}
