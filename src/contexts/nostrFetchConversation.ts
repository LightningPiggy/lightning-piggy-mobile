import { loadKind4ReplayCursor } from './kind4RetryStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import * as nostrConnectService from '../services/nostrConnectService';
import type { SignerType } from '../types/nostr';
import { unwrapWrapNsec, unwrapWrapViaNip44, type DecodedRumor } from '../utils/nip17Unwrap';
import {
  getConversationMessages,
  hasStoredWraps,
  selectKnownEventIds,
  upsertDmMessages,
  type DmMessageRow,
} from '../services/dmDb';
import { nip04PlaintextCache, getMemoisedSecretKey } from './nostrSecretKeyCache';
import { yieldToEventLoop, DECRYPT_YIELD_EVERY } from './nostrDecryptPacing';
import {
  DM_CONV_CAP,
  inboxLastSeenKey,
  convLastSeenKey,
  loadLastSeen,
  mergeConversationMessages,
  dedupeLocalEchoes,
} from './nostrDmCache';
import { mapStoredRowsToMessages } from './conversationReadThrough';
import { ingestInboxWraps } from './dmWrapIngest';
import { backfillThreadRumorIds, fetchWrapsByIds } from './dmRumorIdBackfill';
import { filterMessagesByProtocol } from '../utils/dmProtocol';
import { ensureDmStoreMigrated } from './dmStoreMigrationRunner';
import type { ConversationMessage } from './nostrContextTypes';

/**
 * Inputs `fetchConversation` closes over in the provider. Extracted into a
 * standalone async function (#703) — `useDmInbox` threads in the active
 * identity (`pubkey`, `isLoggedIn`, `signerType`), the relay resolver
 * (`getReadRelays`), and the per-signer NIP-04 decrypt closure
 * (`decryptNip04ViaSigner`). The whole at-rest side of a thread is the
 * encrypted DM store's indexed (owner, conversation, created_at) slice
 * (#848/#850) — the plaintext wrap-cache file AND the per-conversation
 * AsyncStorage blob this used to read/write are retired. Fresh relay
 * decrypts are persisted to the store and merged in memory only.
 */
export interface FetchConversationParams {
  pubkey: string | null;
  isLoggedIn: boolean;
  signerType: SignerType | null;
  getReadRelays: () => string[];
  decryptNip04ViaSigner: (counterpartyPubkey: string, ciphertext: string) => Promise<string | null>;
  otherPubkey: string;
  isFollowed?: (pk: string) => boolean;
  // Cancels the relay fetch + decrypt loop when the user navigates away (#868).
  // Mirrors refreshDmInbox's opts.signal: the loop bails at its yield points so
  // a back-press mid-fetch stops chewing the JS thread, and re-entering can
  // abort-and-replace an in-flight fetch instead of stacking a second loop.
  signal?: AbortSignal;
  /** Read and return only this protocol's thread (#1118), so the
   * DM_CONV_CAP window applies per thread rather than per peer. Decryption,
   * storage and the since-cursor are unaffected. Omit for all protocols. */
  protocol?: 'nip04' | 'nip17';
}

export async function fetchConversationFor(
  params: FetchConversationParams,
): Promise<ConversationMessage[]> {
  const {
    pubkey,
    isLoggedIn,
    signerType,
    getReadRelays,
    decryptNip04ViaSigner,
    otherPubkey,
    signal,
    protocol,
  } = params;
  if (!pubkey || !isLoggedIn) return [];
  if (signal?.aborted) return [];
  const normalized = otherPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return [];

  // One-time plaintext→encrypted store migration (#848/#850) — memoised, so
  // this is a Map lookup after the first call. A notification deep-link can
  // open a thread before any inbox refresh ran, so the trigger lives here too.
  await ensureDmStoreMigrated(pubkey);

  // Perf instrumentation — unconditional (not __DEV__ gated) so we
  // can grep the same line out of logcat on a production APK to
  // compare cold-store vs warm-store thread opens. Numbers are
  // counts-only — no plaintext / pubkey logged beyond a short id.
  const perfStart = performance.now();
  let nip17StoreHits = 0;
  let nip17FreshDecrypts = 0;
  let nip04StoreHits = 0;
  let nip04CacheHits = 0;
  let nip04DbKnown = 0;
  let nip04FreshDecrypts = 0;

  const readRelays = getReadRelays();
  const decrypted: ConversationMessage[] = [];

  // The at-rest thread slice: everything any surface ever decrypted for this
  // peer, straight from the encrypted store's indexed read (#850 — this
  // replaces BOTH the plaintext conv blob and the separate store read the
  // pre-#850 flow merged). Carries the optimistic local- rows + delivery
  // ticks + rumor ids the blob used to be the only home for.
  let storedMessages: ConversationMessage[] = [];
  let storeHasWraps = false;
  try {
    const threadRows = await getConversationMessages(pubkey, normalized, {
      limit: DM_CONV_CAP,
      protocol,
    });
    for (const r of threadRows) {
      if (r.wireKind === 4) nip04StoreHits++;
      else nip17StoreHits++;
    }
    storedMessages = dedupeLocalEchoes(mapStoredRowsToMessages(threadRows), DM_CONV_CAP);
    storeHasWraps = await hasStoredWraps(pubkey);
  } catch (e) {
    // Store unavailable — degrade to the relay fetch below.
    if (__DEV__) console.warn('[DmStore] thread slice read failed:', e);
  }

  const convLastSeen = await loadLastSeen(convLastSeenKey(pubkey, normalized));

  // NIP-04 — peer-scoped fetch, two directions, filtered by since.
  const kind4Events = await nostrService.fetchDirectMessageEvents(pubkey, normalized, readRelays, {
    since: convLastSeen,
  });
  // Three-pass decrypt:
  //  1. Pull plaintext synchronously for events already in the RAM LRU —
  //     no decrypt round-trip, no Amber IPC, no CPU.
  //  2. DB known-id gate (#850, closes the N6 asymmetry with the inbox
  //     path): RAM misses whose decrypts are already encrypted-store rows
  //     need no signer round-trip — `storedMessages` above already carries
  //     them. One chunked indexed query.
  //  3. Decrypt the remaining misses in parallel (`Promise.all`), chunked
  //     in slices of DECRYPT_YIELD_EVERY to yield to the UI thread.
  const ramMisses: {
    idx: number;
    counterparty: string;
    ev: (typeof kind4Events)[0];
  }[] = [];
  const cachedPlaintexts: {
    idx: number;
    fromMe: boolean;
    text: string;
    ev: (typeof kind4Events)[0];
  }[] = [];
  for (let i = 0; i < kind4Events.length; i++) {
    const ev = kind4Events[i];
    const fromMe = ev.pubkey === pubkey;
    const counterparty = fromMe ? normalized : ev.pubkey.toLowerCase();
    const hit = nip04PlaintextCache.get(ev.id);
    if (hit !== undefined) {
      nip04CacheHits++;
      cachedPlaintexts.push({ idx: i, fromMe, text: hit, ev });
    } else {
      ramMisses.push({ idx: i, counterparty, ev });
    }
  }
  const k4Known =
    ramMisses.length > 0
      ? await selectKnownEventIds(
          pubkey,
          ramMisses.map((t) => t.ev.id),
        ).catch(() => new Set<string>())
      : new Set<string>();
  nip04DbKnown = k4Known.size;
  const freshDecryptTargets = ramMisses.filter((t) => !k4Known.has(t.ev.id));
  // Parallel decrypt of misses, in yield-able chunks.
  const freshResults: ({
    idx: number;
    fromMe: boolean;
    text: string;
    ev: (typeof kind4Events)[0];
  } | null)[] = [];
  for (let i = 0; i < freshDecryptTargets.length; i += DECRYPT_YIELD_EVERY) {
    // Bail between batches once the caller aborts (#868) — same yield-point
    // cancellation refreshDmInbox/ingestInboxWraps already do. Stops a back-
    // press mid-fetch from draining the rest of the decrypt loop.
    if (signal?.aborted) break;
    const batch = freshDecryptTargets.slice(i, i + DECRYPT_YIELD_EVERY);
    const batchResults = await Promise.all(
      batch.map(async (t) => {
        nip04FreshDecrypts++;
        const plaintext = await decryptNip04ViaSigner(t.counterparty, t.ev.content);
        if (plaintext === null) return null;
        // Cache the successful decrypt. Event ids are immutable so
        // we can store unconditionally — no staleness possible.
        if (!signal?.aborted) nip04PlaintextCache.set(t.ev.id, plaintext);
        const fromMe = t.ev.pubkey === pubkey;
        return { idx: t.idx, fromMe, text: plaintext, ev: t.ev };
      }),
    );
    freshResults.push(...batchResults);
    if (i + DECRYPT_YIELD_EVERY < freshDecryptTargets.length) await yieldToEventLoop();
  }
  // Persist fresh NIP-04 decrypts to the encrypted store (#848) so the next
  // open of ANY surface is decrypt-once — the RAM LRU dies with the session.
  const k4Rows: DmMessageRow[] = [];
  for (const r of freshResults) {
    if (!r) continue;
    k4Rows.push({
      owner: pubkey,
      eventId: r.ev.id,
      conversation: normalized,
      createdAt: r.ev.created_at,
      sender: r.fromMe ? pubkey : normalized,
      content: r.text,
      fromMe: r.fromMe,
      wireKind: 4,
    });
  }
  if (k4Rows.length > 0) {
    await upsertDmMessages(k4Rows).catch((e) => {
      if (__DEV__) console.warn('[DmStore] thread kind-4 upsert failed:', e);
    });
  }
  // Merge cached + fresh preserving original event order.
  const orderedByIndex = new Array<ConversationMessage | null>(kind4Events.length).fill(null);
  for (const c of cachedPlaintexts) {
    orderedByIndex[c.idx] = {
      id: c.ev.id,
      fromMe: c.fromMe,
      text: c.text,
      createdAt: c.ev.created_at,
      wireKind: 4, // these are kind-4 NIP-04 events
    };
  }
  for (const r of freshResults) {
    if (!r) continue;
    orderedByIndex[r.idx] = {
      id: r.ev.id,
      fromMe: r.fromMe,
      text: r.text,
      createdAt: r.ev.created_at,
      wireKind: 4,
    };
  }
  for (const m of orderedByIndex) if (m !== null) decrypted.push(m);

  // NIP-17 — partner pubkey is hidden inside the encrypted rumor, so we
  // can't peer-scope at the relay. The encrypted DM store memoises every
  // wrap the inbox ever decrypted (#848), and `storedMessages` above already
  // holds THIS thread's slice — so if the store holds ANY wraps (an
  // inbox-wide ingest has run before), skip the expensive inbox-wide relay
  // fetch entirely (#190).
  //
  // Cold-store fallback: if the store has no wraps at all (first app
  // run post-login, or just-logged-out-logged-back-in) we still hit
  // the relay so the thread renders even before any refreshDmInbox has
  // fired. Subsequent opens short-circuit.
  //
  // Staleness tradeoff: a wrap that arrived in the last <30s and
  // hasn't been pulled by refreshDmInbox yet won't show until the
  // next tab focus. For a chat UX that's a non-issue.
  const skippedInboxFetch = storeHasWraps;
  // Aborted mid-fetch (back-press during the kind-4 decrypt) — skip the
  // inbox-wide wrap fetch entirely and return what the store already gave us
  // (#868).
  const skipWrapFetch = skippedInboxFetch || (signal?.aborted ?? false);
  const inboxLastSeenForWraps = skipWrapFetch
    ? undefined
    : await loadKind4ReplayCursor(pubkey, await loadLastSeen(inboxLastSeenKey(pubkey)));
  const { kind1059 } = skipWrapFetch
    ? {
        kind1059: [] as Awaited<ReturnType<typeof nostrService.fetchInboxDmEvents>>['kind1059'],
      }
    : await nostrService.fetchInboxDmEvents(pubkey, readRelays, {
        since: inboxLastSeenForWraps,
      });
  if (
    kind1059.length > 0 &&
    (signerType === 'nsec' || signerType === 'amber' || signerType === 'nip46')
  ) {
    const onSkip = (reason: string, wrapId: string) => {
      if (__DEV__) console.warn(`[Nostr] NIP-17 thread unwrap skip (${wrapId}): ${reason}`);
    };
    let unwrap: ((wrap: (typeof kind1059)[0]) => Promise<DecodedRumor | null> | DecodedRumor | null) | null = null; // prettier-ignore
    if (signerType === 'nsec') {
      const secretKey = await getMemoisedSecretKey(pubkey);
      if (secretKey) unwrap = (wrap) => unwrapWrapNsec(wrap, secretKey, onSkip);
    } else if (signerType === 'amber') {
      // Thread view falls back to the Intent dialog if the silent path
      // rejects — the user has actively opened this thread, one approval
      // prompt per wrap is fine. Inbox refresh uses the silent-only path to
      // avoid the flood; stored rows cover the hot path.
      unwrap = (wrap) =>
        unwrapWrapViaNip44(wrap, (ct, cp) => amberService.requestNip44Decrypt(ct, cp, pubkey), onSkip); // prettier-ignore
    } else {
      // NIP-46 thread view: one bunker round-trip per wrap. Same as the
      // Amber fallback — the user has actively opened this thread, so a
      // per-wrap decrypt is acceptable; cache hits short-circuit.
      unwrap = (wrap) =>
        unwrapWrapViaNip44(wrap, (ct, cp) => nostrConnectService.requestNip44Decrypt(ct, cp, pubkey), onSkip); // prettier-ignore
    }
    if (unwrap) {
      // Same decrypt-once engine as refreshDmInbox (#848): DB known-id gate,
      // group routing, batched upsert. Differences preserved from the old
      // thread loop: every successfully decrypted 1:1 rumor is stored even if
      // it belongs to a different thread or a non-followed sender (the user
      // explicitly opened a conversation; inbox surfaces stay follow-gated at
      // read time), and the #743 skip-set is neither consulted nor written.
      const r = await ingestInboxWraps({
        owner: pubkey,
        wraps: kind1059,
        unwrap,
        passesFollowGate: () => true,
        isFollowed: params.isFollowed,
        onSkip,
        signal,
      });
      nip17StoreHits += r.alreadyKnown;
      nip17FreshDecrypts += r.misses;
      // Render-side filter to this thread's partner only — the rest were
      // stored for later opens of their own threads.
      for (const e of r.entries) {
        if (e.partnerPubkey !== normalized) continue;
        decrypted.push({
          id: e.id,
          fromMe: e.fromMe,
          // Thread render uses the raw content (order JSON for kind 16/17) so a
          // freshly-decrypted order card renders on first open; `e.text` is the
          // inbox preview and would fall through to the "unsupported" placeholder
          // (#market). Falls back to `text` for entries without renderText.
          text: e.renderText ?? e.text,
          createdAt: e.createdAt,
          wireKind: e.wireKind,
          rumorId: e.rumorId,
        });
      }
    }
  }

  // Merge fresh decrypt results over the stored slice. Fresh takes precedence
  // via `mergeConversationMessages` Map semantics (and retires any optimistic
  // local- row its relay echo just replaced — the store-side upsert did the
  // same for the persisted rows).
  // Rows stored before received rows kept their rumor id (#1320) get it now,
  // so old messages can be reacted to. Runs on warm stores too (where the
  // inbox wrap fetch above is skipped): missing wraps are fetched by id.
  // Local keys only: a remote signer would need a prompt or round trip per
  // old wrap.
  if (signerType === 'nsec' && (!protocol || protocol === 'nip17') && !signal?.aborted) {
    try {
      const secretKey = await getMemoisedSecretKey(pubkey);
      const filled = secretKey
        ? await backfillThreadRumorIds({
            owner: pubkey,
            conversation: normalized,
            wraps: kind1059,
            // No relays yet (prefs still loading): no lookup, so the rows stay
            // retryable on a later open instead of being marked as asked.
            ...(readRelays.length > 0
              ? { fetchWraps: (ids: string[]) => fetchWrapsByIds(ids, readRelays, signal) }
              : {}),
            unwrap: (wrap) => unwrapWrapNsec(wrap, secretKey),
            signal,
          })
        : new Map<string, string>();
      if (filled.size > 0) {
        storedMessages = storedMessages.map((m) =>
          !m.rumorId && filled.has(m.id) ? { ...m, rumorId: filled.get(m.id) } : m,
        );
      }
    } catch (e) {
      if (__DEV__) console.warn('[DmStore] rumor id backfill failed:', e);
    }
  }

  const merged = mergeConversationMessages(
    storedMessages,
    protocol ? filterMessagesByProtocol(decrypted, protocol) : decrypted,
    DM_CONV_CAP,
  );

  // Aborted mid-fetch (Copilot #869): the kind-4 decrypt loop bails between
  // batches, so `decrypted` may omit events the abort skipped — but
  // `kind4Events` still holds them all. Persisting `convLastSeen` from the full
  // `kind4Events` set would advance the per-peer `since` cursor PAST those
  // never-decrypted events, permanently skipping them on the next open. Return
  // the store-backed `merged` (already painted) WITHOUT any cursor write, so an
  // aborted run has no durable side effects.
  if (signal?.aborted) return merged;

  // Single-line perf summary — grep `[Perf] fetchConversation` out
  // of logcat to compare cold-store vs warm-store thread opens.
  // Cold store shows `store=0, fresh=N` — whole inbox decrypted.
  // Warm store shows `store≈N, fresh=0` — all store short-circuits.
  console.log(
    `[Perf] fetchConversation(${normalized.slice(0, 8)}): ` +
      `${(performance.now() - perfStart).toFixed(0)}ms, ` +
      `k4=${kind4Events.length} (ram=${nip04CacheHits}, dbKnown=${nip04DbKnown}, fresh=${nip04FreshDecrypts}, store=${nip04StoreHits}), ` +
      `k1059 (store=${nip17StoreHits}, fresh=${nip17FreshDecrypts}, skippedFetch=${skippedInboxFetch}), ` +
      `since=${convLastSeen ?? 0}, ` +
      `merged=${merged.length}`,
  );

  // Persist the new per-peer last-seen so the next open of THIS thread sees
  // only the delta. A bare timestamp — the messages themselves live ONLY in
  // the encrypted store now (#850; the plaintext conv-blob write is gone).
  // kind-1059 deliberately excluded — wrap timestamps are randomized per
  // NIP-59 and would poison the kind-4 since cursor (same reasoning as the
  // inbox path; see fetchInboxDmEvents + refreshDmInbox).
  const newConvLastSeen = Math.max(convLastSeen ?? 0, ...kind4Events.map((e) => e.created_at));
  if (newConvLastSeen > (convLastSeen ?? 0)) {
    AsyncStorage.setItem(convLastSeenKey(pubkey, normalized), String(newConvLastSeen)).catch(
      () => {},
    );
  }

  return merged;
}
