import { useCallback, useLayoutEffect } from 'react';
import { signAccountEvent } from '../services/signAccountEvent';
import { setRelayAuthAccount } from '../services/relayAuth';
import type { RelayConfig } from '../types/nostr';

/** Keep pool AUTH and context writes on the same active-account signer. */
export function useRelayAuthSigner(
  pubkey: string | null,
  isLoggedIn: boolean,
  signerType: string | null,
  nip65Relays: RelayConfig[],
  dmInboxRelays: string[],
) {
  const signEvent = useCallback(
    (event: Parameters<typeof signAccountEvent>[0]) =>
      signAccountEvent(event, { pubkey, isLoggedIn, signerType }),
    [pubkey, isLoggedIn, signerType],
  );
  useLayoutEffect(() => {
    setRelayAuthAccount(
      pubkey && isLoggedIn && signerType
        ? {
            pubkey,
            signerType,
            ownRelays: [...dmInboxRelays, ...nip65Relays.filter((r) => r.read).map((r) => r.url)],
            sign: signEvent,
          }
        : null,
    );
    return () => setRelayAuthAccount(null);
  }, [pubkey, isLoggedIn, signerType, nip65Relays, dmInboxRelays, signEvent]);
  return signEvent;
}
