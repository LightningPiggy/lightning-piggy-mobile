import { generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import * as nip59 from 'nostr-tools/nip59';
import { lockRelays } from '../config/testRelayLockdown';
import { pool, trackRelays } from './nostrPool';
import {
  publishWrapsTrackingRelays,
  type DmSendResult,
  type OnDeliveryFinalized,
} from './nostrDmPublish';
import { nip44EncryptForRecipient, nostrFinalizeEvent, nostrGetEventHash } from './nostrCrypto';
import { yieldToEventLoop } from '../contexts/nostrDecryptPacing';

/**
 * NIP-17 multi-recipient send (nsec path). Inlines `wrapManyEvents` with
 * `yieldToEventLoop()` between recipients (#1033) — same nip59.wrapEvent
 * helper, same self-wrap-first + recipient-dedup semantics, but yields an
 * RAF frame between wraps so per-recipient crypto doesn't block the UI.
 */
export async function sendNip17ToManyWithNsec(input: {
  senderSecretKey: Uint8Array;
  rumor: { kind: number; created_at: number; tags: string[][]; content: string };
  recipientPubkeys: string[];
  relays: string[];
  onDeliveryFinalized?: OnDeliveryFinalized;
  /** Also wrap to the sender (default). A NIP-171 group message goes to its
   * epoch key only: the sender reads it from there. */
  includeSelf?: boolean;
}): Promise<DmSendResult> {
  const senderPublicKey = getPublicKey(input.senderSecretKey);
  // Bind the destination policy to the sender before any yield or signer await.
  const relays = [...lockRelays(input.relays, senderPublicKey)];
  trackRelays(relays);
  const eventId = nostrGetEventHash({ ...input.rumor, pubkey: senderPublicKey });
  // Self-wrap first (matching wrapManyEvents); sender deduped out if also in recipients.
  const recipients = Array.from(
    new Set([
      ...(input.includeSelf === false ? [] : [senderPublicKey.toLowerCase()]),
      ...input.recipientPubkeys.map((p) => p.toLowerCase()),
    ]),
  );
  const signedWraps: VerifiedEvent[] = [];
  for (let i = 0; i < recipients.length; i++) {
    if (i > 0) await yieldToEventLoop();
    const wrap = nip59.wrapEvent(input.rumor as Parameters<typeof nip59.wrapEvent>[0], input.senderSecretKey, recipients[i]); // prettier-ignore
    signedWraps.push(wrap as VerifiedEvent);
  }
  return publishWrapsTrackingRelays(signedWraps, relays, pool, { eventId, kind: input.rumor.kind }, input.onDeliveryFinalized); // prettier-ignore
}

/**
 * NIP-17 multi-recipient send for signers that don't expose a raw secret
 * key (Amber, NIP-46, etc.). Mirrors `sendNip17ToManyWithNsec` but routes
 * the two operations that require the user's key — the seal's NIP-44
 * encryption and the seal's signature — through caller-supplied async
 * callbacks. The wrap (kind-1059) is signed with a fresh ephemeral key
 * generated locally, so it does not need the signer.
 *
 * Per recipient (and once for the sender, so other devices receive their
 * own message) this triggers, via the callbacks:
 *
 *   1× signerNip44Encrypt(rumorJson, recipientPubkey)
 *   1× signerSignSeal(unsignedSeal)
 *
 * Both calls are awaited SEQUENTIALLY across recipients. Amber's native
 * module rejects concurrent intents with a `BUSY` error, so the loop
 * MUST NOT use Promise.all over the per-recipient signing path. Wrap
 * publishing is parallel (no signer involvement).
 *
 * The first signing failure aborts the loop and is surfaced via `errors`;
 * any wraps already produced for prior recipients are still published.
 */
export async function sendNip17ToManyWithSigner(input: {
  senderPubkey: string;
  rumor: { kind: number; created_at: number; tags: string[][]; content: string; pubkey: string };
  recipientPubkeys: string[];
  relays: string[];
  signerNip44Encrypt: (plaintext: string, recipientPubkey: string) => Promise<string>;
  signerSignSeal: (unsignedSeal: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
    pubkey: string;
  }) => Promise<{
    id: string;
    pubkey: string;
    sig: string;
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }>;
  onDeliveryFinalized?: OnDeliveryFinalized; // Background settle for the tick (#857).
  /** Also wrap to the sender (default); see sendNip17ToManyWithNsec. */
  includeSelf?: boolean;
}): Promise<DmSendResult> {
  const relays = [...lockRelays(input.relays, input.senderPubkey)];
  trackRelays(relays);

  // Match nostr-tools' `wrapManyEvents` semantics: include the sender so
  // their own message lands in their inbox on other devices. Dedup the
  // combined list so a sender who is also explicitly p-tagged isn't
  // wrapped twice.
  const recipients = Array.from(
    new Set(
      [...(input.includeSelf === false ? [] : [input.senderPubkey]), ...input.recipientPubkeys].map(
        (p) => p.toLowerCase(),
      ),
    ),
  );

  // Compute the rumor id once. The rumor is never signed (nostr-tools
  // calls this a "rumor" precisely because it has no signature) — only
  // its id is needed so receivers can dedupe across multiple wraps.
  const rumorWithId = { ...input.rumor, id: nostrGetEventHash(input.rumor) };
  const rumorJson = JSON.stringify(rumorWithId);

  // Spec: each seal/wrap uses a randomized created_at within the past
  // ~2 days to defeat traffic correlation. Mirror nostr-tools nip59.
  const TWO_DAYS = 2 * 24 * 60 * 60;
  const randomNow = (): number =>
    Math.round(Math.floor(Date.now() / 1000) - Math.random() * TWO_DAYS);

  const errors: string[] = [];
  const signedWraps: VerifiedEvent[] = [];

  // SEQUENTIAL — Amber's BUSY guard rejects parallel intents, and
  // alternating "seal sign" / "nip44 encrypt" prompts share that guard.
  for (const recipient of recipients) {
    try {
      const sealCiphertext = await input.signerNip44Encrypt(rumorJson, recipient);
      const unsignedSeal = {
        kind: 13, // Seal (NIP-59)
        created_at: randomNow(),
        tags: [] as string[][],
        content: sealCiphertext,
        pubkey: input.senderPubkey,
      };
      const signedSeal = await input.signerSignSeal(unsignedSeal);

      // The wrap uses an ephemeral key — never the user's key — so we
      // can finalize it locally without any signer round-trip. The wrap's
      // `pubkey` is the ephemeral pubkey (set by finalizeEvent); the only
      // identifier on the wrap that ties it to a recipient is the `p` tag.
      const ephemeralKey = generateSecretKey();
      const sealJson = JSON.stringify(signedSeal);
      const wrapContent = nip44EncryptForRecipient(sealJson, ephemeralKey, recipient);
      const wrap = nostrFinalizeEvent(
        {
          kind: 1059, // GiftWrap (NIP-59)
          created_at: randomNow(),
          tags: [['p', recipient]],
          content: wrapContent,
        },
        ephemeralKey,
      );
      signedWraps.push(wrap);
    } catch (e) {
      errors.push((e as Error)?.message ?? 'signer step failed');
      // First failure is almost certainly user-cancellation in Amber or
      // a permission denial; bail rather than firing N more dialogs.
      break;
    }
  }

  // Any signer-step errors collected above are merged with the publish
  // results so the caller still sees both failure classes.
  const publishResult = await publishWrapsTrackingRelays(
    signedWraps,
    relays,
    pool,
    { eventId: rumorWithId.id, kind: input.rumor.kind },
    input.onDeliveryFinalized,
  );
  return {
    ...publishResult,
    errors: [...errors, ...publishResult.errors],
  };
}
