// The Marmot leg of the 1:1 send seam: every DM send function in
// useMessageSend (text, file, poll, wallet share) builds the same rumor it
// would gift-wrap for NIP-17, then — for a Marmot thread — hands it here
// instead. The rumor rides inside the DM's MLS group, so every message type
// the app supports works unchanged.

import { Buffer } from 'buffer';
import type { SendHooks, SendResult } from '../contexts/useMessageSend';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';
import { paintOptimisticBubble } from '../contexts/nostrDecryptPacing';
import { encodeMarmotMediaUrl } from '../utils/encryptedFileUrl';
import { uploadEncryptedBlobToBlossom, type BlossomSigner } from './blossomService';
import { marmotKindForAppKind } from './marmotInbox';
import { marmotImetaTag } from './marmotMedia';
import { getBlossomServers } from './walletStorageService';
import type { MarmotUnreachableReason } from './marmotFallback';
import { MarmotWelcomeDeliveryError } from './marmotInvitees';
import { MarmotGroupNotReadyError } from './marmotSendGate';
import { t } from '../i18n';
import { MarmotKeyPackageLookupError } from './marmotKeyPackages';
import { amberRequestOpenSince } from './marmotSigner';
import { beginDmSetupTrace } from './marmotDmSetupTrace';
import {
  MarmotNoKeyPackageError,
  MarmotUnusableKeyPackageError,
  MARMOT_CHAT_KIND,
  buildMarmotRumor,
  getMarmotSession,
  type MarmotSession,
} from './marmotSession';

export interface MarmotDraft {
  kind: number;
  content: string;
  tags?: string[][];
  created_at?: number;
}

/** Turn publish acks into the bubble's delivery tick. */
export function marmotDelivery(
  byRelay: Record<string, boolean>,
  meta: { eventId: string; kind: number },
): DeliveryStatus {
  const relayResults: DeliveryStatus['relayResults'] = {};
  for (const [url, ok] of Object.entries(byRelay)) relayResults[url] = ok ? 'ok' : 'failed';
  return {
    delivered: Object.values(byRelay).some(Boolean),
    relayResults,
    targetRelayCount: Object.keys(byRelay).length,
    ...meta,
  };
}

/** Why Marmot can't reach the peer at all (so NIP-17 would still work), or null. */
function marmotUnreachableReason(e: unknown): MarmotUnreachableReason | null {
  if (e instanceof MarmotNoKeyPackageError) return 'noKeyPackage';
  // Seen in the wild: legacy MDK 0.8.x key packages (the classic White Noise
  // app still ships it) that this current-protocol library can't decode, and
  // expired ones. Not the peer's fault — the protocols differ.
  if (e instanceof MarmotUnusableKeyPackageError) return 'outdatedKeyPackage';
  return null;
}

/**
 * Longest a send waits for a NEW 1:1 to be set up (key-package lookup, group
 * creation, the invite commit and its Welcomes). Each step is bounded, but the
 * chain isn't: a Welcome seal waits in the shared signer queue behind any
 * signer request that never settles, and the send button spun for ever (#1658).
 * Headroom for Amber / NIP-46 approvals (two per invited device). Set-up keeps
 * running after this; a retry reuses it (single-flight per peer) or, once the
 * chat exists, sends straight away.
 */
export const DM_SETUP_TIMEOUT_MS = 90_000;

/** Setting up the 1:1 took longer than DM_SETUP_TIMEOUT_MS; nothing was sent.
 * `waitingForAmber`: an Amber approval was still open when it gave up. */
export class MarmotDmSetupTimeoutError extends Error {
  constructor(readonly waitingForAmber = false) {
    super('marmot: secure chat set-up timed out');
    this.name = 'MarmotDmSetupTimeoutError';
  }
}

/** `session.getOrCreateDm`, bounded by DM_SETUP_TIMEOUT_MS. */
export function getOrCreateDmWithin(
  session: Pick<MarmotSession, 'getOrCreateDm'>,
  peer: string,
  timeoutMs = DM_SETUP_TIMEOUT_MS,
): ReturnType<MarmotSession['getOrCreateDm']> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MarmotDmSetupTimeoutError(amberRequestOpenSince() !== null)),
      timeoutMs,
    );
  });
  const trace = beginDmSetupTrace(peer);
  return Promise.race([session.getOrCreateDm(peer), deadline])
    .then(
      (dm) => (trace.end('ok'), dm),
      (e: unknown) => {
        trace.end(
          e instanceof MarmotDmSetupTimeoutError ? 'timeout' : `failed ${(e as Error)?.name}`,
        );
        throw e;
      },
    )
    .finally(() => clearTimeout(timer));
}

/** A user-facing reason a Marmot send couldn't start. */
export function marmotSendError(e: unknown): string {
  const reason = marmotUnreachableReason(e);
  if (reason) return t(`marmotSend.${reason}`);
  if (e instanceof MarmotKeyPackageLookupError) return t('marmotSend.keyPackageLookupFailed');
  if (e instanceof MarmotDmSetupTimeoutError)
    return t(e.waitingForAmber ? 'marmotSend.waitingForAmber' : 'marmotSend.chatSetupTimedOut');
  if (e instanceof MarmotWelcomeDeliveryError) return t('marmotSend.inviteNotDelivered');
  if (e instanceof MarmotGroupNotReadyError) return t('marmotSend.chatNotReady');
  return (e as Error)?.message || 'Marmot send failed';
}

/** A failed send's result: the user-facing reason, plus why the peer can't be
 * reached over Marmot when that's the cause (so NIP-17 would still work). */
function marmotFailure(e: unknown): SendResult {
  const marmotUnreachable = marmotUnreachableReason(e);
  return {
    success: false,
    error: marmotSendError(e),
    ...(marmotUnreachable ? { marmotUnreachable } : {}),
  };
}

export function requireMarmotSession(pubkey: string): MarmotSession {
  const session = getMarmotSession();
  if (!session || session.pubkey !== pubkey) {
    throw new Error('Marmot is still starting up — try again in a moment.');
  }
  return session;
}

/**
 * Send `draft` to `recipient` over their Marmot DM (created on first use).
 * The rumor is sent as built — same tags and created_at — so content-addressed
 * ids (a NIP-88 poll's id is its rumor id) match what the sender stored. Only
 * text changes kind (14 → Marmot's 9), and text carries no correlation id.
 */
export async function sendMarmotDm(
  pubkey: string,
  recipient: string,
  draft: MarmotDraft,
  hooks?: SendHooks,
): Promise<SendResult> {
  try {
    const session = requireMarmotSession(pubkey);
    const dm = await getOrCreateDmWithin(session, recipient);
    // Devices the peer installed since the chat began (#1559): short wait.
    await session.syncDmDevices(dm.id).catch(() => undefined);
    const rumor = buildMarmotRumor(pubkey, {
      kind: marmotKindForAppKind(draft.kind),
      content: draft.content,
      tags: draft.tags,
      created_at: draft.created_at,
    });
    // The app keys bubbles by its own kind (14 = text), not Marmot's 9.
    const meta = { eventId: rumor.id, kind: draft.kind };
    // Paint the bubble before the device sync's relay round trip, not after.
    hooks?.onRumorReady?.({ ...meta, relays: dm.relays });
    await paintOptimisticBubble(hooks);
    // Devices the peer installed since the chat began (#1559): short wait.
    await session.syncDmDevices(dm.id).catch(() => undefined);
    const delivery = marmotDelivery(await session.sendRumor(dm.id, rumor), meta);
    hooks?.onDeliveryFinalized?.(delivery);
    return delivery.delivered
      ? { success: true, delivery, rumorCreatedAt: rumor.created_at }
      : { success: false, delivery, error: 'No relay accepted the message' };
  } catch (e) {
    return marmotFailure(e);
  }
}

/** Send an app rumor into a Marmot group (multi-member). Same "send the
 * rumor as built" rule as {@link sendMarmotDm}. Resolves the sent Marmot
 * event's id as `rumorId`. */
export async function sendMarmotGroupRumor(
  pubkey: string,
  appGroupId: string,
  draft: MarmotDraft,
): Promise<{
  success: boolean;
  wrapsPublished?: number;
  error?: string;
  rumorId?: string;
  delivery?: DeliveryStatus;
}> {
  try {
    const session = requireMarmotSession(pubkey);
    const rumor = buildMarmotRumor(pubkey, {
      kind: marmotKindForAppKind(draft.kind),
      content: draft.content,
      tags: draft.tags,
      created_at: draft.created_at,
    });
    const byRelay = await session.sendRumor(appGroupId, rumor);
    const accepted = Object.values(byRelay).filter(Boolean).length;
    const delivery = marmotDelivery(byRelay, { eventId: rumor.id, kind: draft.kind });
    // The Marmot id (not the app rumor's): what edits / deletes must target.
    return accepted > 0
      ? { success: true, wrapsPublished: accepted, rumorId: rumor.id, delivery }
      : { success: false, error: 'No relay accepted the message', delivery };
  } catch (e) {
    return { success: false, error: marmotSendError(e) };
  }
}

/** App kind the photo / voice row is stored under (NIP-17's file kind — see marmotInbox). */
const MARMOT_IMAGE_ROW_KIND = 15;
/** Re-encrypt + re-upload at most this many times if the epoch keeps moving. */
const MAX_EPOCH_RETRIES = 3;

export interface MarmotImage {
  /** Local file uri (names the upload) + its bytes as base64. */
  uri: string;
  base64: string;
  mime: string;
  /** Attachment filename; defaults to `photo.<ext>`. White Noise names its
   * voice notes `voice-<ms>ms.m4a`, and so do we. */
  filename?: string;
}

/** Voice notes are AAC in an MP4 container — White Noise's own recording
 * format (`audio/mp4`, `.m4a`), so each client can play the other's. */
export const MARMOT_VOICE_MIME = 'audio/mp4';
export const marmotVoiceFilename = (durationMs: number) =>
  `voice-${Math.max(0, Math.round(durationMs))}ms.m4a`;

/**
 * Send a photo or voice note the Marmot way (MIP-04): encrypt it under the group's epoch,
 * upload the ciphertext to Blossom, and send a kind-9 chat event carrying its
 * `imeta` tag — the shape White Noise and other Marmot clients render.
 * `target` is a 1:1 peer (DM created on first use) or an app group id.
 * `onRumorReady` carries the row text (the `#lpe=1` URL) for the optimistic bubble.
 */
export async function sendMarmotImage(
  pubkey: string,
  target: { peer: string } | { groupId: string },
  image: MarmotImage,
  signer: BlossomSigner,
  hooks?: {
    onRumorReady?: (meta: {
      eventId: string;
      kind: number;
      relays: string[];
      text: string;
    }) => void;
    onDeliveryFinalized?: SendHooks['onDeliveryFinalized'];
  },
): Promise<SendResult> {
  try {
    const session = requireMarmotSession(pubkey);
    const group =
      'peer' in target
        ? await getOrCreateDmWithin(session, target.peer)
        : session.getGroup(target.groupId);
    if (!group) throw new Error('This group is not available yet.');
    // Before encrypting: a device added now needs this epoch's key (#1559).
    if ('peer' in target) await session.syncDmDevices(group.id).catch(() => undefined);
    const plaintext = new Uint8Array(Buffer.from(image.base64, 'base64'));
    const filename =
      image.filename ?? `photo.${image.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg'}`;
    const isVoice = image.mime.startsWith('audio/');
    // The file key is bound to the epoch we encrypt under. If a commit moves
    // the group on during a slow upload, a member added by it never held that
    // epoch and couldn't decrypt — so re-encrypt under the new one.
    let sealed: Awaited<ReturnType<MarmotSession['encryptMedia']>> | undefined;
    let url = '';
    for (let attempt = 0; attempt < MAX_EPOCH_RETRIES; attempt++) {
      const candidate = await session.encryptMedia(group.id, plaintext, image.mime, filename);
      // Opaque bytes: the real type travels in the `imeta` tag.
      url = await uploadEncryptedBlobToBlossom(
        image.uri,
        await getBlossomServers(),
        signer,
        Buffer.from(candidate.encrypted).toString('base64'),
      );
      if ((await session.mediaEpoch(group.id)) === candidate.epoch) {
        sealed = candidate;
        break;
      }
    }
    // Never send media some members provably can't decrypt.
    if (!sealed)
      throw new Error(t(isVoice ? 'marmotSend.chatChangingVoice' : 'marmotSend.chatChangingPhoto'));
    const { attachment, keyHex } = sealed;
    const rumor = buildMarmotRumor(pubkey, {
      kind: MARMOT_CHAT_KIND,
      content: '',
      tags: [marmotImetaTag(attachment, url)],
    });
    const keys = { [attachment.ciphertextSha256]: { url, keysHex: [keyHex] } };
    await session.rememberMediaKeys(group.id, rumor.id, keys);
    const text = encodeMarmotMediaUrl({
      url,
      version: attachment.version,
      mime: attachment.mediaType,
      keysHex: [keyHex],
      nonceHex: attachment.nonce,
      filename,
      plaintextSha256: attachment.plaintextSha256,
      ciphertextSha256: attachment.ciphertextSha256,
    });
    const meta = { eventId: rumor.id, kind: MARMOT_IMAGE_ROW_KIND };
    hooks?.onRumorReady?.({ ...meta, relays: group.relays, text });
    const delivery = marmotDelivery(await session.sendRumor(group.id, rumor), meta);
    hooks?.onDeliveryFinalized?.(delivery);
    return delivery.delivered
      ? { success: true, delivery }
      : {
          success: false,
          delivery,
          error: t(isVoice ? 'marmotSend.noRelayAcceptedVoice' : 'marmotSend.noRelayAcceptedPhoto'),
        };
  } catch (e) {
    return marmotFailure(e);
  }
}
