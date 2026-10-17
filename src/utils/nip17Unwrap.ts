import { checkRemoteUrl, MEDIA_MAX_BYTES } from './remoteUrlPolicy';
import { nip44DecryptFrom, nostrGetEventHash } from '../services/nostrCrypto';
import type { RawGiftWrapEvent } from '../services/nostrService';
import { encodeEncryptedFileUrl } from './encryptedFileUrl';
import { parseOrderEvent, serializeOrder } from './orderEvents';
import { POLL_KIND, VOTE_KIND, serializePollFromRumor, serializeVoteFromRumor } from './nip88Poll';
import { liveMarkerTextForRumor } from '../services/liveLocationWire';
import { isChatReactionKind, serializeChatReactionRumor } from './nip17Reactions';

/**
 * Shape of a decoded NIP-17 message after two layers of NIP-44 decrypt.
 * Matches the kind-14 (chat) / kind-15 (file) rumor fields we read.
 */
export interface DecodedRumor {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  /** Kept when the inner event is a signed event, as a NIP-171 ticket is
   * (its signature is the members' invitation proof). Rumors are unsigned. */
  id?: string;
  sig?: string;
  /** The seal's single `invitation_proof` tag: a NIP-171 ticket's signature
   * travels there (Anagram), the ticket rumor itself stays unsigned. */
  sealInvitationProof?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Runtime-validate the parsed JSON of a kind-13 seal. Rejects missing or
 * mistyped fields that `as` casts would silently accept. The seal's kind
 * must be 13 per NIP-59 — we assert it up front so the caller can tell
 * "bad seal" apart from "right shape, wrong kind".
 */
function parseSeal(
  raw: string,
): { pubkey: string; content: string; kind: number; created_at: number; tags: string[][] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Record<string, unknown>;
  if (typeof s.pubkey !== 'string' || !HEX64.test(s.pubkey.toLowerCase())) return null;
  if (typeof s.content !== 'string') return null;
  if (typeof s.kind !== 'number') return null;
  if (typeof s.created_at !== 'number') return null;
  if (!Array.isArray(s.tags)) return null;
  if (!s.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) return null;
  return {
    pubkey: (s.pubkey as string).toLowerCase(),
    content: s.content as string,
    kind: s.kind as number,
    created_at: s.created_at as number,
    tags: s.tags as string[][],
  };
}

/**
 * Runtime-validate the parsed rumor payload. Unlike the seal, the rumor
 * is unsigned so we don't check a sig — we just require the shape we'll
 * actually read.
 */
function parseRumor(raw: string): DecodedRumor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.pubkey !== 'string' || !HEX64.test(r.pubkey.toLowerCase())) return null;
  if (typeof r.created_at !== 'number') return null;
  if (typeof r.kind !== 'number') return null;
  if (typeof r.content !== 'string') return null;
  if (!Array.isArray(r.tags)) return null;
  if (!r.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) return null;
  return {
    pubkey: (r.pubkey as string).toLowerCase(),
    created_at: r.created_at as number,
    kind: r.kind as number,
    content: r.content as string,
    tags: r.tags as string[][],
    ...(typeof r.id === 'string' && HEX64.test(r.id) ? { id: r.id } : {}),
    ...(typeof r.sig === 'string' && /^[0-9a-f]{128}$/.test(r.sig) ? { sig: r.sig } : {}),
  };
}

/**
 * Why we do NOT schnorr-verify the gift-wrap signature
 * ----------------------------------------------------
 * A NIP-59 gift wrap (kind 1059) is signed by a **throwaway ephemeral
 * key** the sender generates per-wrap — so the signature authenticates
 * *nothing* about who sent the message: anyone can mint a valid ephemeral
 * key and sign a wrap. The signature plays no part in NIP-17 security; the
 * two NIP-44 decrypts carry all of it.
 *
 * What the schnorr verify provided is supplied (better) by those decrypts:
 *   - **Integrity** ("not mutated in transit") — each NIP-44 layer carries
 *     an HMAC-SHA256 over the ciphertext; a tampered wrap fails the MAC
 *     and the decrypt throws (we skip it).
 *   - **Seal-key authentication** — the seal layer's conversation key is
 *     ECDH(viewerPriv, sealPubkey) = ECDH(senderPriv, viewerPub); only the
 *     holder of `sealPubkey`'s secret can produce a seal that decrypts, so
 *     a successful decrypt authenticates the *seal sender key*.
 *   - **Sender binding** — both unwrap paths then assert `rumor.pubkey ===
 *     seal.pubkey` (the shared `bindRumor` helper), so the message's claimed
 *     sender is exactly the key the seal ECDH just authenticated. Without it,
 *     a valid peer could embed a rumor attributing the message to a *different*
 *     pubkey (sender spoofing — gap #830, now closed on both paths).
 *
 * The wrap-sig `verifyEvent` was therefore pure defense-in-depth — and an
 * expensive one: a full schnorr verify (~25 ms/wrap) that dominated
 * cold-start inbox drain and froze the JS thread on a large backlog
 * (#802). Every failure mode it caught (mutated content / pubkey / id) is
 * *also* caught one step later by the cheaper MAC check, so dropping it
 * removes the freeze without weakening the security model.
 */

type Nip44Decrypt = (ciphertext: string, counterpartyPubkey: string) => Promise<string>;

/** A `skip` closure: logs the reason via the caller's `onSkip` and returns null. */
type Skip = (reason: string) => null;

/**
 * Parse a decrypted layer-1 payload and assert it's a kind-13 seal. Shared by
 * both unwrap paths so they validate the seal identically.
 */
function parseValidSeal(sealJson: string, skip: Skip) {
  const seal = parseSeal(sealJson);
  if (!seal) return skip('seal JSON malformed or wrong shape');
  if (seal.kind !== 13) return skip(`seal kind is ${seal.kind}, expected 13`);
  return seal;
}

/**
 * Parse a decrypted layer-2 payload into a rumor and enforce the NIP-17
 * requirement that the rumor's claimed `pubkey` equals `sealPubkey` — i.e.
 * the message's stated sender is exactly the key the seal ECDH authenticated.
 * Without this bind a valid peer could embed a rumor attributing the message
 * to a *different* pubkey (sender spoofing). Both unwrap paths call this one
 * implementation so they can't drift — the divergence that was gap #830.
 */
function bindRumor(
  rumorJson: string,
  seal: { pubkey: string; tags: string[][] },
  skip: Skip,
): DecodedRumor | null {
  const rumor = parseRumor(rumorJson);
  if (!rumor) return skip('rumor JSON malformed or wrong shape');
  if (rumor.pubkey !== seal.pubkey) {
    return skip(
      `rumor pubkey ${rumor.pubkey.slice(0, 8)}… != seal pubkey ${seal.pubkey.slice(0, 8)}…`,
    );
  }
  const proofs = seal.tags.filter((t) => t[0] === 'invitation_proof');
  if (proofs.length === 1 && /^[0-9a-f]{128}$/.test(proofs[0][1] ?? '')) {
    rumor.sealInvitationProof = proofs[0][1];
  }
  return rumor;
}

/** A NIP-46 bunker's refusal must reach the ingest loop: `ingestInboxWraps`
 *  stops on it (`stopOnPermissionDenied`) instead of re-asking the bunker for
 *  every wrap. Any other decrypt failure stays a skip, as before. */
function rethrowSignerDenial(error: unknown): void {
  if (/NIP-46 signer denied/i.test((error as Error)?.message ?? '')) throw error;
}

/**
 * Two-layer NIP-17 unwrap: wrap → seal → rumor. Takes a `decryptNip44`
 * callback so the same logic works for nsec (pure JS via nostr-tools) and
 * for Amber (IPC via amberService). The callback must throw on failure.
 *
 * Returns null on any verification / shape failure so callers can skip bad
 * wraps without crashing the inbox. Reasons for a null return are logged
 * through the injected `onSkip` hook. The one exception: a NIP-46 signer
 * denial is rethrown, so the ingest loop can stop instead of re-asking.
 */
export async function unwrapWrapViaNip44(
  wrap: RawGiftWrapEvent,
  decryptNip44: Nip44Decrypt,
  onSkip?: (reason: string, wrapId: string) => void,
): Promise<DecodedRumor | null> {
  const skip: Skip = (reason) => {
    onSkip?.(reason, wrap.id);
    return null;
  };

  // No wrap-sig verify — see the note above `Nip44Decrypt`. The MAC on each
  // decrypt rejects a tampered wrap; authenticity comes from the seal ECDH
  // plus the `bindRumor` `rumor.pubkey === seal.pubkey` check.
  let sealJson: string;
  try {
    sealJson = await decryptNip44(wrap.content, wrap.pubkey);
  } catch (error) {
    rethrowSignerDenial(error);
    return skip(`wrap decrypt failed: ${(error as Error)?.message ?? 'unknown'}`);
  }
  const seal = parseValidSeal(sealJson, skip);
  if (!seal) return null;

  let rumorJson: string;
  try {
    rumorJson = await decryptNip44(seal.content, seal.pubkey);
  } catch (error) {
    rethrowSignerDenial(error);
    return skip(`seal decrypt failed: ${(error as Error)?.message ?? 'unknown'}`);
  }
  return bindRumor(rumorJson, seal, skip);
}

/**
 * nsec path: the two NIP-44 decrypts run synchronously in-process via
 * nostr-tools' `nip44`. We do this manually (rather than nostr-tools'
 * `nip59.unwrapEvent`) so the seal is exposed and `bindRumor` can enforce
 * `rumor.pubkey === seal.pubkey` — the same sender-binding the Amber path
 * does. Routing through `unwrapEvent` (which hides the seal and skips that
 * bind) was gap #830; this is its fix.
 *
 * No wrap-sig verify first — see the note above `Nip44Decrypt`: the ephemeral
 * wrap key authenticates nothing, the NIP-44 MAC enforces integrity, and the
 * seal ECDH authenticates the seal sender key. Dropping it is the #802
 * cold-start freeze fix. `nip44.v2.decrypt` throws on a malformed or tampered
 * payload (MAC failure), which we catch and skip.
 *
 * Stays synchronous: all three callers (`useDmInbox`, `nostrLiveDmSub`,
 * `nostrFetchConversation`) invoke it inside tight, pacing-yielded loops and
 * do not await it.
 */
export function unwrapWrapNsec(
  wrap: RawGiftWrapEvent,
  secretKey: Uint8Array,
  onSkip?: (reason: string, wrapId: string) => void,
): DecodedRumor | null {
  const skip: Skip = (reason) => {
    onSkip?.(reason, wrap.id);
    return null;
  };

  // Layer 1: wrap.content → seal, keyed by the ephemeral wrap pubkey.
  let sealJson: string;
  try {
    sealJson = nip44DecryptFrom(wrap.content, secretKey, wrap.pubkey);
  } catch (error) {
    return skip(`wrap decrypt failed: ${(error as Error)?.message ?? 'unknown'}`);
  }
  const seal = parseValidSeal(sealJson, skip);
  if (!seal) return null;

  // Layer 2: seal.content → rumor, keyed by the seal (sender) pubkey.
  let rumorJson: string;
  try {
    rumorJson = nip44DecryptFrom(seal.content, secretKey, seal.pubkey);
  } catch (error) {
    return skip(`seal decrypt failed: ${(error as Error)?.message ?? 'unknown'}`);
  }
  return bindRumor(rumorJson, seal, skip);
}

/**
 * Given a decoded rumor and the viewer's own pubkey, returns who the
 * conversation's "partner" is, or null if malformed.
 *
 *  - If `rumor.pubkey === viewerPubkey` the user sent the message
 *    themselves (outgoing; partner comes from the first `p` tag).
 *  - Otherwise the sender is the partner (incoming).
 *
 * Returned pubkey is already lowercased.
 */
export function partnerFromRumor(
  rumor: DecodedRumor,
  viewerPubkey: string,
): { partnerPubkey: string; fromMe: boolean } | null {
  const me = viewerPubkey.toLowerCase();
  if (rumor.pubkey === me) {
    // The first `p` that isn't us; a lone self `p` is a note to self. A
    // reaction to our own message tags us (the target's author) before the
    // peer (#1319), so the first `p` alone would misfile it.
    const pTags = rumor.tags
      .filter((t) => t[0] === 'p' && typeof t[1] === 'string')
      .map((t) => t[1].toLowerCase());
    const pTag = pTags.find((p) => p !== me) ?? pTags[0];
    if (!pTag || !HEX64.test(pTag)) return null;
    return { partnerPubkey: pTag, fromMe: true };
  }
  // Incoming: the sender IS the partner. Validate + lowercase exactly like the
  // fromMe branch above — without this, a rumor whose inner author field is
  // malformed or mixed-case leaked a junk partner key into the 1:1 inbox,
  // which npubEncode then threw on, surfacing as un-nameable raw-hex rows
  // (`dcc…`, `dd2…`). HEX64 already gates the wrap/seal pubkeys on unwrap, so a
  // bad rumor.pubkey here is genuine garbage — return null to skip it (#849).
  const sender = rumor.pubkey.toLowerCase();
  if (!HEX64.test(sender)) return null;
  return { partnerPubkey: sender, fromMe: false };
}

/**
 * Extract the value of the rumor's `subject` tag (NIP-14 / NIP-17 spec
 * "the current name/topic of the conversation"), or null if absent /
 * empty / non-string. Trimmed; subjects that whitespace-collapse to
 * empty are returned as null so callers can use `?? fallback` cleanly.
 *
 * Used by the spec-aligned group-routing fallback: when a kind-14
 * arrives from a foreign client (Amethyst, 0xchat) that doesn't know
 * about LP's kind-30200 group-state event, the `subject` is the only
 * source of truth for the conversation's name.
 */
/**
 * Stable NIP-17 rumor event id (#857) — the hash of the unwrapped inner event.
 * Identical to what the SENDER computed at send time (same rumor fields), and
 * the same across the recipient + self wraps, so it keys the delivery-status
 * store: a sent bubble's tick keyed by this survives the optimistic local- →
 * relay-echo row swap. NOT the outer wrap id (which is random per ephemeral
 * key). A `DecodedRumor` is an UnsignedEvent for hashing purposes.
 */
export function rumorEventId(rumor: DecodedRumor): string {
  return nostrGetEventHash(rumor);
}

export function subjectFromRumor(rumor: DecodedRumor): string | null {
  for (const t of rumor.tags) {
    if (t[0] !== 'subject') continue;
    const v = t[1];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return null;
}

/**
 * Extract the full set of pubkeys participating in a kind-14 rumor.
 * Includes the sender (`rumor.pubkey`) plus every well-formed `p` tag
 * value, lowercased and deduplicated.
 *
 * Used by the group-routing path: a kind-14 rumor with two-or-more
 * pubkeys-other-than-the-viewer is a group message — we match the
 * resulting set against the locally-known group rosters.
 */
export function participantsFromRumor(rumor: DecodedRumor): Set<string> {
  const set = new Set<string>();
  if (HEX64.test(rumor.pubkey)) set.add(rumor.pubkey.toLowerCase());
  for (const tag of rumor.tags) {
    if (tag[0] !== 'p') continue;
    const v = tag[1]?.toLowerCase();
    if (v && HEX64.test(v)) set.add(v);
  }
  return set;
}

/**
 * File metadata parsed from a NIP-17 kind-15 file-message rumor (#235).
 * The blob at `url` is AES-256-GCM ciphertext; `keyHex`/`nonceHex` decrypt
 * it, `mime` is the original (decrypted) content type.
 */
export interface ConversationFileMeta {
  dim?: string;
  url: string;
  mime: string;
  algorithm: string;
  filename?: string;
  keyHex: string;
  nonceHex: string;
  sha256?: string;
  size?: number;
}

/**
 * Extract file metadata from a kind-15 rumor's tags + content. Returns
 * undefined for non-kind-15 rumors, or kind-15 rumors missing the fields
 * we need to fetch + decrypt (url / key / nonce) — callers then fall back
 * to rendering the rumor as plain text.
 */
export function fileMetaFromRumor(rumor: DecodedRumor): ConversationFileMeta | undefined {
  if (rumor.kind !== 15) return undefined;
  const tag = (name: string): string | undefined => rumor.tags.find((t) => t[0] === name)?.[1];
  // NIP-17 kind 15 puts the file URL in `content`; tolerate a `url` tag too.
  const url = rumor.content?.trim() || tag('url');
  const keyHex = tag('decryption-key');
  const nonceHex = tag('decryption-nonce');
  if (!url || !checkRemoteUrl(url, { kind: 'media' }).ok || !keyHex || !nonceHex) return undefined;
  const sizeRaw = tag('size');
  const size = sizeRaw && /^\d+$/.test(sizeRaw) ? Number(sizeRaw) : undefined;
  if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0 || size > MEDIA_MAX_BYTES))
    return undefined;
  return {
    url,
    filename: tag('filename')?.slice(0, 255),
    dim:
      tag('dim') ??
      rumor.tags
        .find((t) => t[0] === 'imeta')
        ?.find((v) => v.startsWith('dim '))
        ?.slice(4),
    mime: tag('file-type') ?? 'application/octet-stream',
    algorithm: tag('encryption-algorithm') ?? 'aes-gcm',
    keyHex,
    nonceHex,
    sha256: tag('x'),
    size,
  };
}

/**
 * Inbox/display text for a decoded rumor (#235). A kind-15 encrypted file
 * message (voice note) is stored as its `#lpe=…` encoded URL so
 * MessageBubble → VoiceNotePlayer can render + decrypt it; every other
 * rumor keeps its plaintext content. Shared by all the DM receive paths
 * (live sub, fetch-conversation, inbox refresh) so they classify kind-15
 * identically.
 */
export function textForRumor(rumor: DecodedRumor): string {
  // A tagged live-location start / end marker (#1300): its readable body is
  // for other clients; store the internal marker text the bubble renders.
  const liveMarker = liveMarkerTextForRumor(rumor);
  if (liveMarker) return liveMarker;
  // Marketplace order / receipt rumor (kind 16/17) — should markets ever
  // gift-wrap these (they're plaintext today), store the canonical order JSON
  // so the conversation renderer shows the same order card the plaintext path
  // produces (#market future-proofing).
  if (rumor.kind === 16 || rumor.kind === 17) {
    const order = parseOrderEvent(rumor);
    if (order) return serializeOrder(order);
  }
  // Structured NIP-88 poll (kind 1068) / vote (kind 1018) gift-wrapped in a DM
  // (#203). Persist the canonical JSON so the thread renderer + tally rebuild
  // the poll card + counts from the stored row — the poll id embedded here is
  // the rumor event id, deterministic across sender + every recipient. Falls
  // through to `rumor.content` when the event isn't a well-formed poll/vote.
  if (rumor.kind === POLL_KIND) {
    const poll = serializePollFromRumor(rumor);
    if (poll) return poll;
  }
  if (rumor.kind === VOTE_KIND) {
    const vote = serializeVoteFromRumor(rumor);
    if (vote) return vote;
  }
  // Wrapped reaction / retraction (#1321): keep the tags that name its target.
  if (isChatReactionKind(rumor.kind)) return serializeChatReactionRumor(rumor);
  const meta = fileMetaFromRumor(rumor);
  // All supported AES-GCM files use the shared attachment cache and renderer.
  if (meta && meta.algorithm === 'aes-gcm') {
    return encodeEncryptedFileUrl(meta);
  }
  return rumor.content;
}

/**
 * Classify a kind-14 rumor as either a 1:1 DM or a group message.
 * Returns null if the rumor is malformed (e.g. no resolvable partner).
 *
 *  - DM: one OTHER participant and no valid, nonempty subject, even when a
 *    named group with the same membership exists (app routing policy).
 *  - Group: a valid, nonempty subject or two or more OTHER participants. Caller looks
 *    up the room by its participant set; changing the subject renames it.
 *
 * `fromMe` reflects whether the viewer is the sender. The set of
 * `otherParticipants` always EXCLUDES the viewer.
 */
export function classifyRumor(
  rumor: DecodedRumor,
  viewerPubkey: string,
):
  | { type: 'dm'; partnerPubkey: string; fromMe: boolean }
  | { type: 'group'; otherParticipants: Set<string>; fromMe: boolean }
  | { type: 'order'; partnerPubkey: string; fromMe: boolean }
  | null {
  // Marketplace order / receipt (kind 16/17) that actually parses as an order.
  // Surfaced as its own variant so an unwrapped order routes to the order-card
  // rendering rather than a chat DM — the partner is the market (sender), or the
  // `p` recipient when we sent it (#market future-proofing). Only genuine orders
  // take this branch: a kind-16 NIP-18 repost (or other kind-16/17 use) is not
  // an order, so it falls through to the normal dm/group classification below.
  // Callers that only act on 'group' (e.g. group routing) safely fall through to
  // the 1:1 store path, which keys the order card off `wireKind`.
  if ((rumor.kind === 16 || rumor.kind === 17) && parseOrderEvent(rumor)) {
    const partnership = partnerFromRumor(rumor, viewerPubkey);
    if (partnership) {
      return {
        type: 'order',
        partnerPubkey: partnership.partnerPubkey,
        fromMe: partnership.fromMe,
      };
    }
  }
  const me = viewerPubkey.toLowerCase();
  const all = participantsFromRumor(rumor);
  if (all.size === 0) return null;
  const others = new Set<string>(all);
  others.delete(me);
  const fromMe = rumor.pubkey.toLowerCase() === me;
  if (others.size === 0) {
    // Self-talk wraps shouldn't happen in practice — bail rather than
    // miscategorise as a DM with `partnerPubkey === me`.
    return null;
  }
  if (others.size === 1 && !subjectFromRumor(rumor)) {
    const partnerPubkey = Array.from(others)[0];
    return { type: 'dm', partnerPubkey, fromMe };
  }
  return { type: 'group', otherParticipants: others, fromMe };
}
