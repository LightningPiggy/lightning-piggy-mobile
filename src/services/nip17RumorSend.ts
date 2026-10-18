import { enabledAppRelays } from './appRelayPrefs';
// Gift-wrap one unsigned NIP-17 rumor to one recipient and publish it, for the
// signed-in identity's signer (nsec / Amber / NIP-46). Used by Market order
// flows — the buyer's kind-16 order and the seller's payment request / status
// update — which must ALWAYS ride NIP-17, never Marmot and never bare (see
// utils/wrapOnlyKinds). Lifted out of useMarketCheckout so buyer and seller
// share one signer dispatch; it mirrors contexts/useMessageSend rather than
// adding to NostrContext (at its size baseline, #703).
//
// `sendNip17ToMany*` also wraps a copy to the sender, so the rumor echoes back
// through the live DM subscription and threads into the conversation — no
// optimistic insert needed.
import * as nostrService from './nostrService';
import * as amberService from './amberService';
import * as nostrConnectService from './nostrConnectService';
import { getMemoisedSecretKey } from '../contexts/nostrSecretKeyCache';
import type { DmSendResult } from './nostrDmPublish';
import type { RelayConfig } from '../types/nostr';

/** Stable reason a send failed; the UI maps it to localised copy. */
export type Nip17SendErrorCode =
  | 'notSignedIn'
  | 'noRecipient'
  | 'signingKeyMissing'
  | 'unsupportedSigner'
  | 'relayUnreachable';

export class Nip17SendError extends Error {
  constructor(
    readonly code: Nip17SendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Nip17SendError';
  }
}

/** An unsigned rumor (no id / sig — the seal + wrap carry the signatures). */
export interface UnsignedRumor {
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface SendNip17RumorInput {
  /** Active identity (hex) — must equal `rumor.pubkey`. */
  senderPubkey: string | null;
  signerType: string | null | undefined;
  /** User's relay list; write relays are unioned with the defaults. */
  relays: Pick<RelayConfig, 'url' | 'write'>[];
  rumor: UnsignedRumor;
  recipientPubkey: string;
}

/** Signer types that can seal + sign a NIP-17 rumor. */
export const NIP17_SIGNERS = ['nsec', 'amber', 'nip46'] as const;

export function canSendNip17(pubkey: string | null, signerType: string | null | undefined) {
  return Boolean(pubkey && (NIP17_SIGNERS as readonly string[]).includes(signerType ?? ''));
}

/** Write relays ∪ defaults (publish is Promise.any — one responsive relay suffices). */
export function nip17TargetRelays(
  relays: Pick<RelayConfig, 'url' | 'write'>[],
  senderPubkey?: string,
): string[] {
  const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
  return Array.from(
    new Set([
      ...writeRelays,
      ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS, senderPubkey),
    ]),
  );
}

/**
 * Seal + gift-wrap `rumor` to `recipientPubkey` (and a self-copy) and publish.
 * Resolves when the recipient wrap reaches a relay. Self-copy failures stay
 * in the returned diagnostics and must not make an already delivered order retryable.
 */
export async function sendNip17Rumor(input: SendNip17RumorInput): Promise<DmSendResult> {
  const { senderPubkey: pubkey, signerType, rumor } = input;
  if (!pubkey) throw new Nip17SendError('notSignedIn', 'Sign in first');
  if (rumor.pubkey !== pubkey) {
    // Never seal a rumor authored as someone else (identity switched mid-flow).
    throw new Nip17SendError('signingKeyMissing', 'Rumor author is not the active identity');
  }
  const recipient = input.recipientPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recipient)) {
    throw new Nip17SendError('noRecipient', 'Recipient has no valid Nostr pubkey');
  }
  const targetRelays = nip17TargetRelays(input.relays, pubkey);

  let result: DmSendResult;
  if (signerType === 'nsec') {
    // Pubkey-checked read: the shared SecureStore slot must decode to the
    // ACTIVE identity, or the rumor would be sealed with a different key.
    const secretKey = await getMemoisedSecretKey(pubkey);
    if (!secretKey) {
      throw new Nip17SendError(
        'signingKeyMissing',
        'Signing key not found or does not match the active identity',
      );
    }
    result = await nostrService.sendNip17ToManyWithNsec({
      senderSecretKey: secretKey,
      rumor,
      recipientPubkeys: [recipient],
      relays: targetRelays,
    });
  } else if (signerType === 'amber' || signerType === 'nip46') {
    const signer = signerType === 'amber' ? amberService : nostrConnectService;
    result = await nostrService.sendNip17ToManyWithSigner({
      senderPubkey: pubkey,
      rumor,
      recipientPubkeys: [recipient],
      relays: targetRelays,
      signerNip44Encrypt: (plain, to) => signer.requestNip44Encrypt(plain, to, pubkey),
      signerSignSeal: async (unsignedSeal) => {
        // Keep pubkey on the seal — Amber misroutes kind=13 sign_event
        // intents without it (#356). Same rule as the DM send path.
        const { event: signedEventJson } = await signer.requestEventSignature(
          JSON.stringify(unsignedSeal),
          '',
          pubkey,
        );
        if (!signedEventJson) throw new Error('Signer returned an empty signed seal');
        return JSON.parse(signedEventJson);
      },
    });
  } else {
    throw new Nip17SendError('unsupportedSigner', 'Unsupported signer');
  }

  const recipientOutcome = result.wrapOutcomes.find((wrap) => wrap.recipientPubkey === recipient);
  if (!recipientOutcome?.published) {
    throw new Nip17SendError(
      'relayUnreachable',
      recipientOutcome?.error ??
        result.errors[0] ??
        'Could not reach a relay to deliver the message',
    );
  }
  return result;
}
