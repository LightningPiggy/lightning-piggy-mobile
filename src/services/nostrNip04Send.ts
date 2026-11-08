import { finalizeEvent, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as amberService from './amberService';
import * as nostrConnectService from './nostrConnectService';
import { pool, trackRelays } from './nostrPool';
import { publishWrapsTrackingRelays, type DmSendResult } from './nostrDmPublish';
import { getMemoisedSecretKey } from '../contexts/nostrSecretKeyCache';
import { deliverToPeerRelays, type PeerRoutingOptions } from './peerOutboxDelivery';
import { lockRelays } from '../config/testRelayLockdown';
import type { SendHooks } from '../contexts/useMessageSend';
import type { SignerType } from '../types/nostr';

/** Send a legacy encrypted kind-4 event using the shared relay delivery machinery. */
export async function sendNip04Message(input: {
  senderPubkey: string;
  recipientPubkey: string;
  plaintext: string;
  signerType: SignerType | null;
  relays: string[];
  hooks?: SendHooks;
  /** Outbox routing (#1570): also deliver to the recipient's NIP-65 read relays. */
  peerRouting?: PeerRoutingOptions;
}): Promise<DmSendResult & { rumorCreatedAt: number }> {
  const { senderPubkey, recipientPubkey, plaintext, signerType, relays, hooks } = input;
  let signed: VerifiedEvent;
  if (signerType === 'nsec') {
    const secretKey = await getMemoisedSecretKey(senderPubkey);
    if (!secretKey) throw new Error('Key not found');
    signed = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubkey]],
        content: await nip04.encrypt(secretKey, recipientPubkey, plaintext),
      },
      secretKey,
    );
  } else if (signerType === 'amber' || signerType === 'nip46') {
    const signer = signerType === 'amber' ? amberService : nostrConnectService;
    const unsigned = {
      pubkey: senderPubkey,
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: await signer.requestNip04Encrypt(plaintext, recipientPubkey, senderPubkey),
    };
    const { event } = await signer.requestEventSignature(
      JSON.stringify(unsigned),
      '',
      senderPubkey,
    );
    if (!event) throw new Error('Signer returned empty signed event');
    const parsed = JSON.parse(event) as VerifiedEvent;
    // Never publish what an external signer hands back unchecked: it must be a
    // validly signed kind-4 from us, to the same recipient, with the same
    // ciphertext. `created_at` (and so the id) may legitimately differ, so the
    // optimistic row is keyed off the signed id below, not a pre-computed one.
    if (
      !verifyEvent(parsed) ||
      parsed.kind !== 4 ||
      parsed.pubkey !== senderPubkey ||
      parsed.content !== unsigned.content ||
      JSON.stringify(parsed.tags) !== JSON.stringify(unsigned.tags)
    ) {
      throw new Error('Signer returned an invalid or modified event');
    }
    signed = parsed;
  } else {
    throw new Error('Unsupported signer type');
  }
  hooks?.onRumorReady?.({ eventId: signed.id, kind: 4, relays });
  trackRelays(relays);
  // Best-effort and alongside the usual publish; never changes the result.
  void deliverToPeerRelays({
    events: [signed],
    senderPubkey,
    baseRelays: [...lockRelays(relays, senderPubkey)],
    role: 'read',
    lookupRelays: input.peerRouting?.lookupRelays,
  });
  const result = await publishWrapsTrackingRelays(
    [signed],
    relays,
    pool,
    { eventId: signed.id, kind: 4 },
    hooks?.onDeliveryFinalized,
  );
  return { ...result, rumorCreatedAt: signed.created_at };
}
