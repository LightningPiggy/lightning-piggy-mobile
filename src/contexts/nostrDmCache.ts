import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { utf8ByteSize } from '../utils/byteSize';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { LOCAL_DM_ID_PREFIX, LOCAL_DM_ECHO_WINDOW_SECS, wasDmRowDeleted } from '../services/dmDb';
import type { ConversationMessage } from './nostrContextTypes';
import { protocolForWireKind } from '../utils/dmProtocol';

// Re-export the echo-window constant from its single source of truth (dmDb —
// the store-level echo retire and this in-memory merge must agree, #850).
export { LOCAL_DM_ECHO_WINDOW_SECS };

// Legacy keys for the plaintext NIP-17 wrap caches (#176/#687/#689 — RETIRED
// in #848). Decrypted rumors now persist as rows in the encrypted SQLCipher
// DB (services/dmDb); nothing writes these caches any more. The keys remain
// so the one-time migration (dmStoreMigrationRunner) can import + delete an
// existing install's cache, and so logout wipes can clean up stragglers.
// Both signer paths share the entry shape; separate keys kept cross-signer
// login on the same device from leaking plaintext between identities, and
// since #288 each base is suffixed with `_${pubkey}` via `perAccountKey()`.
export const AMBER_NIP17_CACHE_KEY_BASE = 'amber_nip17_cache_v1';
export const NSEC_NIP17_CACHE_KEY_BASE = 'nsec_nip17_cache_v1';
export const isWrapCacheKey = (key: string): boolean =>
  key.startsWith(AMBER_NIP17_CACHE_KEY_BASE) || key.startsWith(NSEC_NIP17_CACHE_KEY_BASE);
// The key is already filesystem-safe (base + '_' + hex pubkey).
export const wrapCacheFileName = (key: string): string => `${key}.json`;
// Legacy AsyncStorage key from the now-removed "Enable NIP-17 on Amber" toggle (#404). Cleared on logout so old installs don't leave dead bytes around.
export const AMBER_NIP17_ENABLED_KEY_LEGACY = 'amber_nip17_enabled';

// Negative-result skip-set: wrap ids that were decrypted in a prior
// refresh but produced no inbox entry — because the rumor was a group
// message (routed to group storage) or from a non-followed sender. On
// subsequent warm refreshes the relay re-delivers the same wraps and
// the decrypt loop re-pays the schnorr + NIP-44 cost for each one.
// Persisting the skip-set lets the loop short-circuit without
// re-decrypting. Only the wrap *id* (a public nonce on the sealed
// outer envelope) is stored — no plaintext, no sender pubkey.
// Invariant: a wrap id is added to the skip-set ONLY after a successful
// decrypt proves it carries a non-inbox rumor; failed decrypts (wrong
// key, corrupt wrap) are left out so the next refresh retries them.
// Cap matches the positive cache to prevent unbounded growth.
// v3 re-evaluates dropped non-friend orders; v2 recovered legacy Welcomes.
export const NSEC_NIP17_SKIP_KEY_BASE = 'nsec_nip17_skip_v3';
export const AMBER_NIP17_SKIP_KEY_BASE = 'amber_nip17_skip_v3';
export const NIP46_NIP17_SKIP_KEY_BASE = 'nip46_nip17_skip_v3';
export const NIP17_SKIP_CAP = 50_000;

/** Load and parse the skip-set from its file, returning an empty Set on
 * any failure (missing file, corrupt JSON). The outer Set is O(1) lookup
 * vs the per-entry object used by the positive cache — a tiny extra
 * allocation but nicer ergonomics for `has(id)` + `add(id)`. */
export async function loadNip17SkipSet(storageKey: string): Promise<Set<string>> {
  try {
    const f = new File(Paths.document, wrapCacheFileName(storageKey));
    if (!f.exists) return new Set<string>();
    const raw = await f.text();
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set<string>(arr as string[]);
  } catch {
    // Treat corrupt file as empty — the next refresh repopulates it.
  }
  return new Set<string>();
}

/** Persist the skip-set to its per-account file. Enforces NIP17_SKIP_CAP
 * by dropping the first (oldest-inserted) entries when over the limit —
 * insertion order of a Set is stable in JS so oldest goes first. Write
 * failures are surfaced as a warn so a broken storage subsystem isn't
 * silent. */
export async function writeNip17SkipSet(storageKey: string, set: Set<string>): Promise<void> {
  // Trim to cap before persisting — keep the newest (end of insertion
  // order) because recently-skipped wraps are more likely to re-appear.
  let arr = Array.from(set);
  if (arr.length > NIP17_SKIP_CAP) arr = arr.slice(arr.length - NIP17_SKIP_CAP);
  try {
    const f = new File(Paths.document, wrapCacheFileName(storageKey));
    if (f.exists) f.delete();
    f.create();
    f.write(JSON.stringify(arr));
  } catch (err) {
    console.warn(`[Nostr] NIP-17 skip-set file write failed (${storageKey}):`, err);
  }
}

/** Entry shape of the retired plaintext wrap cache — kept for the one-time
 * import into the encrypted DB (dmStoreMigrationRunner, #848). */
export type Nip17CacheEntry = DmInboxEntry & { wrapId: string };

/** Parse an AsyncStorage JSON blob into an object-keyed record, falling
 * back to `{}` if the value is missing, not valid JSON, or not an
 * object. A corrupted cache should be treated as a cold cache rather
 * than an exception that aborts the caller. */
export function safeParseRecord<T>(raw: string | null): Record<string, T> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, T>;
    }
  } catch {
    // fall through — treat corrupted blob as empty
  }
  return {};
}

/**
 * Minimum gap between `refreshDmInbox` calls fired by
 * `useFocusEffect` on the Messages tab. Without a TTL, every tab return
 * triggered a fresh 3-query relay round-trip + full NIP-04 decrypt
 * sweep — locking the app up for seconds on the 2nd/3rd/Nth visit.
 * 60 s is long enough that quick tab-bouncing stays responsive, short
 * enough that a user who genuinely wants fresh state (open app after
 * a break) still pays normal refresh cost. Pull-to-refresh bypasses
 * the TTL via `{ force: true }`.
 */
export const DM_INBOX_REFRESH_TTL_MS = 60_000;

/**
 * Cold-start initial wrap fetch size (#751). The first inbox refresh of a
 * session fetches only this many kind-1059 wraps so the Messages tab paints
 * fast instead of blocking the JS thread on the full backlog ingest (508 wraps
 * × 5 relays measured at ~12 s). `refreshDmInbox` then schedules a full-limit
 * backfill in the background, deferred past interactions and abortable on blur.
 */
export const COLD_INITIAL_WRAP_LIMIT = 200;

/**
 * LEGACY plaintext inbox + per-peer conversation blobs — RETIRED in #850.
 *
 * `nostr_dm_inbox_v1_*` and `nostr_dm_conv_v1_*` held decrypted DM plaintext
 * (up to DM_INBOX_CAP summaries / DM_CONV_CAP messages per peer) in
 * UNENCRYPTED AsyncStorage, duplicating what the SQLCipher store protects.
 * Nothing writes them any more: conversations + inbox serve purely from the
 * encrypted store (dmDb), which now also carries deliveryStatus / rumorId /
 * optimistic local- rows. The key constants remain so the one-time migration
 * (dmBlobMigrationRunner) can import + delete an existing install's blobs,
 * and so logout wipes clean up stragglers.
 *
 * Conversation last-seen keys remain live. The inbox last-seen key is a
 * migration fallback; kind-4 commits its cursor with retry metadata atomically.
 */
export const DM_INBOX_CACHE_PREFIX = 'nostr_dm_inbox_v1_';
export const DM_INBOX_LAST_SEEN_PREFIX = 'nostr_dm_inbox_last_seen_v1_';
export const DM_CONV_CACHE_PREFIX = 'nostr_dm_conv_v1_';
export const DM_CONV_LAST_SEEN_PREFIX = 'nostr_dm_conv_last_seen_v1_';
export const DM_INBOX_CAP = 1000;
export const DM_CONV_CAP = 500;
// Hard byte ceiling for a single DM cache row. Android's SQLite
// CursorWindow caps a row at ~2 MB — past it the *read* throws
// SQLiteBlobTooBigException, the cache silently fails to hydrate, and
// every cold start falls back to a full relay restream + NIP-17
// re-decrypt (a ~70s JS-thread stall). The count caps above aren't
// enough when messages are long, so the merge fns trim by size too.
export const DM_CACHE_MAX_BYTES = 1_500_000;

export function inboxCacheKey(user: string) {
  return DM_INBOX_CACHE_PREFIX + user;
}
export function inboxLastSeenKey(user: string) {
  return DM_INBOX_LAST_SEEN_PREFIX + user;
}
export function convCacheKey(user: string, peer: string) {
  return DM_CONV_CACHE_PREFIX + user + '_' + peer;
}
export function convLastSeenKey(user: string, peer: string) {
  return DM_CONV_LAST_SEEN_PREFIX + user + '_' + peer;
}

/**
 * Read a DM-cache row, treating an unreadable row as empty. Android's
 * SQLite CursorWindow caps a row at ~2 MB; a row past that throws
 * `SQLiteBlobTooBigException` on read. Without this guard the throw
 * aborts the whole refresh/fetch before the write-side byte cap can
 * rewrite a smaller row — so an already-oversized row would never
 * self-heal. Catching it (and dropping the poisoned key) lets the next
 * relay restream repopulate a byte-capped row.
 */
export async function safeGetDmCacheItem(key: string): Promise<string | null> {
  // Wrap plaintext caches are file-backed — files have no ~2 MB SQLite
  // CursorWindow row read cap, so a large inbox hydrates instead of
  // failing and re-decrypting every cold start (#687).
  if (isWrapCacheKey(key)) {
    try {
      const f = new File(Paths.document, wrapCacheFileName(key));
      if (f.exists) return await f.text();
      // One-time migration: seed the file from the legacy AsyncStorage row
      // (if it's still readable) so existing installs keep their cache;
      // then retire the row. An unreadable legacy row just yields null and
      // the next refresh repopulates the file.
      const legacy = await AsyncStorage.getItem(key).catch(() => null);
      if (legacy) {
        try {
          f.create();
          f.write(legacy);
          // Retire the legacy row only AFTER the file write succeeds — a
          // failed migration must not discard a usable cache (#689 review).
          AsyncStorage.removeItem(key).catch(() => {});
        } catch {
          // Migration failed — leave the AsyncStorage row intact; the next
          // write/refresh retries.
        }
      }
      return legacy;
    } catch (err) {
      console.warn(`[Nostr] NIP-17 cache file read failed — treating as empty (${key}):`, err);
      return null;
    }
  }
  try {
    return await AsyncStorage.getItem(key);
  } catch (err) {
    console.warn(`[Nostr] DM cache row unreadable — dropping ${key}:`, err);
    AsyncStorage.removeItem(key).catch(() => {});
    return null;
  }
}

export async function loadLastSeen(key: string): Promise<number | undefined> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Merge cached list with freshly-decrypted entries. Cached entries we
 * already have take precedence (they might have had properties we'd
 * need to re-decrypt to recover). Dedup key is `id` (kind-4 event id
 * or kind-1059 wrap id). A fallback composite key covers persisted
 * entries written before `id` was added to the type so loading an
 * old cache doesn't silently drop everything to the same slot.
 */
export function mergeInboxEntries(
  cached: DmInboxEntry[],
  fresh: DmInboxEntry[],
  cap: number,
): DmInboxEntry[] {
  const map = new Map<string, DmInboxEntry>();
  const dedupKey = (e: DmInboxEntry): string =>
    e.id ?? `${e.partnerPubkey}|${e.createdAt}|${e.wireKind}`;
  for (const e of cached) map.set(dedupKey(e), e);
  for (const e of fresh) map.set(dedupKey(e), e);
  const all = Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  let result = all.slice(0, cap);
  // Byte guard (see DM_CACHE_MAX_BYTES) — sorted newest-first, so drop
  // from the tail (oldest). `> 0` not `> 1` so a single over-budget
  // entry still goes rather than persisting an unreadable row;
  // `Math.max(1, …)` guarantees forward progress (a 0.1 factor rounds
  // to 0 for tiny arrays, which would spin forever).
  while (result.length > 0 && utf8ByteSize(JSON.stringify(result)) > DM_CACHE_MAX_BYTES) {
    const drop = Math.max(1, Math.floor(result.length * 0.1));
    result = result.slice(0, result.length - drop);
  }
  return result;
}

export function mergeConversationMessages(
  cached: ConversationMessage[],
  fresh: ConversationMessage[],
  cap: number,
): ConversationMessage[] {
  const map = new Map<string, ConversationMessage>();
  for (const m of cached) map.set(m.id, m);
  for (const m of fresh) {
    // When a real (non-local-) entry arrives, drop any pending local-
    // echo with matching fromMe + text within the echo window. Without
    // this the user would see two bubbles for the same GIF/text: the
    // optimistic local- row persisted by ConversationScreen on send,
    // plus the NIP-17 self-wrap echo from the relay.
    let inheritedDelivery: ConversationMessage['deliveryStatus'];
    let inheritedRumorId: string | undefined;
    if (!m.id.startsWith('local-')) {
      let bestKey: string | null = null;
      let bestDelta = Infinity;
      for (const [k, prev] of map) {
        if (!k.startsWith('local-')) continue;
        if (prev.fromMe !== m.fromMe) continue;
        if (prev.text !== m.text) continue;
        // Threads are split per protocol: a NIP-17 echo must never retire a
        // NIP-04 optimistic row with the same text (or vice versa).
        if (
          protocolForWireKind(prev.wireKind, prev.protocol) !==
          protocolForWireKind(m.wireKind, m.protocol)
        )
          continue;
        const delta = Math.abs(prev.createdAt - m.createdAt);
        if (delta > LOCAL_DM_ECHO_WINDOW_SECS) continue;
        if (delta < bestDelta) {
          bestDelta = delta;
          bestKey = k;
        }
      }
      if (bestKey !== null) {
        // Carry the per-relay delivery breakdown (#856) AND the rumorId (#857)
        // from the dropped optimistic row onto the real-id echo, so the sent
        // bubble keeps its tick after the relay self-wrap replaces the local-
        // row. The echo from a warm DB read has no rumorId of its own (the
        // encrypted store doesn't persist it), so without this carry-over the
        // store key would be lost and the tick stripped.
        inheritedDelivery = map.get(bestKey)?.deliveryStatus;
        inheritedRumorId = map.get(bestKey)?.rumorId;
        map.delete(bestKey);
      }
    }
    // A fresh echo with no delivery info must not clobber a delivery status we
    // already attached to this same id on a prior merge (#856). Once the tick
    // is on a real-id row, re-decrypting the same wrap on the next refresh
    // re-supplies the row without delivery — keep the existing one. Same for
    // rumorId (#857), which a fresh-decrypt echo DOES carry but a warm DB read
    // does not — prefer whichever source has it.
    const prevRow = map.get(m.id);
    const deliveryStatus = m.deliveryStatus ?? inheritedDelivery ?? prevRow?.deliveryStatus;
    const rumorId = m.rumorId ?? inheritedRumorId ?? prevRow?.rumorId;
    const merged =
      deliveryStatus !== m.deliveryStatus || rumorId !== m.rumorId
        ? { ...m, deliveryStatus, rumorId }
        : m;
    map.set(m.id, merged);
  }
  const all = Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt);
  // Keep the newest DM_CONV_CAP messages; drop oldest.
  let result = all.length <= cap ? all : all.slice(all.length - cap);
  // Byte guard (see DM_CACHE_MAX_BYTES) — sorted oldest-first, so drop
  // from the head (oldest). `> 0` not `> 1` so a single over-budget
  // message still goes; `Math.max(1, …)` guarantees forward progress.
  while (result.length > 0 && utf8ByteSize(JSON.stringify(result)) > DM_CACHE_MAX_BYTES) {
    const drop = Math.max(1, Math.floor(result.length * 0.1));
    result = result.slice(drop);
  }
  return result;
}

/**
 * Carry still-pending optimistic local- rows from the in-memory thread onto a
 * freshly fetched list. A thread fetch that read the store BEFORE the
 * optimistic append committed would otherwise replace the list without the
 * just-sent bubble. NIP-17 hides this race (the self-wrap echo triggers a
 * reload) but a NIP-04 send has no self echo on the live sub, so the first
 * message in a new conversation vanished until the thread was reopened.
 * Rows whose echo IS in `fetched` collapse via `dedupeLocalEchoes`.
 */
export function keepPendingLocalRows(
  current: ConversationMessage[],
  fetched: ConversationMessage[],
): ConversationMessage[] {
  const fetchedIds = new Set(fetched.map((m) => m.id));
  // A row deleted for everyone isn't pending — it's gone (#1237).
  const pending = current.filter(
    (m) => m.id.startsWith(LOCAL_DM_ID_PREFIX) && !fetchedIds.has(m.id) && !wasDmRowDeleted(m.id),
  );
  return pending.length === 0 ? fetched : dedupeLocalEchoes([...fetched, ...pending]);
}

/**
 * Read-side echo dedup for a single store read (#850). `upsertDmMessages`
 * retires a matched local- row when its echo lands, but the two writes can
 * race (optimistic append vs live-sub echo), so a read may still see both
 * rows. Splitting the list into local- vs real and merging real OVER local
 * reuses `mergeConversationMessages`' exact pairing (fromMe + text + echo
 * window) — one bubble per send, ticks/rumorId inherited — without a second
 * implementation of the rule.
 */
export function dedupeLocalEchoes(
  messages: ConversationMessage[],
  cap: number = DM_CONV_CAP,
): ConversationMessage[] {
  const locals = messages.filter((m) => m.id.startsWith(LOCAL_DM_ID_PREFIX));
  const reals = messages.filter((m) => !m.id.startsWith(LOCAL_DM_ID_PREFIX));
  return mergeConversationMessages(locals, reals, cap);
}

/**
 * Carry `deliveryStatus` (#856) from the CURRENT in-memory messages onto a
 * freshly-fetched list, so a sent bubble keeps its tick when a thread reload /
 * live-sub echo replaces the optimistic row.
 *
 * Why this exists separately from `mergeConversationMessages`: the persisted
 * conv-cache merge can miss the carry-over when the relay echo lands BEFORE
 * the fire-and-forget `appendLocalDmMessage` write commits — at that moment
 * the on-disk cache has no `local-` row to inherit from, so the echo overwrites
 * with no tick. The in-memory state always holds the authoritative
 * `deliveryStatus`, so reconciling against it closes that race.
 *
 * A `next` row inherits the status of (1) the same id in `prev`, or failing
 * that (2) a `prev` row — typically the optimistic `local-` one — with the
 * same `fromMe` + `text` within the echo window. `next` rows that already
 * carry a status keep their own.
 */
export function reconcileDeliveryStatus(
  prev: ConversationMessage[],
  next: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>();
  for (const p of prev) byId.set(p.id, p);
  return next.map((n) => {
    // Inherit both the delivery status (#856) and the rumorId (#857, the
    // delivery-store key) from the matching prev row — by id, else the
    // local-echo pairing (fromMe + text + window) that covers the optimistic
    // `local-` → real-id handoff. A warm-DB echo carries neither of its own.
    let inheritedDelivery = n.deliveryStatus;
    let inheritedRumorId = n.rumorId;
    if (!inheritedDelivery || !inheritedRumorId) {
      const sameId = byId.get(n.id);
      let paired = sameId;
      if (!paired || (!paired.deliveryStatus && !paired.rumorId)) {
        let bestDelta = Infinity;
        for (const p of prev) {
          if (!p.deliveryStatus && !p.rumorId) continue;
          if (p.fromMe !== n.fromMe || p.text !== n.text) continue;
          const delta = Math.abs(p.createdAt - n.createdAt);
          if (delta > LOCAL_DM_ECHO_WINDOW_SECS || delta >= bestDelta) continue;
          bestDelta = delta;
          paired = p;
        }
      }
      inheritedDelivery = inheritedDelivery ?? paired?.deliveryStatus;
      inheritedRumorId = inheritedRumorId ?? paired?.rumorId;
    }
    return inheritedDelivery !== n.deliveryStatus || inheritedRumorId !== n.rumorId
      ? { ...n, deliveryStatus: inheritedDelivery, rumorId: inheritedRumorId }
      : n;
  });
}
