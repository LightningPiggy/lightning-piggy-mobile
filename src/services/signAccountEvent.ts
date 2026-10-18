import * as SecureStore from 'expo-secure-store';
import * as nostrService from './nostrService';
import * as amberService from './amberService';
import { nip46Sign } from '../contexts/nip46DmDecrypt';
import { NSEC_KEY } from '../contexts/nostrAuthKeys';
import { assertSigningKey } from '../utils/sellerSigning';
import type { Event as SignedEvent, EventTemplate } from 'nostr-tools';

/** Sign using the identity captured by the initiating context callback. */
export async function signAccountEvent(
  event: EventTemplate,
  account: { pubkey: string | null; isLoggedIn: boolean; signerType: string | null },
): Promise<SignedEvent | null> {
  const { pubkey, isLoggedIn, signerType } = account;
  if (!pubkey || !isLoggedIn) return null;
  try {
    if (signerType === 'nsec') {
      const nsec = await SecureStore.getItemAsync(NSEC_KEY);
      if (!nsec) return null;
      const { secretKey } = nostrService.decodeNsec(nsec);
      assertSigningKey(secretKey, pubkey);
      return nostrService.signEvent(event, secretKey) as SignedEvent;
    } else if (signerType === 'amber') {
      const { event: signedEventJson } = await amberService.requestEventSignature(
        JSON.stringify(event),
        '',
        pubkey,
      );
      if (!signedEventJson) return null;
      return JSON.parse(signedEventJson) as SignedEvent;
    } else if (signerType === 'nip46') {
      const signedEventJson = await nip46Sign(event, pubkey);
      if (!signedEventJson) return null;
      return JSON.parse(signedEventJson) as SignedEvent;
    }
    return null;
  } catch (error) {
    if (__DEV__ && event.kind !== 22242) console.warn('[Nostr] signEvent failed:', error);
    return null;
  }
}
