import { enabledAppRelays } from '../services/appRelayPrefs';
import { marmotReplyTags } from '../services/marmotEdits';
import { useCallback } from 'react';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import * as nostrConnectService from '../services/nostrConnectService';
import { getMemoisedSecretKey } from './nostrSecretKeyCache';
import { paintOptimisticBubble } from './nostrDecryptPacing';
import { createGroupFileRumor } from '../services/nostrFileMessage';
import { directMessageRumorEventId } from '../services/dmRumorId';
import type { EncryptedUpload } from '../services/imageUploadService';
import type { RelayConfig, SignerType } from '../types/nostr';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';
import { isNip171GroupId } from '../utils/nip171';
import { nip171Outgoing } from '../services/nip171Groups';
import { isMarmotGroupId } from '../services/marmotSession';
import { sendMarmotGroupRumor } from '../services/marmotSend';
import { mentionedPubkeys } from '../utils/chatMentions';

/**
 * Provider-owned slices the group-messaging callbacks close over: the
 * active identity (`pubkey`, `isLoggedIn`, `signerType`) and the merged
 * relay list (`relays`). Threading them in keeps the extracted logic
 * byte-for-byte equivalent to the inline provider version.
 */
export interface UseGroupMessagingOptions {
  pubkey: string | null;
  isLoggedIn: boolean;
  signerType: SignerType | null;
  relays: RelayConfig[];
}

// Early hook for the group optimistic-send flow (#1033). Fires synchronously
// once the stable rumor eventId is known (before any signing), so the caller
// can paint the pending bubble keyed by it — parity with the 1:1 path's
// `SendHooks.onRumorReady` in `useMessageSend.ts`.
//
// Like a 1:1 send, the bubble then shows pending → sent / failed from the
// result's per-relay `delivery` (session-scoped group delivery store); a
// failed send keeps its bubble, with Re-publish in the message-info sheet.
// `relays`: the send's target relays (a Marmot group's are its own, omitted).
export interface GroupSendHooks {
  onRumorReady?: (meta: { rumorId: string; kind: number; relays?: string[] }) => void;
}

/** A group send's outcome. `rumorId`: the sent Marmot event's id (Marmot
 * groups only) — what edits and deletes of the message target. */
export interface GroupSendResult {
  success: boolean;
  wrapsPublished?: number;
  error?: string;
  rumorId?: string;
  /** Per-relay publish outcome, when the send reached the publish stage. */
  delivery?: DeliveryStatus;
}

/**
 * The two group callbacks the provider re-exposes through the context
 * value: a NIP-17 group send and the kind-30200 group-state publish.
 */
export interface UseGroupMessagingResult {
  sendGroupMessage: (
    input: {
      groupId: string;
      subject: string;
      memberPubkeys: string[];
      /** Text body. Optional when sending a `file` (kind-15) message. */
      text?: string;
      replyTo?: string;
      /** When set, sends an encrypted NIP-17 kind-15 group file message
       *  (e.g. a voice note, #235) instead of a kind-14 chat message. */
      file?: EncryptedUpload;
    },
    hooks?: GroupSendHooks,
  ) => Promise<GroupSendResult>;
  publishGroupState: (input: {
    groupId: string;
    name: string;
    memberPubkeys: string[];
  }) => Promise<{ success: boolean; error?: string }>;
}

/**
 * The Marmot shape of a group rumor (#1295). MLS membership already names the
 * audience, so the NIP-17 roster `p` tags and `subject` are dropped; a `p`
 * tag goes on each member the text mentions (`nostr:npub…`), which Marmot
 * clients such as White Noise read as the mention list.
 */
export function marmotGroupDraft<R extends { kind: number; content: string; tags: string[][] }>(
  rumor: R,
): R {
  const kept = rumor.tags.filter((t) => t[0] !== 'p' && t[0] !== 'subject');
  const mentionTags = mentionedPubkeys(rumor.content).map((pk) => ['p', pk]);
  return { ...rumor, tags: [...kept, ...mentionTags] };
}

export function useGroupMessaging(options: UseGroupMessagingOptions): UseGroupMessagingResult {
  const { pubkey, isLoggedIn, signerType, relays } = options;

  /**
   * NIP-17 multi-recipient send. Supports both nsec (signs locally) and
   * Amber (per-recipient signEvent + nip44Encrypt round-trips) signers.
   *
   * Amber path is sequential by design — the native module rejects
   * concurrent intents with `BUSY` (see modules/amber-signer/.../
   * AmberSignerModule.kt → launchIntent). With N recipients (+1 for the
   * sender's own inbox copy), this fires up to 2N Amber prompts unless
   * the user has pre-granted blanket permission for `sign_event` and
   * `nip44_encrypt`, in which case Amber's ContentResolver fast-path
   * resolves silently. See issue #247.
   *
   * `hooks.onRumorReady` (#1033) fires synchronously before any signing,
   * so the caller can paint the optimistic bubble immediately — the same
   * pattern as the 1:1 `SendHooks.onRumorReady` in useMessageSend.ts.
   */
  const sendGroupMessage = useCallback(
    async (
      input: {
        groupId: string;
        subject: string;
        memberPubkeys: string[];
        text?: string;
        replyTo?: string;
        file?: EncryptedUpload;
      },
      hooks?: GroupSendHooks,
    ): Promise<GroupSendResult> => {
      if (!pubkey || !isLoggedIn) return { success: false, error: 'Not logged in' };
      const text = (input.text ?? '').trim();
      if (!input.file && !text) return { success: false, error: 'Empty message' };
      const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
      const targetRelays = Array.from(
        new Set([...writeRelays, ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS)]),
      );
      // NIP-171: one wrap to the group's current epoch key, tagged per the
      // draft, instead of a per-member fan-out (and no self-copy).
      const nip171 = isNip171GroupId(input.groupId)
        ? input.file
          ? { error: 'Files are not supported in NIP-171 groups yet' }
          : nip171Outgoing(pubkey, input.groupId, text, targetRelays)
        : null;
      if (nip171 && 'error' in nip171) return { success: false, error: nip171.error };
      const recipients = nip171 ? nip171.recipientPubkeys : input.memberPubkeys;
      const sendRelays = nip171 ? nip171.relays : targetRelays;
      const includeSelf = !nip171;
      try {
        // kind-15 encrypted file (voice note, #235) when a `file` is given;
        // otherwise the standard kind-14 group chat rumor.
        const rumor = nip171
          ? nip171.rumor
          : input.file
            ? createGroupFileRumor({
                senderPubkey: pubkey,
                subject: input.subject,
                memberPubkeys: input.memberPubkeys,
                url: input.file.url,
                mime: input.file.mime,
                keyHex: input.file.keyHex,
                nonceHex: input.file.nonceHex,
                sha256Hex: input.file.sha256Hex,
                size: input.file.size,
                filename: input.file.filename,
              })
            : nostrService.createGroupChatRumor({
                senderPubkey: pubkey,
                subject: input.subject,
                memberPubkeys: input.memberPubkeys,
                content: text,
              });

        if (isMarmotGroupId(input.groupId) && !input.file) {
          rumor.tags.push(...marmotReplyTags(input.replyTo));
        }

        // Compute the stable rumor eventId before any signing (the rumor is
        // never signed — hence "rumor" — so the hash is deterministic from
        // its content fields alone). Fire onRumorReady synchronously so the
        // caller can paint the optimistic bubble before any async work (#1033).
        const rumorId = directMessageRumorEventId(rumor);
        hooks?.onRumorReady?.({ rumorId, kind: rumor.kind, relays: sendRelays });
        await paintOptimisticBubble(hooks);

        // Marmot group: the same rumor rides the group's MLS session instead
        // of a per-member gift-wrap fan-out (no per-recipient signer prompts).
        if (isMarmotGroupId(input.groupId)) {
          return sendMarmotGroupRumor(pubkey, input.groupId, marmotGroupDraft(rumor));
        }

        if (signerType === 'nsec') {
          const secretKey = await getMemoisedSecretKey(pubkey);
          if (!secretKey) return { success: false, error: 'Key not found' };
          const result = await nostrService.sendNip17ToManyWithNsec({
            senderSecretKey: secretKey,
            rumor,
            recipientPubkeys: recipients,
            includeSelf,
            relays: sendRelays,
          });
          if (result.wrapsPublished === 0) {
            return {
              success: false,
              error: result.errors[0] ?? 'No wraps published',
              delivery: result.delivery,
            };
          }
          // Partial send — some recipients got the message, others didn't
          // (typically the user cancelled an Amber prompt mid-loop, or
          // a relay rejected one wrap). Surface this as a non-fatal
          // failure rather than silent success so the composer doesn't
          // clear and the user sees how many members actually received it.
          if (result.errors.length > 0) {
            const intended = result.wrapsPublished + result.errors.length;
            return {
              success: false,
              wrapsPublished: result.wrapsPublished,
              error: `Sent to ${result.wrapsPublished} of ${intended} members. ${result.errors[0]}`,
              delivery: result.delivery,
            };
          }
          return {
            success: true,
            wrapsPublished: result.wrapsPublished,
            delivery: result.delivery,
          };
        }

        if (signerType === 'amber') {
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: recipients,
            includeSelf,
            relays: sendRelays,
            signerNip44Encrypt: (plaintext, recipientPubkey) =>
              amberService.requestNip44Encrypt(plaintext, recipientPubkey, currentUser),
            signerSignSeal: async (unsignedSeal) => {
              // Keep pubkey on the seal — Amber misroutes kind=13 sign_event Intents without it (#356).
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
            return {
              success: false,
              error: result.errors[0] ?? 'No wraps published',
              delivery: result.delivery,
            };
          }
          // Partial send — some recipients got the message, others didn't
          // (typically the user cancelled an Amber prompt mid-loop, or
          // a relay rejected one wrap). Surface this as a non-fatal
          // failure rather than silent success so the composer doesn't
          // clear and the user sees how many members actually received it.
          if (result.errors.length > 0) {
            const intended = result.wrapsPublished + result.errors.length;
            return {
              success: false,
              wrapsPublished: result.wrapsPublished,
              error: `Sent to ${result.wrapsPublished} of ${intended} members. ${result.errors[0]}`,
              delivery: result.delivery,
            };
          }
          return {
            success: true,
            wrapsPublished: result.wrapsPublished,
            delivery: result.delivery,
          };
        }

        if (signerType === 'nip46') {
          // NIP-46 group send. Mirrors the Amber path's shape exactly —
          // including the partial-send-as-failure semantics — but routes
          // per-recipient nip44_encrypt + seal-sign calls through the
          // bunker instead of an Android Intent. Each recipient costs 2
          // bunker round-trips, so a large group can take several
          // seconds; the composer shows a spinner while this runs.
          const currentUser = pubkey;
          const result = await nostrService.sendNip17ToManyWithSigner({
            senderPubkey: currentUser,
            rumor,
            recipientPubkeys: recipients,
            includeSelf,
            relays: sendRelays,
            signerNip44Encrypt: (plaintext, recipientPubkey) =>
              nostrConnectService.requestNip44Encrypt(plaintext, recipientPubkey, currentUser),
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
            return {
              success: false,
              error: result.errors[0] ?? 'No wraps published',
              delivery: result.delivery,
            };
          }
          if (result.errors.length > 0) {
            const intended = result.wrapsPublished + result.errors.length;
            return {
              success: false,
              wrapsPublished: result.wrapsPublished,
              error: `Sent to ${result.wrapsPublished} of ${intended} members. ${result.errors[0]}`,
              delivery: result.delivery,
            };
          }
          return {
            success: true,
            wrapsPublished: result.wrapsPublished,
            delivery: result.delivery,
          };
        }

        return { success: false, error: 'Unsupported signer type' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send group message';
        return { success: false, error: message };
      }
    },
    [pubkey, isLoggedIn, signerType, relays],
  );

  /**
   * Publish a kind-30200 group-state event. Single signEvent call —
   * trivially safe for Amber (no per-recipient fan-out, no concurrency).
   */
  const publishGroupState = useCallback(
    async (input: {
      groupId: string;
      name: string;
      memberPubkeys: string[];
    }): Promise<{ success: boolean; error?: string }> => {
      if (!pubkey || !isLoggedIn) return { success: false, error: 'Not logged in' };
      const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
      const targetRelays = Array.from(
        new Set([...writeRelays, ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS)]),
      );
      try {
        const event = nostrService.createGroupStateEvent({
          groupId: input.groupId,
          name: input.name,
          memberPubkeys: input.memberPubkeys,
        });

        if (signerType === 'nsec') {
          const secretKey = await getMemoisedSecretKey(pubkey);
          if (!secretKey) return { success: false, error: 'Key not found' };
          await nostrService.signAndPublishEvent(event, secretKey, targetRelays);
          return { success: true };
        }

        if (signerType === 'amber') {
          // Mirror the kind-4 DM Amber path — pass the unsigned event
          // without `pubkey`; Amber sets it from `current_user`.
          const { event: signedEventJson } = await amberService.requestEventSignature(
            JSON.stringify(event),
            '',
            pubkey,
          );
          if (!signedEventJson) {
            return { success: false, error: 'Amber returned empty event' };
          }
          const signed = JSON.parse(signedEventJson);
          await nostrService.publishSignedEvent(signed, targetRelays);
          return { success: true };
        }

        if (signerType === 'nip46') {
          // Single signEvent — one bunker round-trip, no fan-out.
          const { event: signedEventJson } = await nostrConnectService.requestEventSignature(
            JSON.stringify(event),
            '',
            pubkey,
          );
          if (!signedEventJson) {
            return { success: false, error: 'NIP-46 signer returned empty event' };
          }
          const signed = JSON.parse(signedEventJson);
          await nostrService.publishSignedEvent(signed, targetRelays);
          return { success: true };
        }

        return { success: false, error: 'Unsupported signer type' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to publish group state';
        return { success: false, error: message };
      }
    },
    [pubkey, isLoggedIn, signerType, relays],
  );

  return { sendGroupMessage, publishGroupState };
}
