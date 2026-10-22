import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback } from 'react';
import { sendNip04Message } from '../services/nostrNip04Send';
import { sendMarmotDm } from '../services/marmotSend';
import type { DmProtocol } from '../utils/dmProtocol';
import { preferredDmProtocol } from '../services/preferredDmProtocol';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import * as nostrConnectService from '../services/nostrConnectService';
import { getMemoisedSecretKey } from './nostrSecretKeyCache';
import { paintOptimisticBubble } from './nostrDecryptPacing';
import { createFileMessageRumor } from '../services/nostrFileMessage';
import { directMessageRumorEventId } from '../services/dmRumorId';
import { NWC_SHARE_KIND, serializeNwcShare, type NwcShareCard } from '../utils/nwcShareMessage';
import type { EncryptedUpload } from '../services/imageUploadService';
import type { DmSendResult } from '../services/nostrService';
import type { SignerType, RelayConfig } from '../types/nostr';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';
import type { MarmotUnreachableReason } from '../services/marmotFallback';

// A send carries the per-relay delivery breakdown so the optimistic bubble can
// show its tick and persist it (#856). `success` means the send FULLY delivered
// — every intended wrap published and no signer/publish errors — and drives
// whether the composer clears the draft; a partial send (e.g. self-wrap landed
// but the recipient wrap failed) is NOT success, so the draft is kept for
// Re-publish (see `toTextSendResult`). `delivery` is present for any send that
// reached the publish stage (delivered / partial / all-failed alike), so the
// optimistic bubble can settle to its final tick; only a hard pre-publish error
// (not logged in, signer cancelled) omits it (#857).
export interface SendResult {
  success: boolean;
  /** Timestamp of the built outgoing rumor, for share/echo reconciliation. */
  rumorCreatedAt?: number;
  error?: string;
  delivery?: DeliveryStatus;
  /** A Marmot send that failed because the peer has no usable key package —
   *  why, so the caller can offer NIP-17 instead. */
  marmotUnreachable?: MarmotUnreachableReason;
}

// Per-send options. `protocol` picks the wire format for a send (defaults to
// the preferred recipient protocol; Marmot rides the peer's MLS DM group). The hooks
// drive the optimistic-send flow (#857): `onRumorReady` fires
// synchronously once the stable rumor eventId is known (before publishing), so
// the caller can paint the pending bubble keyed by it. It also carries the
// `relays` the send is going out to, so the pending/failed status can seed its
// relay breakdown for the info sheet even before any relay settles (so a still-
// pending or hung send still lists its relays). `onDeliveryFinalized` fires
// later with the COMPLETE per-relay breakdown after all relays settle.
export interface SendHooks {
  protocol?: DmProtocol;
  onRumorReady?: (meta: { eventId: string; kind: number; relays: string[] }) => void;
  onDeliveryFinalized?: (delivery: DeliveryStatus) => void;
}

/**
 * NIP-17 message-send hook (#235, #227). Holds the three outbound paths —
 * 1:1 text, 1:1 encrypted file (voice note), and group — extracted from
 * NostrContext so that file (over the 1,000-line cap, #703) stays under
 * baseline. Pure send logic: each method closes over only the four values
 * passed in, so the hook is a thin, dependency-explicit slice of the
 * provider. Both nsec (signs locally) and Amber (per-recipient signEvent +
 * nip44Encrypt round-trips) signers are supported.
 */
export interface UseMessageSendParams {
  pubkey: string | null;
  isLoggedIn: boolean;
  signerType: SignerType | null;
  relays: RelayConfig[];
}

// Map a NIP-17 multi-wrap send result to the composer's success/draft outcome.
//
// A 1:1 send always fans out a self-wrap + a recipient wrap. `delivery.delivered`
// only means SOME wrap reached SOME relay, so it can be `true` when just the
// self-wrap landed but the recipient wrap was never signed (signer cancelled /
// denied after the first seal — see the sequential loop in
// `sendNip17ToManyWithSigner`) or never accepted by any relay. Gating `success`
// on `delivered` would then clear the composer for a message the recipient never
// received. Instead require the strict partial-send test the file-message path
// below already uses: at least one wrap published AND no signer/publish errors.
// `delivery` is still returned in every case so the optimistic bubble settles to
// its final tick and a partial/failed send keeps the draft for Re-publish
// (#857; Copilot review on #283).
function toTextSendResult(result: DmSendResult, rumorCreatedAt?: number): SendResult {
  const fullyDelivered = result.wrapsPublished > 0 && result.errors.length === 0;
  return {
    success: fullyDelivered,
    rumorCreatedAt,
    delivery: result.delivery,
    error: fullyDelivered ? undefined : (result.errors[0] ?? 'Send failed'),
  };
}

export function useMessageSend({ pubkey, isLoggedIn, signerType, relays }: UseMessageSendParams) {
  const sendDirectMessage = useCallback(
    async (recipientPubkey: string, plaintext: string, hooks?: SendHooks): Promise<SendResult> => {
      if (!pubkey || !isLoggedIn) {
        return { success: false, error: 'Not logged in' };
      }
      const normalizedRecipientPubkey = recipientPubkey.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedRecipientPubkey)) {
        return { success: false, error: 'Invalid public key format' };
      }
      const protocol = await preferredDmProtocol(
        pubkey,
        normalizedRecipientPubkey,
        hooks?.protocol,
      );
      if (protocol === 'marmot') {
        return sendMarmotDm(
          pubkey,
          normalizedRecipientPubkey,
          // The p tag makes the rumor id recipient-specific: identical text
          // to two peers in the same second must not collide on event id.
          { kind: 14, content: plaintext, tags: [['p', normalizedRecipientPubkey]] },
          hooks,
        );
      }
      // Union the user's published write relays with DEFAULT_RELAYS. Publish
      // uses Promise.any, so one responsive relay is enough — but a user
      // whose NIP-65 list has a single entry (and no in-app UI to edit it)
      // hits a single-point failure the moment that relay is slow.
      const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
      const targetRelays = Array.from(
        new Set([...writeRelays, ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS)]),
      );
      try {
        if (protocol === 'nip04') {
          const result = await sendNip04Message({
            senderPubkey: pubkey,
            recipientPubkey: normalizedRecipientPubkey,
            plaintext,
            signerType,
            relays: targetRelays,
            hooks,
          });
          return toTextSendResult(result, result.rumorCreatedAt);
        }
        const rumor = nostrService.createDirectMessageRumor({
          senderPubkey: pubkey,
          recipientPubkey: normalizedRecipientPubkey,
          content: plaintext,
        });
        // Stable rumor id — identical on the relay echo — keys the delivery
        // store so the optimistic bubble can be painted before publishing and
        // settled after, surviving the local- → echo id swap (#857).
        const eventId = directMessageRumorEventId(rumor);
        hooks?.onRumorReady?.({ eventId, kind: rumor.kind, relays: targetRelays });
        await paintOptimisticBubble(hooks);

        if (signerType === 'nsec') {
          const secretKey = await getMemoisedSecretKey(pubkey);
          if (!secretKey) return { success: false, error: 'Key not found' };
          const result = await nostrService.sendNip17ToManyWithNsec({
            senderSecretKey: secretKey,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
            onDeliveryFinalized: hooks?.onDeliveryFinalized,
          });
          // Return the per-relay delivery so the bubble can settle to its final
          // tick (delivered / partial / all-failed); `toTextSendResult` gates
          // `success` (composer-clear) on a fully-delivered send so a partial one
          // keeps the draft for Re-publish — no silent drop (#857).
          return toTextSendResult(result, rumor.created_at);
        }

        if (signerType === 'amber') {
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
            onDeliveryFinalized: hooks?.onDeliveryFinalized,
            signerNip44Encrypt: (plain, recipient) =>
              amberService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              // Keep pubkey on the seal — Amber misroutes kind=13 sign_event Intents without it (#356) and lands on its main Apps screen instead of the Sign Event sheet. Same rule as the group-send Amber path further down.
              const { event: signedEventJson } = await amberService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('Amber returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          return toTextSendResult(result, rumor.created_at);
        }

        if (signerType === 'nip46') {
          // NIP-17 send over NIP-46. Same Encrypt → SignSeal → Publish
          // shape as the Amber path, just over a relay round-trip
          // instead of an Android Intent. `requestEventSignature`
          // strips pubkey/id/sig internally to build the EventTemplate
          // the BunkerSigner expects, so we can hand it the full seal.
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
            onDeliveryFinalized: hooks?.onDeliveryFinalized,
            signerNip44Encrypt: (plain, recipient) =>
              nostrConnectService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              const { event: signedEventJson } = await nostrConnectService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('NIP-46 signer returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          return toTextSendResult(result, rumor.created_at);
        }

        return { success: false, error: 'Unsupported signer type' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send message';
        return { success: false, error: message };
      }
    },
    [pubkey, isLoggedIn, signerType, relays],
  );

  // Gift-wrap a pre-built NIP-17 rumor of ANY inner kind to one or more
  // recipients (#203 structured polls). Mirrors `sendDirectMessage` but the
  // caller supplies the rumor (a kind-1068 poll / kind-1018 vote) so its
  // structured tags survive to the wire — `sendDirectMessage` only knows how to
  // build a kind-14 chat rumor. The sender is always included by
  // `wrapManyEvents`, so a 1:1 vote to `[author]` still lands the voter's own
  // self-copy for their optimistic tally.
  const sendDirectRumor = useCallback(
    async (
      recipientPubkeys: string[],
      rumor: {
        kind: number;
        created_at: number;
        tags: string[][];
        content: string;
        pubkey: string;
      },
      hooks?: SendHooks,
    ): Promise<SendResult> => {
      if (!pubkey || !isLoggedIn) {
        return { success: false, error: 'Not logged in' };
      }
      const normalized = Array.from(
        new Set(
          recipientPubkeys
            .map((p) => p.trim().toLowerCase())
            .filter((p) => /^[0-9a-f]{64}$/.test(p)),
        ),
      );
      if (normalized.length === 0) {
        return { success: false, error: 'No valid recipients' };
      }
      const peers = normalized.filter((p) => p !== pubkey.toLowerCase());
      const protocol =
        peers.length === 1
          ? await preferredDmProtocol(pubkey, peers[0], hooks?.protocol)
          : hooks?.protocol;
      if (protocol === 'marmot') {
        // A 1:1 Marmot thread: the one other party is the DM peer.
        const peer = normalized.find((p) => p !== pubkey.toLowerCase());
        if (!peer) return { success: false, error: 'No valid recipients' };
        return sendMarmotDm(pubkey, peer, rumor, hooks);
      }
      const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
      const targetRelays = Array.from(
        new Set([...writeRelays, ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS)]),
      );
      try {
        const eventId = directMessageRumorEventId(rumor);
        hooks?.onRumorReady?.({ eventId, kind: rumor.kind, relays: targetRelays });
        await paintOptimisticBubble(hooks);

        if (signerType === 'nsec') {
          const secretKey = await getMemoisedSecretKey(pubkey);
          if (!secretKey) return { success: false, error: 'Key not found' };
          const result = await nostrService.sendNip17ToManyWithNsec({
            senderSecretKey: secretKey,
            rumor,
            recipientPubkeys: normalized,
            relays: targetRelays,
            onDeliveryFinalized: hooks?.onDeliveryFinalized,
          });
          return {
            success: result.delivery.delivered,
            delivery: result.delivery,
            error: result.delivery.delivered ? undefined : (result.errors[0] ?? 'Send failed'),
          };
        }

        if (signerType === 'amber') {
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: normalized,
            relays: targetRelays,
            onDeliveryFinalized: hooks?.onDeliveryFinalized,
            signerNip44Encrypt: (plain, recipient) =>
              amberService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              const { event: signedEventJson } = await amberService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('Amber returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          return {
            success: result.delivery.delivered,
            delivery: result.delivery,
            error: result.delivery.delivered ? undefined : (result.errors[0] ?? 'Send failed'),
          };
        }

        if (signerType === 'nip46') {
          // Same Encrypt → SignSeal → Publish shape as `sendDirectMessage`'s
          // NIP-46 branch, so polls and chat reactions (#1319) work over a
          // remote signer too.
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: normalized,
            relays: targetRelays,
            onDeliveryFinalized: hooks?.onDeliveryFinalized,
            signerNip44Encrypt: (plain, recipient) =>
              nostrConnectService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              const { event: signedEventJson } = await nostrConnectService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('NIP-46 signer returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          return {
            success: result.delivery.delivered,
            delivery: result.delivery,
            error: result.delivery.delivered ? undefined : (result.errors[0] ?? 'Send failed'),
          };
        }

        return { success: false, error: 'Unsupported signer type' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send';
        return { success: false, error: message };
      }
    },
    [pubkey, isLoggedIn, signerType, relays],
  );

  // Encrypted NIP-17 kind-15 file message (voice note, #235). The blob is
  // already encrypted + uploaded; this gift-wraps the URL + AES key/nonce
  // to the recipient (and the sender's own inbox copy).
  const sendFileMessage = useCallback(
    async (
      recipientPubkey: string,
      file: EncryptedUpload,
      protocol?: DmProtocol,
    ): Promise<SendResult> => {
      if (!pubkey || !isLoggedIn) {
        return { success: false, error: 'Not logged in' };
      }
      const normalizedRecipientPubkey = recipientPubkey.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedRecipientPubkey)) {
        return { success: false, error: 'Invalid public key format' };
      }
      const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
      const targetRelays = Array.from(
        new Set([...writeRelays, ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS)]),
      );
      try {
        const rumor = createFileMessageRumor({
          senderPubkey: pubkey,
          recipientPubkey: normalizedRecipientPubkey,
          url: file.url,
          mime: file.mime,
          keyHex: file.keyHex,
          nonceHex: file.nonceHex,
          sha256Hex: file.sha256Hex,
          size: file.size,
          filename: file.filename,
        });
        const preferred = await preferredDmProtocol(pubkey, normalizedRecipientPubkey, protocol);
        if (preferred === 'marmot') {
          return await sendMarmotDm(pubkey, normalizedRecipientPubkey, rumor);
        }

        if (signerType === 'nsec') {
          const secretKey = await getMemoisedSecretKey(pubkey);
          if (!secretKey) return { success: false, error: 'Key not found' };
          const result = await nostrService.sendNip17ToManyWithNsec({
            senderSecretKey: secretKey,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
          });
          if (result.wrapsPublished === 0) {
            return { success: false, error: result.errors[0] ?? 'No wraps published' };
          }
          if (result.errors.length > 0) {
            const intended = result.wrapsPublished + result.errors.length;
            return {
              success: false,
              error: `Send incomplete — published ${result.wrapsPublished} of ${intended} wraps. ${result.errors[0]}`,
            };
          }
          return { success: true, delivery: result.delivery };
        }

        if (signerType === 'amber') {
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
            signerNip44Encrypt: (plain, recipient) =>
              amberService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              const { event: signedEventJson } = await amberService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('Amber returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          if (result.wrapsPublished === 0) {
            return { success: false, error: result.errors[0] ?? 'No wraps published' };
          }
          if (result.errors.length > 0) {
            const intended = result.wrapsPublished + result.errors.length;
            return {
              success: false,
              error: `Send incomplete — published ${result.wrapsPublished} of ${intended} wraps. ${result.errors[0]}`,
            };
          }
          return { success: true, delivery: result.delivery };
        }

        if (signerType === 'nip46') {
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
            signerNip44Encrypt: (plain, recipient) =>
              nostrConnectService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              const { event: signedEventJson } = await nostrConnectService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('NIP-46 signer returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          if (result.wrapsPublished === 0) {
            return { success: false, error: result.errors[0] ?? 'No wraps published' };
          }
          if (result.errors.length > 0) {
            const intended = result.wrapsPublished + result.errors.length;
            return {
              success: false,
              error: `Send incomplete — published ${result.wrapsPublished} of ${intended} wraps. ${result.errors[0]}`,
            };
          }
          return { success: true, delivery: result.delivery };
        }

        return { success: false, error: 'Unsupported signer type' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send file';
        return { success: false, error: message };
      }
    },
    [pubkey, isLoggedIn, signerType, relays],
  );

  // Share an NWC wallet (#431). The NWC connection string is a BEARER SECRET,
  // so it goes out ONLY inside a NIP-17 gift wrap (the same encrypted, peer-only
  // path as every DM) — never a public/plaintext event. The inner rumor carries
  // the app-specific `NWC_SHARE_KIND` with the share JSON as content; the
  // recipient's client rebuilds an "Add NWC Wallet" card from it. Mirrors
  // `sendFileMessage` (no delivery-tick hooks — the card has no tick UI).
  const sendNwcShare = useCallback(
    async (
      recipientPubkey: string,
      card: NwcShareCard,
      protocol?: DmProtocol,
    ): Promise<SendResult> => {
      if (!pubkey || !isLoggedIn) {
        return { success: false, error: 'Not logged in' };
      }
      const normalizedRecipientPubkey = recipientPubkey.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedRecipientPubkey)) {
        return { success: false, error: 'Invalid public key format' };
      }
      const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
      const targetRelays = Array.from(
        new Set([...writeRelays, ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS)]),
      );
      try {
        const rumor = {
          pubkey,
          kind: NWC_SHARE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', normalizedRecipientPubkey]],
          content: serializeNwcShare(card),
        };
        const preferred = await preferredDmProtocol(pubkey, normalizedRecipientPubkey, protocol);
        if (preferred === 'marmot') {
          return await sendMarmotDm(pubkey, normalizedRecipientPubkey, {
            kind: rumor.kind,
            content: rumor.content,
            tags: rumor.tags,
          });
        }

        if (signerType === 'nsec') {
          const secretKey = await getMemoisedSecretKey(pubkey);
          if (!secretKey) return { success: false, error: 'Key not found' };
          const result = await nostrService.sendNip17ToManyWithNsec({
            senderSecretKey: secretKey,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
          });
          // Strict success: at least one wrap published AND no signer/publish
          // errors — `delivery.delivered` alone can be true when only the
          // self-wrap landed but the recipient wrap failed, which would wrongly
          // claim "Wallet shared" (Copilot review on #431).
          return toTextSendResult(result, rumor.created_at);
        }

        if (signerType === 'amber') {
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
            signerNip44Encrypt: (plain, recipient) =>
              amberService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              const { event: signedEventJson } = await amberService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('Amber returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          return toTextSendResult(result, rumor.created_at);
        }

        if (signerType === 'nip46') {
          // NIP-17 share over NIP-46 — same Encrypt → SignSeal → Publish shape
          // as the Amber path, over a relay round-trip instead of an Android
          // Intent. Mirrors `sendDirectMessage`'s nip46 branch so Wallet Share
          // works for users logged in via a remote signer (Copilot review on #431).
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: [normalizedRecipientPubkey],
            relays: targetRelays,
            signerNip44Encrypt: (plain, recipient) =>
              nostrConnectService.requestNip44Encrypt(plain, recipient, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              const { event: signedEventJson } = await nostrConnectService.requestEventSignature(
                JSON.stringify(unsignedSeal),
                '',
                currentUser,
              );
              if (!signedEventJson) {
                throw new Error('NIP-46 signer returned empty signed seal');
              }
              return JSON.parse(signedEventJson);
            },
          });
          return toTextSendResult(result, rumor.created_at);
        }

        return { success: false, error: 'Unsupported signer type' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to share wallet';
        return { success: false, error: message };
      }
    },
    [pubkey, isLoggedIn, signerType, relays],
  );

  return { sendDirectMessage, sendDirectRumor, sendFileMessage, sendNwcShare };
}

export type MessageSendApi = ReturnType<typeof useMessageSend>;
