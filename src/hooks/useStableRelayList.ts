import { useMemo } from 'react';
import { relayListKey } from '../utils/relayListKey';

/**
 * `value` as it was when `key` last changed. Relay lists are re-parsed into
 * new arrays with the same entries during cold start; keying their identity
 * on content stops every relay subscription downstream from re-arming.
 */
export function useStableByKey<T>(value: T, key: string): T {
  // Identity deliberately follows the key, not the value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}

/** The relays a getter returns. The array changes identity only when the set
 * of relays changes, so effects can depend on it directly. */
export function useStableRelayList(getRelays: () => string[]): string[] {
  const list = useMemo(() => getRelays(), [getRelays]);
  const key = useMemo(() => relayListKey(list), [list]);
  return useStableByKey(list, key);
}
