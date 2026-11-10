import { useCallback, useRef, useState, type RefObject } from 'react';

/**
 * On-chain receive-address lookup for the Receive sheet. Tracks the address
 * and whether the last lookup failed, so the sheet can offer Retry instead of
 * showing "Loading address…" forever (#1801).
 *
 * `sessionTokenRef` is the sheet's open/close + wallet-switch token: a result
 * that lands after the token moved on is dropped. Only the newest request in a
 * session may update state, so a slow earlier failure can't overwrite a retry
 * that already succeeded.
 */
export function useOnchainReceiveAddress(
  getReceiveAddress: (walletId: string) => Promise<string>,
  sessionTokenRef: RefObject<number>,
) {
  const [address, setAddress] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const requestIdRef = useRef(0);
  const walletIdRef = useRef<string | null>(null);
  // Each lookup asks the wallet for a NEW address, so a double tap on Retry
  // must not fire a second one (it would skip an address index).
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    walletIdRef.current = null;
    inFlightRef.current = false;
    setAddress(null);
    setFailed(false);
  }, []);

  const request = useCallback(
    (walletId: string) => {
      const token = sessionTokenRef.current;
      const requestId = ++requestIdRef.current;
      walletIdRef.current = walletId;
      inFlightRef.current = true;
      setFailed(false);
      const isCurrent = () =>
        sessionTokenRef.current === token && requestIdRef.current === requestId;
      getReceiveAddress(walletId)
        .then((addr) => {
          if (isCurrent()) setAddress(addr);
        })
        .catch(() => {
          console.warn('Failed to fetch on-chain address');
          if (isCurrent()) setFailed(true);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) inFlightRef.current = false;
        });
    },
    [getReceiveAddress, sessionTokenRef],
  );

  const retry = useCallback(() => {
    if (walletIdRef.current && !inFlightRef.current) request(walletIdRef.current);
  }, [request]);

  return { address, failed, request, reset, retry };
}
