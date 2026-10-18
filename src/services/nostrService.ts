import { enabledAppRelays } from './appRelayPrefs';
import { fetchSingleLatest } from './nostrLatestQuery';
import {
  generateSecretKey,
  getPublicKey,
  validateEvent,
  type Event as NostrEvent,
  type VerifiedEvent,
} from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { querySyncAbortable } from './relayQuery';
import { DM_INBOX_LIMIT, KIND4_REPLAY_OVERLAP_SECONDS } from './dmInboxFetchPolicy';
import { fetchProfilesBatch } from './nostrProfileBatch';
import { pool, connectedRelays, trackRelays } from './nostrPool';
import { DEFAULT_RELAYS, PROFILE_RELAYS } from './nostrRelayDefaults';
import * as nip19 from 'nostr-tools/nip19';
import * as nip04 from 'nostr-tools/nip04';
import { nostrFinalizeEvent } from './nostrCrypto';
import * as nip59 from 'nostr-tools/nip59';
import type { NostrProfile, NostrContact, RelayConfig } from '../types/nostr';
import { slimDisplayProfile } from '../utils/profileSanitize';
import { fetchFollowSnapshot } from './contactFollowFreshness';
import type { DmSendResult } from './nostrDmPublish';
import { LP_CLIENT_TAG } from './nip89ClientTag';
import {
  __resetVerifiedEventCache,
  __verifiedEventCacheSize,
  verifyEventCached,
} from './nostrVerifyCache';
import { parseProfileContent } from '../utils/profileContent';

export type { DmSendResult };
export { sendNip17ToManyWithNsec, sendNip17ToManyWithSigner } from './nostrNip17Send';
// Re-exported for back-compat: the canonical home is ./nip89ClientTag.
export { LP_CLIENT_TAG };

// The shared connection pool + relay tracker live in `./nostrPool` (a
// dependency-free module, so `nostrProfileBatch` and other services can share
// the singleton without an import cycle back to this file). Re-exported here
// for back-compat with the many existing `import { pool, trackRelays } from
// './nostrService'` call sites. This module owns the custom `verifyEvent`
// fast-path applied to that same instance below.
export { pool, trackRelays };
export { signAndPublishEvent, publishSignedEvent } from './nostrEventPublish';

// Fast-path verification for kind-0 (profile / metadata) events.
// `SimplePool` runs `verifyEvent` synchronously for every event before
// dispatching `onevent` — a full secp256k1 schnorr check (~25 ms each in
// Hermes), so a cold-start burst of 150+ profile events from a
// `fetchProfiles` query froze the JS thread for ~6 s (issue #526). For
// kind 0 we keep only the cheap structural check (`validateEvent`) and
// skip schnorr. Trade-off: a kind-0 from this path is NOT signature-
// verified — a malicious relay could forge any field, including the
// `lud16` lightning address, which would silently redirect a zap. That
// is safe ONLY because both consumers compensate: `fetchProfiles` (batch)
// runs every result through `slimDisplayProfile` to strip `lud16`, and
// `fetchProfile` (single) re-runs full `verifyEvent` itself before its
// `lud16` can feed a payment. Every other kind keeps full `verifyEvent`.
//
// Verified-event-id cache: see `./nostrVerifyCache` (shared with services
// that verify lazily, e.g. the market listings snapshot).
export { __resetVerifiedEventCache, __verifiedEventCacheSize };

// Non-financial event kinds where a malicious relay can at worst show
// stale / fake content — there's no LNURL or wallet-relevant data inside
// the event, so a forged one doesn't move funds. For these we skip
// schnorr and run only the cheap structural validate.
//
// - 37516 NIP-GC cache listing: the LNURL bearer lives on the NFC tag,
//   never on the Nostr event (see `feedback_lnurl_never_on_relays` in
//   the buildCacheListing comment). Worst case: a fake cache appears
//   on the map. Finder still has to scan a real tag to claim.
// - 31923 NIP-52 time-based event: meetup metadata. A fake "Bitcoin
//   meetup tonight" wastes the user's time, costs no money.
// - 1059 NIP-59 gift-wrap: the outer wrap uses an ephemeral one-time
//   key whose pubkey is never published anywhere — schnorr verification
//   would pass for ANY key, so the check provides no integrity signal.
//   The real integrity comes from the seal/rumor layer inside (unwrapped
//   with our secret key in `unwrapGiftWrap`). Saving ~1–5 ms × N per
//   cold-start inbox burst. `validateEvent()` (JSON structure) still runs.
// Other kinds keep the full schnorr — DMs (4 / 14), reactions, zap
// requests/receipts, comment kinds (1111), found logs (7516), etc.
const SKIP_VERIFY_KINDS = new Set<number>([37516, 31923, 1059]);

pool.verifyEvent = ((event: NostrEvent): event is VerifiedEvent => {
  // Structural check only for the kinds above. Their ids are NOT added to
  // the verified cache — only a full schnorr pass may vouch for an id.
  if (event.kind === 0 || SKIP_VERIFY_KINDS.has(event.kind)) return validateEvent(event);
  return verifyEventCached(event);
}) as typeof pool.verifyEvent;

export {
  setCurrentUserPubkey,
  getCurrentUserPubkey,
  setCurrentUserReadRelays,
  getCurrentUserReadRelays,
  onCurrentUserPubkeyChange,
} from './nostrActiveAccount';
// The built-in relay lists live in `./nostrRelayDefaults` (audited there,
// guarded by its test). Re-exported for the many existing call sites.
export { DEFAULT_RELAYS };

export function decodeNsec(nsec: string): { pubkey: string; secretKey: Uint8Array } {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Invalid nsec format');
  }
  const secretKey = decoded.data;
  const pubkey = getPublicKey(secretKey);
  return { pubkey, secretKey };
}

export function npubEncode(hex: string): string {
  return nip19.npubEncode(hex);
}

export function nprofileEncode(pubkey: string, relays: string[] = []): string {
  return nip19.nprofileEncode({ pubkey, relays });
}

// Best-effort relay hints to embed in an outgoing nprofile. Prefers the
// contact's own kind-3 relay (where the user's follow entry suggests they
// publish), falls back to the viewer's NIP-65 read relays (the places we
// already trust for profile fetches), and finally to a small default slice
// so the nprofile never carries zero hints — an empty hint list defeats
// the purpose of nprofile vs. npub. Dedupes and caps at 3 to keep URIs
// compact; receiving clients still search their own relays on top.
export function buildProfileRelayHints(
  targetPubkey: string,
  viewerContacts: { pubkey: string; relay: string | null }[],
  viewerReadRelays: string[],
): string[] {
  const hints: string[] = [];
  const contactRelay = viewerContacts.find((c) => c.pubkey === targetPubkey)?.relay;
  if (contactRelay) hints.push(contactRelay);
  for (const r of viewerReadRelays) hints.push(r);
  for (const r of enabledAppRelays('default', DEFAULT_RELAYS)) hints.push(r);
  const deduped: string[] = [];
  for (const r of hints) {
    if (!r) continue;
    if (deduped.includes(r)) continue;
    deduped.push(r);
    if (deduped.length >= 3) break;
  }
  return deduped;
}

// Relay hints to embed in the user's OWN nprofile when sharing it to an
// NFC tag / QR for first contact (#755). A conference badge is a cold
// first-contact medium: the scanner doesn't follow us yet, so the hints
// must point at our NIP-65 *write* (outbox) relays — the places we
// actually publish kind-0 + notes — so their client resolves us even on
// niche relays. Capped at `max` (default 2) to keep the payload inside an
// NTAG213's ~144 B and limit staleness if we later migrate relays. Falls
// back to the app defaults when the user has published no write relays,
// since a hint (even a generic one) still beats a bare npub. The bare
// pubkey is always in the nprofile, so a reader can fall back to outbox
// discovery if these hints go dead.
export function buildOwnProfileRelayHints(ownWriteRelays: string[], max = 2): string[] {
  const deduped: string[] = [];
  for (const r of [...ownWriteRelays, ...enabledAppRelays('default', DEFAULT_RELAYS)]) {
    if (!r) continue;
    if (deduped.includes(r)) continue;
    deduped.push(r);
    if (deduped.length >= max) break;
  }
  return deduped;
}

export { decodeProfileReference, type DecodedProfileReference } from '../utils/profileReference';

// Kind-0 parsing lives in utils/profileContent (pure); re-exported for importers.
export { parseProfileContent };

export async function fetchProfile(pubkey: string, relays: string[]): Promise<NostrProfile | null> {
  const allRelays = [...new Set([...relays, ...PROFILE_RELAYS])];
  trackRelays(allRelays);
  try {
    const event = await pool.get(allRelays, {
      kinds: [0],
      authors: [pubkey],
    });
    if (!event) return null;
    // `pool.verifyEvent` fast-paths kind-0 (skips schnorr) — but this single
    // fetch feeds payment destinations (`lud16`), so verify it for real here.
    if (!verifyEventCached(event)) {
      console.warn('Nostr profile failed signature verification, ignoring:', pubkey);
      return null;
    }

    const parsed = parseProfileContent(event.content);
    return {
      pubkey,
      npub: npubEncode(pubkey),
      ...parsed,
    };
  } catch (error) {
    console.warn('Failed to fetch Nostr profile:', error);
    return null;
  }
}

function tagsToRelayList(tags: string[][]): RelayConfig[] {
  return tags
    .filter((tag) => tag[0] === 'r')
    .map((tag) => {
      const url = tag[1];
      const marker = tag[2];
      return {
        url,
        read: !marker || marker === 'read',
        write: !marker || marker === 'write',
      };
    });
}

// Back-compatible export; per-relay EOSE cleanup lives in the query helper.
export { fetchSingleLatest } from './nostrLatestQuery';

export async function fetchContactList(
  pubkey: string,
  relays: string[],
): Promise<NostrContact[] | null> {
  try {
    return (await fetchFollowSnapshot(pubkey, relays))?.contacts ?? null;
  } catch (error) {
    console.warn('Failed to fetch Nostr contact list:', error);
    return null;
  }
}

export async function fetchRelayList(
  pubkey: string,
  relays: string[],
  opts?: { onLatest?: (relayList: RelayConfig[]) => void },
): Promise<RelayConfig[] | null> {
  try {
    return await fetchSingleLatest<RelayConfig[]>(
      { kinds: [10002], authors: [pubkey] } as Filter,
      relays,
      tagsToRelayList,
      { onLatest: opts?.onLatest },
    );
  } catch (error) {
    console.warn('Failed to fetch NIP-65 relay list:', error);
    return null;
  }
}

/** Like fetchRelayList, but also returns the event's created_at so callers
 * can refuse a copy older than the list they already hold. */
export async function fetchRelayListEvent(
  pubkey: string,
  relays: string[],
): Promise<{ list: RelayConfig[]; createdAt: number } | null> {
  try {
    return await fetchSingleLatest(
      { kinds: [10002], authors: [pubkey] } as Filter,
      relays,
      (tags, createdAt) => ({ list: tagsToRelayList(tags), createdAt }),
    );
  } catch (error) {
    console.warn('Failed to fetch NIP-65 relay list:', error);
    return null;
  }
}

export async function fetchProfiles(
  pubkeys: string[],
  relays: string[],
  onBatch?: (profiles: Map<string, NostrProfile>) => void,
): Promise<Map<string, NostrProfile>> {
  const profiles = new Map<string, NostrProfile>();
  if (pubkeys.length === 0) return profiles;

  // Include profile aggregator relays for better coverage
  const allRelays = [...new Set([...relays, ...PROFILE_RELAYS])];

  // Surface incrementally via the caller's onBatch hook. Coalesce sub
  // events that arrive in tight bursts so we don't trigger 100s of
  // setContacts re-renders — 500 ms is far enough apart that a typical
  // bottom-sheet open animation (~250-350 ms) doesn't get re-rendered
  // mid-slide, but close enough to still feel live to the user. PR #385
  // originally used 200 ms which caused a visible regression in
  // FriendPicker open jank (1.49 % → 10.16 %); this is the simpler
  // alternative to PR #386's InteractionManager defer.
  // The pending timer is tracked so the per-round flush below can clear
  // it (otherwise the flush + a still-pending coalesced fire would
  // double-emit the same snapshot a few hundred ms apart).
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleEmit = (): void => {
    if (!onBatch || pendingTimer !== null) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      onBatch(new Map(profiles));
    }, 500);
  };
  const flushNow = (): void => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (onBatch) onBatch(new Map(profiles));
  };

  const ingest = (event: { pubkey: string; content: string; created_at: number }): void => {
    const parsed = parseProfileContent(event.content);
    // Batch-fetched kind-0 events skip schnorr verification (see the
    // pool.verifyEvent fast-path) — strip payment-relevant fields so a
    // forged relay reply can't redirect a zap. Display-only path.
    profiles.set(
      event.pubkey,
      slimDisplayProfile({
        pubkey: event.pubkey,
        npub: npubEncode(event.pubkey),
        ...parsed,
      }),
    );
    scheduleEmit();
  };

  try {
    // Overall deadline cap. The streaming sub already times out per
    // batch; this is the upper bound for the whole multi-batch run.
    const overallDeadline = Date.now() + 120000;

    // Merge the former three parallel 50-author REQs into one bounded
    // authors[] request (#1399). Stream the same 150-author round through
    // one relay slot, retaining the timeout and newest-profile guards.
    const batchSize = 150;
    const concurrency = 1;
    const batches: string[][] = [];
    for (let i = 0; i < pubkeys.length; i += batchSize) {
      batches.push(pubkeys.slice(i, i + batchSize));
    }

    for (let i = 0; i < batches.length; i += concurrency) {
      if (Date.now() > overallDeadline) {
        if (__DEV__) console.warn('[Nostr] fetchProfiles: overall timeout reached');
        break;
      }
      // Yield 50 ms between rounds so React can process renders + user input.
      if (i > 0) await new Promise((r) => setTimeout(r, 50));
      const concurrent = batches.slice(i, i + concurrency);
      await Promise.all(
        concurrent.map((batch) => fetchProfilesBatch(batch, allRelays, 10000, ingest)),
      );
      flushNow();
    }

    // Retry pass for missing profiles. 8s timeout — slow relays that
    // missed the first round window may still produce on a second look,
    // and the cost of cache-missing a profile for 24h is much higher
    // than 8s of additional sub time on cold start.
    const missing = pubkeys.filter((pk) => !profiles.has(pk));
    if (missing.length > 0 && missing.length < pubkeys.length && Date.now() < overallDeadline) {
      if (__DEV__)
        console.log(`[Nostr] fetchProfiles: retrying ${missing.length} missing profiles`);
      // Same 150-author batches as the main pass: one relay slot per round
      // without turning 300 misses into fifteen sequential 8 s rounds.
      const retryBatches: string[][] = [];
      for (let i = 0; i < missing.length; i += batchSize) {
        retryBatches.push(missing.slice(i, i + batchSize));
      }
      for (let i = 0; i < retryBatches.length; i += concurrency) {
        if (Date.now() > overallDeadline) break;
        const concurrent = retryBatches.slice(i, i + concurrency);
        await Promise.all(
          concurrent.map((batch) => fetchProfilesBatch(batch, allRelays, 8000, ingest)),
        );
        flushNow();
      }
    }
  } catch (error) {
    console.warn('Failed to batch fetch profiles:', error);
  } finally {
    // Make sure we don't leave a pending coalesce timer alive after the
    // function resolves — the caller has the final state in the return
    // value, so a late fire would just be a duplicate emit.
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  return profiles;
}

/**
 * Parse a NIP-57 zap receipt (kind 9735) to extract the sender pubkey and the
 * comment they typed when zapping. The receipt's `description` tag carries
 * the stringified kind 9734 zap request event; the sender's pubkey is the
 * `pubkey` field of that inner event, unless the zap request was marked
 * anonymous via `['anon', ...]`.
 */
export function parseZapReceipt(event: { tags: string[][] }): {
  senderPubkey: string | null;
  comment: string;
  anonymous: boolean;
} | null {
  const descTag = event.tags.find((t) => t[0] === 'description');
  if (!descTag || !descTag[1]) return null;
  try {
    const zapRequest = JSON.parse(descTag[1]) as {
      pubkey?: string;
      content?: string;
      tags?: string[][];
    };
    const anonymous = Array.isArray(zapRequest.tags)
      ? zapRequest.tags.some((t) => t[0] === 'anon')
      : false;
    return {
      senderPubkey: anonymous ? null : zapRequest.pubkey || null,
      comment: typeof zapRequest.content === 'string' ? zapRequest.content : '',
      anonymous,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch NIP-57 zap receipts (kind 9735) addressed to `recipientPubkey`.
 *
 * We can't use `#bolt11` here — damus, primal and most mainstream relays
 * reject tag filters they haven't indexed (they respond with
 * `NOTICE: bad req: unindexed tag filter`). `#p` is always indexed, so we
 * fetch a bounded slice of receipts for the wallet owner and let the caller
 * match individual bolt11 invoices locally against the returned events.
 */
export async function fetchZapReceiptsForRecipient(
  recipientPubkeys: string | string[],
  relays: string[],
  options: { limit?: number; since?: number } = {},
): Promise<{ tags: string[][]; created_at: number; id: string }[]> {
  return fetchZapReceiptsByTag('#p', recipientPubkeys, relays, options);
}

/**
 * Fetch kind-9735 zap receipts where the SENDER pubkey matches one of
 * the given pubkeys (via the optional uppercase `P` tag per NIP-57).
 *
 * Used for cross-device attribution of outgoing zaps: when a zap was
 * sent from a different device, local storage has no entry for it. If
 * the recipient's LNURL server included `['P', <sender_pubkey>]` in
 * the receipt we can still resolve the recipient by querying relays.
 *
 * Servers MAY omit the `P` tag (NIP-57 marks it optional), so this is
 * a best-effort fallback, not a replacement for the local-storage path.
 */
export async function fetchZapReceiptsForSender(
  senderPubkeys: string | string[],
  relays: string[],
  options: { limit?: number; since?: number } = {},
): Promise<{ tags: string[][]; created_at: number; id: string }[]> {
  return fetchZapReceiptsByTag('#P', senderPubkeys, relays, options);
}

async function fetchZapReceiptsByTag(
  tag: '#p' | '#P',
  pubkeys: string | string[],
  relays: string[],
  options: { limit?: number; since?: number } = {},
): Promise<{ tags: string[][]; created_at: number; id: string }[]> {
  const arr = Array.isArray(pubkeys) ? pubkeys : [pubkeys];
  const deduped = [...new Set(arr.filter(Boolean))];
  if (deduped.length === 0) return [];
  const allRelays = [...new Set([...relays, ...enabledAppRelays('default', DEFAULT_RELAYS)])];
  trackRelays(allRelays);
  const baseFilter = {
    kinds: [9735],
    limit: options.limit ?? 500,
    ...(options.since ? { since: options.since } : {}),
  };
  // The `tag` parameter is a literal '#p' or '#P' — cast to the nostr-tools
  // filter type which expects `#<letter>` index signatures.
  const filter = { ...baseFilter, [tag]: deduped } as Parameters<typeof pool.querySync>[1];
  try {
    // maxWait: per-relay EOSE timeout — closes the sub at 15 s if EOSE never
    // arrives (unlike withTimeout, which only raced the Promise and left the sub open).
    const events = await pool.querySync(allRelays, filter, { maxWait: 15000 });
    const byId = new Map<string, { tags: string[][]; created_at: number; id: string }>();
    for (const e of events) byId.set(e.id, e);
    return Array.from(byId.values());
  } catch (error) {
    if (__DEV__) console.warn(`[Nostr] fetchZapReceiptsByTag ${tag} failed:`, error);
    return [];
  }
}

export function createZapRequestEvent(
  senderPubkey: string,
  recipientPubkey: string,
  amountMsats: number,
  relays: string[],
  content: string,
  // Optional event id to zap. NIP-57 says the `e` tag MAY appear on a
  // 9734 to scope the zap to one note; LNURL servers copy it through
  // to the 9735 receipt's `e` tag so clients can aggregate zaps on
  // that note (see `findLogZapsService` for the consumer side).
  zapEventId?: string,
): { kind: number; created_at: number; tags: string[][]; content: string; pubkey: string } {
  const tags: string[][] = [
    [...LP_CLIENT_TAG],
    ['p', recipientPubkey],
    ['amount', amountMsats.toString()],
    ['relays', ...relays],
  ];
  if (zapEventId) tags.push(['e', zapEventId]);
  return {
    kind: 9734,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: senderPubkey,
    tags,
    content,
  };
}

export function signEvent(
  event: { kind: number; created_at: number; tags: string[][]; content: string },
  secretKey: Uint8Array,
) {
  return nostrFinalizeEvent(event, secretKey);
}

export function createContactListEvent(
  contacts: { pubkey: string; relay: string | null; petname: string | null }[],
): { kind: number; created_at: number; tags: string[][]; content: string } {
  const tags = contacts.map((c) => {
    const tag = ['p', c.pubkey];
    tag.push(c.relay || '');
    tag.push(c.petname || '');
    return tag;
  });
  return {
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    tags: [[...LP_CLIENT_TAG], ...tags],
    content: '',
  };
}

export function createProfileEvent(profileData: {
  name?: string;
  display_name?: string;
  picture?: string;
  banner?: string;
  about?: string;
  lud16?: string;
  nip05?: string;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  // Remove undefined/empty values
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(profileData)) {
    if (value) cleaned[key] = value;
  }
  return {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [[...LP_CLIENT_TAG]],
    content: JSON.stringify(cleaned),
  };
}

/**
 * Build the inner kind-14 chat rumor for a 1:1 NIP-17 direct message.
 * Mirrors `createGroupChatRumor` but with no `subject` tag and exactly
 * one `p` tag (the recipient). Per NIP-17, both DMs and group chats use
 * kind-14 — the only thing that distinguishes them is the participant
 * count, which receivers infer from the `p` tag set (see
 * `classifyRumor` in `utils/nip17Unwrap.ts`).
 *
 * The returned event is unsigned ("rumor"); pass it to
 * `sendNip17ToManyWithNsec` / `sendNip17ToManyWithSigner` which seal +
 * gift-wrap it per recipient (and once for the sender, so other devices
 * see their own outgoing message).
 */
export function createDirectMessageRumor(input: {
  senderPubkey: string;
  recipientPubkey: string;
  content: string;
}): { kind: number; created_at: number; tags: string[][]; content: string; pubkey: string } {
  return {
    pubkey: input.senderPubkey,
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', input.recipientPubkey]],
    content: input.content,
  };
}

export interface RawDmEvent {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Fetch NIP-4 encrypted DMs (kind 4) exchanged between `myPubkey` and
 * `otherPubkey`, in either direction. Returns raw events — decryption
 * happens in the context layer where the signer (nsec / Amber) lives.
 *
 * Uses two parallel filters: messages authored by me tagged to the other,
 * and messages authored by the other tagged to me. Most relays index
 * `#p`, so this pair covers both conversation halves.
 */
export async function fetchDirectMessageEvents(
  myPubkey: string,
  otherPubkey: string,
  relays: string[],
  options: { limit?: number; since?: number } = {},
): Promise<RawDmEvent[]> {
  const allRelays = [...new Set([...relays, ...enabledAppRelays('default', DEFAULT_RELAYS)])];
  trackRelays(allRelays);
  const limit = options.limit ?? 200;
  // Damus's trick (SubscriptionManager.swift:293-300): pad `since` back
  // by 2 minutes so relays with slightly-off clocks still return the
  // last few events we might have missed on the previous fetch. On
  // first fetch (no cached last-seen) the caller passes undefined, so
  // the filter has no `since` and the relay returns full history.
  const since =
    options.since !== undefined
      ? Math.max(0, options.since - KIND4_REPLAY_OVERLAP_SECONDS)
      : undefined;
  const fromMeFilter: Filter = {
    kinds: [4],
    authors: [myPubkey],
    '#p': [otherPubkey],
    limit,
  };
  const toMeFilter: Filter = {
    kinds: [4],
    authors: [otherPubkey],
    '#p': [myPubkey],
    limit,
  };
  if (since !== undefined) {
    fromMeFilter.since = since;
    toMeFilter.since = since;
  }
  try {
    // maxWait closes the sub at 15 s if EOSE never arrives (proper teardown vs withTimeout race).
    const [fromMe, toMe] = await Promise.all([
      pool.querySync(allRelays, fromMeFilter, { maxWait: 15000 }),
      pool.querySync(allRelays, toMeFilter, { maxWait: 15000 }),
    ]);
    const byId = new Map<string, RawDmEvent>();
    for (const ev of fromMe) byId.set(ev.id, ev as RawDmEvent);
    for (const ev of toMe) byId.set(ev.id, ev as RawDmEvent);
    return Array.from(byId.values());
  } catch (error) {
    if (__DEV__) console.warn('[Nostr] fetchDirectMessageEvents failed:', error);
    return [];
  }
}

export interface RawGiftWrapEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface FetchedInboxEvents {
  kind4: RawDmEvent[];
  kind1059: RawGiftWrapEvent[];
}

/**
 * Fetch every DM event that could end up in the current user's inbox:
 * legacy NIP-04 kind-4 events in either direction, plus NIP-17 gift wraps
 * (kind 1059) addressed to them. Returned events are raw — the caller
 * decrypts/unwraps in the context layer where the signer lives.
 *
 * Three parallel filters: `authors=me` covers outgoing kind-4 (which tag
 * the recipient, not me); `#p=me` covers incoming kind-4 and NIP-17 wraps
 * (which always tag the recipient — including self-wraps of the sender's
 * own copy). This matches Damus's twin kind-4 strategy and layers NIP-17
 * on top.
 */
export async function fetchInboxDmEvents(
  myPubkey: string,
  relays: string[],
  options: { limit?: number; since?: number; signal?: AbortSignal } = {},
): Promise<FetchedInboxEvents> {
  const allRelays = [...new Set([...relays, ...enabledAppRelays('default', DEFAULT_RELAYS)])];
  trackRelays(allRelays);
  // Share the live-sub limit and retry-store capacity policy (#383).
  const limit = options.limit ?? DM_INBOX_LIMIT;
  // `since` shifted back 2 min (Damus clock-drift pad). Applied only to kind-4 filters below; wraps deliberately skip it (see next comment).
  const since =
    options.since !== undefined
      ? Math.max(0, options.since - KIND4_REPLAY_OVERLAP_SECONDS)
      : undefined;
  const sentK4Filter: Filter = { kinds: [4], authors: [myPubkey], limit };
  const recvK4Filter: Filter = { kinds: [4], '#p': [myPubkey], limit };
  // NIP-59 (gift-wrap) wraps have RANDOMIZED timestamps within ~2 days
  // of the real publish time in either direction (per spec, for
  // plausible deniability). So `wrap.created_at` does NOT track when
  // the underlying message was sent. Applying `since` to the wraps
  // filter caused recently-published wraps to be silently dropped at
  // the relay whenever their random ts < lastSeen — and lastSeen could
  // itself be a future-dated wrap's random ts (see callers using
  // Math.max over kind1059.created_at), so the inbox query would
  // progressively skip more and more wraps as the future-dated cap
  // ratcheted forward. Symptom: a contact's recent DM is visible inside
  // the per-conversation thread (which fetches peer-scoped without
  // `since`) but never appears on the Messages tab inbox list.
  // Resolution: don't filter wraps by `since` at all. The relay query
  // is bounded by limit + the `#p:[myPubkey]` filter, and the consumer
  // dedupes against the persisted wrap-id cache so already-decrypted
  // wraps short-circuit cheaply.
  const wrapsFilter: Filter = { kinds: [1059], '#p': [myPubkey], limit };
  if (since !== undefined) {
    sentK4Filter.since = since;
    recvK4Filter.since = since;
  }
  const __t0 = performance.now();
  try {
    // maxWait: per-relay EOSE timeout closes the sub, so the cold-start
    // inbox fetch genuinely terminates — unlike withTimeout which only raced the
    // Promise and left the underlying subscribeEose sub running for up to ~60 s.
    // 8 s (was 15 s): a slow/unresponsive relay shouldn't hold the inbox
    // spinner for a quarter-minute that reads as a freeze. The live sub keeps
    // delivering after this resolves, and pull-to-refresh re-runs the query.
    const [sentK4, receivedK4, wraps] = await Promise.all([
      querySyncAbortable(pool, allRelays, sentK4Filter, { maxWait: 8000, signal: options.signal }),
      querySyncAbortable(pool, allRelays, recvK4Filter, { maxWait: 8000, signal: options.signal }),
      querySyncAbortable(pool, allRelays, wrapsFilter, { maxWait: 8000, signal: options.signal }),
    ]);
    // [Perf] Cold-start freeze attribution (#751). querySync ingests every
    // returned event synchronously (JSON.parse + validateEvent + matchFilters)
    // before resolving — logs the wrap count + wall-clock so we can tell
    // whether the dominant cost is fetch volume (reduce limit/fan-out) or
    // per-event ingest (yield). Prints here, inside the fetch, so it survives
    // the caller's post-fetch abort short-circuit (useDmInbox.ts:395) which
    // otherwise suppresses the [Perf] refreshDmInbox count line.
    console.log(
      `[Perf] fetchInboxDmEvents: ${(performance.now() - __t0).toFixed(0)}ms ` +
        `wraps=${wraps.length} sentK4=${sentK4.length} recvK4=${receivedK4.length} ` +
        `relays=${allRelays.length} limit=${limit}`,
    );
    const k4 = new Map<string, RawDmEvent>();
    for (const ev of sentK4) k4.set(ev.id, ev as RawDmEvent);
    for (const ev of receivedK4) k4.set(ev.id, ev as RawDmEvent);
    const k1059 = new Map<string, RawGiftWrapEvent>();
    for (const ev of wraps) k1059.set(ev.id, ev as RawGiftWrapEvent);
    return { kind4: Array.from(k4.values()), kind1059: Array.from(k1059.values()) };
  } catch (error) {
    if (__DEV__) console.warn('[Nostr] fetchInboxDmEvents failed:', error);
    return { kind4: [], kind1059: [] };
  }
}

export interface UnwrappedRumor {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * Unwrap a NIP-17 gift wrap (kind 1059) to its inner rumor. The rumor's
 * `pubkey` is the real sender; its `created_at` is the real send time
 * (the wrap's own timestamp is randomised up to 2 days in the past per
 * the spec). `nip59.unwrapEvent` decrypts the wrap with our secret key,
 * parses the inner seal, decrypts the seal, and verifies the rumor's
 * pubkey matches the seal's pubkey — throws on mismatch, which the
 * caller should treat as a skip-and-log.
 */
export function unwrapGiftWrap(secretKey: Uint8Array, wrap: RawGiftWrapEvent): UnwrappedRumor {
  const rumor = nip59.unwrapEvent(wrap as Parameters<typeof nip59.unwrapEvent>[0], secretKey);
  return {
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
  };
}

export async function decryptNip04WithSecret(
  secretKey: Uint8Array,
  otherPubkey: string,
  ciphertext: string,
): Promise<string> {
  return nip04.decrypt(secretKey, otherPubkey, ciphertext);
}

export function generateKeypair(): { secretKey: Uint8Array; pubkey: string; nsec: string } {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const nsec = nip19.nsecEncode(secretKey);
  return { secretKey, pubkey, nsec };
}

export function cleanup(): void {
  pool.close([...connectedRelays, ...enabledAppRelays('default', DEFAULT_RELAYS)]);
  connectedRelays.clear();
}

export function getRelayConnectionStatus(): Map<string, boolean> {
  return pool.listConnectionStatus();
}

/**
 * Parameterised-replaceable group-state event kind used by Lightning Piggy
 * for client-side group consensus. See PR #227.
 *
 * Tags:
 *  - ["d", group.id]            unique group identifier
 *  - ["name", group.name]       human-readable display name
 *  - ["p", memberPubkey] ...    one entry per member (excluding the signer)
 *
 * Signed by ANY current group member, not only the original creator.
 * The receiver-side trust gate (GroupsContext.reconcileFromGroupStateEvent)
 * accepts updates from any sender who's already in the local member set
 * for that group (plus the viewer themselves for cross-device sync).
 * Receivers reconcile against the latest created_at they've seen for
 * a given groupId.
 */
export const GROUP_STATE_KIND = 30200;

export interface GroupStateEventInput {
  groupId: string;
  name: string;
  memberPubkeys: string[];
}

/**
 * Build (unsigned) the kind-30200 group-state event. Caller is responsible
 * for signing + publishing — same pattern as createDirectMessageRumor.
 *
 * Tags: the NIP-89 `client` tag (LP_CLIENT_TAG, this is a public event),
 * then `d` (groupId), `name`, and one `p` per member.
 */
export function createGroupStateEvent(input: GroupStateEventInput): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const tags: string[][] = [[...LP_CLIENT_TAG], ['d', input.groupId], ['name', input.name]];
  for (const pk of input.memberPubkeys) {
    tags.push(['p', pk]);
  }
  return {
    kind: GROUP_STATE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/**
 * Build the inner kind-14 chat rumor for a group message. Mirrors the
 * NIP-17 spec: the inner rumor carries the human-visible content + a
 * `subject` tag (NIP-14) for the group name + one `p` tag per recipient
 * so members can detect they share a thread.
 *
 * Returned event is unsigned; pass it to nip59 wrap helpers per recipient.
 */
export function createGroupChatRumor(input: {
  senderPubkey: string;
  subject: string;
  memberPubkeys: string[];
  content: string;
}): { kind: number; created_at: number; tags: string[][]; content: string; pubkey: string } {
  const tags: string[][] = [['subject', input.subject]];
  for (const pk of input.memberPubkeys) {
    tags.push(['p', pk]);
  }
  return {
    pubkey: input.senderPubkey,
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.content,
  };
}

/**
 * Subscribe to inbound kind-30200 group-state events relevant to the
 * viewer. Two filters are OR-ed together so the viewer sees:
 *
 *  - groups OTHER members published that p-tag the viewer (`#p: [self]`)
 *  - groups the VIEWER authored themselves (`authors: [self]`)
 *
 * The second filter exists because `createGroupStateEvent` excludes the
 * author from the `p` tags (spec convention — the signer is implicit),
 * so a viewer-authored event wouldn't match the p-tag filter and the
 * group wouldn't sync across the viewer's own devices.
 *
 * Returns an unsubscribe function. Dedup / reconciliation is the
 * caller's job (callback receives every matching event; caller compares
 * created_at).
 */
export function subscribeGroupStateForViewer(input: {
  viewerPubkey: string;
  relays: string[];
  onEvent: (ev: {
    id: string;
    pubkey: string;
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => void;
}): () => void {
  trackRelays(input.relays);
  const onevent = (ev: Parameters<typeof input.onEvent>[0]): void => {
    input.onEvent(ev);
  };
  // Two separate filters (subscribeMany takes a single Filter): one for
  // events that p-tag the viewer, one for events the viewer authored.
  const subPtag = pool.subscribeMany(
    input.relays,
    { kinds: [GROUP_STATE_KIND], '#p': [input.viewerPubkey] } as Filter,
    { onevent },
  );
  const subAuthored = pool.subscribeMany(
    input.relays,
    { kinds: [GROUP_STATE_KIND], authors: [input.viewerPubkey] } as Filter,
    { onevent },
  );
  return () => {
    for (const s of [subPtag, subAuthored]) {
      try {
        s.close();
      } catch {
        // best-effort
      }
    }
  };
}

// Live-DM event type. Structurally a generic Nostr event — kind-4
// (legacy NIP-04) and kind-1059 (NIP-17 gift wrap) share the same
// shape, the wire kind tells the caller which decrypt path to run.
export type RawInboxDmEvent = RawGiftWrapEvent;

// Subscribe to inbound DM events (kind-4 NIP-04 + kind-1059 NIP-17
// gift wraps) addressed to the viewer. Long-lived sub kept open while
// the user is signed in so the app delivers DMs / group messages live
// without waiting for the 30 s-TTL `refreshDmInbox` or
// pull-to-refresh (#349).
//
// Notes:
//  - `#p:[viewerPubkey]` matches the recipient tag set on both kinds;
//    for kind-1059 the sender's identity is hidden inside the encrypted
//    seal, and for kind-4 it's in the event envelope, but in either
//    case the relay-side filter is the recipient tag.
//  - The filter only catches *incoming* events. Outgoing kind-4 from a
//    second device authored by the viewer wouldn't tag the viewer in
//    `#p`, so multi-device sent-event sync still flows through
//    pull-to-refresh / the next focus-driven `refreshDmInbox`.
//  - Two SEPARATE subs (one per kind) so we can apply `since` to kind-4
//    only — NIP-59 randomises kind-1059 wrap.created_at by ±2 days for
//    plausible deniability, so a server-side `since` cutoff on wraps
//    silently drops legit fresh messages whose fake timestamp is older
//    than the cutoff. kind-4 uses real timestamps and tolerates `since`.
//    See fetchInboxDmEvents at lines ~769-785 for the same reasoning in
//    the bulk-fetch path. (#383)
//  - Both kinds get a 1000-event `limit`. Most relays cap at this
//    anyway; making it explicit aligns the contract and stops a fresh
//    install from being flooded with the user's entire DM history. (#383)
//  - 90 days on kind-4 matches the largest UI filter chip ("Last
//    30/90 days"). Older threads stay reachable via per-conversation
//    queries when the user opens the thread (those have no `since`).
//  - Caller is responsible for deduping (e.g. against the persistent
//    NIP-17 wrap-id cache + the NIP-04 RAM LRU populated by
//    refreshDmInbox).

// Shared between the live sub (subscribeInboxDmsForViewer) and the bulk
// fetch (fetchInboxDmEvents) so the two paths can't drift in cap on a
// future tweak. (#383, Copilot review on PR #384)
export { DM_INBOX_LIMIT } from './dmInboxFetchPolicy';

// The live inbox subscription (subscribeInboxDmsForViewer) was extracted to
// ./dmLiveSubscription to keep this file under the size cap (#703).

// The profile page's author feed (notes + picture / video events) lives in
// ./authorFeedService (#1332).
