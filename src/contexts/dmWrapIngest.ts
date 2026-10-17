import { isChatReactionKind } from '../utils/nip17Reactions';
import { placeOwnChatReaction } from './chatReactionPartner';
import { admitOrderLifecycle, admitUnfollowedOrder, isBoundedOrderRumor } from './orderRumorIngest';
import { getAppFormatLocale } from '../utils/appFormatLocale';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import {
  partnerFromRumor,
  textForRumor,
  rumorEventId,
  type DecodedRumor,
} from '../utils/nip17Unwrap';
import { dmRowPreview } from '../utils/dmRowPreview';
import { parsePlainFileAttachment } from '../utils/fileAttachment';
import { liveMarkerPhaseOf } from '../services/liveLocationService';
import {
  acceptOrderRumor,
  completeOrderRumors,
  releaseOrderRumors,
} from '../services/orderAdmission';
import { ingestWraps, type IngestableWrap } from '../services/dmIngest';
import type { DmMessageRow } from '../services/dmDb';
import { tryRouteGroupRumor } from './nostrGroupRouting';
import { createYieldScheduler, NIP17_LOOP_YIELD_EVERY } from './nostrDecryptPacing';
import { loadNip17SkipSet, writeNip17SkipSet } from './nostrDmCache';
import { routeMarmotWelcome } from '../services/marmotWelcomeRouter';
import { routeNip171Rumor } from './nip171InboxRouting';

// The one NIP-17 inbox-wrap ingest engine (#848). Both refreshDmInbox signer
// branches (nsec + Amber) and the cold thread-open path in
// nostrFetchConversation used to carry near-identical decrypt loops, each
// read-modify-writing the plaintext wrap-cache file. They now all run through
// here: dmIngest's decrypt-once gate (one indexed query against the encrypted
// DB) decides what to decrypt, the decryptor below applies the #743 skip-set
// and the group-route / follow-gate policy, and dmIngest batch-upserts the
// fresh rows into the encrypted DB. No plaintext touches a file anywhere in
// this path.

export interface InboxWrapIngestParams<W extends IngestableWrap> {
  /** Signed-in account pubkey — scopes the decrypt-once gate + stored rows. */
  owner: string;
  wraps: readonly W[];
  /** Signer-specific unwrap (nsec sync, Amber IPC). Throwing = skip the wrap. */
  unwrap: (wrap: W) => Promise<DecodedRumor | null> | DecodedRumor | null;
  /** The parental-control follow gate (B1). Pass `() => true` to store every
   * decrypted 1:1 rumor (the thread-open path, where the user explicitly
   * opened a conversation). */
  passesFollowGate: (pk: string) => boolean;
  /** Actual follows, independent of permissive DM/WoT or thread-open policy. */
  isFollowed?: (pk: string) => boolean;
  /** Per-account skip-set file key (#743). Omit on the thread-open path,
   * which never consulted or wrote the skip-set. */
  skipKey?: string;
  /** User-intent refresh (#743/#846): re-evaluate skip-set wraps. */
  bypassSkipSet?: boolean;
  /** First refresh of the session — swaps RAF yields for macro-task yields
   * (#788) inside the pacing scheduler. */
  isColdStart?: boolean;
  signal?: AbortSignal;
  /** Amber inbox refresh: a PERMISSION_NOT_GRANTED from the silent decrypt
   * path stops further decrypt attempts (one flag, no per-wrap dialog flood)
   * instead of being treated as an ordinary skip. */
  stopOnPermissionDenied?: boolean;
  /** Dev breadcrumb for unwrap skips, matching the old per-branch onSkip. */
  onSkip?: (reason: string, wrapId: string) => void;
}

export interface InboxWrapIngestResult {
  /** Followed 1:1 entries newly decrypted this run (DB-known wraps are NOT
   * re-emitted — the caller merges `loadInboxEntries` for those). */
  entries: DmInboxEntry[];
  /** Wraps short-circuited by the encrypted DB's decrypt-once gate. */
  alreadyKnown: number;
  /** Wraps short-circuited by the #743 skip-set. */
  skipHits: number;
  /** Fresh decrypt attempts (cache + skip-set misses). */
  misses: number;
  /** Rows persisted to the encrypted DB this run. */
  stored: number;
  /** Pacing yields performed (perf log). */
  yields: number;
  permissionDenied: boolean;
}

const isPermissionNotGranted = (error: unknown): boolean => {
  const code = (error as { code?: string })?.code;
  const message = (error as Error)?.message ?? '';
  return (
    code === 'PERMISSION_NOT_GRANTED' ||
    /PERMISSION_NOT_GRANTED/.test(message) ||
    // NIP-46 bunkers: the service normalises permission rejections to
    // `NIP-46 signer denied <method>` (nostrConnectService.wrapPermissionError).
    // Match it so a bunker that denied nip44_decrypt drains-and-stops like
    // Amber rather than re-trying every wrap on every refresh.
    /NIP-46 signer denied/i.test(message)
  );
};

/**
 * Decrypt-once ingest of kind-1059 inbox wraps into the encrypted DM store.
 * Order of gates per wrap: DB known-id (inside ingestWraps) → skip-set →
 * decrypt → Welcome-route → group-route → order-store exception → follow-gate.
 * Group-routed and non-followed free-text rumors
 * are added to the skip-set exactly as before (#743). An aborted run PERSISTS
 * the DM rows it already decrypted (idempotent + owner-keyed, so a cut-short
 * post-login rebuild isn't wasted — F1/#849), but suppresses skip-set growth
 * and emitted entries (partial session state #412 intentionally drops).
 */
export async function ingestInboxWraps<W extends IngestableWrap>(
  params: InboxWrapIngestParams<W>,
): Promise<InboxWrapIngestResult> {
  return ingestInboxWrapsRun(params, true);
}

async function ingestInboxWrapsRun<W extends IngestableWrap>(
  params: InboxWrapIngestParams<W>,
  retryLifecycle: boolean,
): Promise<InboxWrapIngestResult> {
  const deferred: { wrap: W; rumor: DecodedRumor }[] = [];
  const { owner, wraps, unwrap, passesFollowGate, skipKey, signal } = params;
  const entries: DmInboxEntry[] = [];
  const admittedOrders: DecodedRumor[] = [];
  const claimedOrders = new Set<DecodedRumor>();
  let skipHits = 0;
  let misses = 0;
  let permissionDenied = false;
  let skipSetDirty = false;
  const skipSet = skipKey ? await loadNip17SkipSet(skipKey) : new Set<string>();
  const skipOrderWrap = (id: string): null => {
    if (skipKey) {
      skipSet.add(id);
      skipSetDirty = true;
    }
    return null;
  };
  // Frame-budget pacing (#532) + cold-start macro-task yields (#788). Runs
  // inside the decryptor so only fresh decrypts pay for yields — DB-known
  // wraps are a Set lookup in ingestWraps and need no pacing.
  const sched = createYieldScheduler({
    signal,
    safetyEvery: NIP17_LOOP_YIELD_EVERY,
    coldStart: params.isColdStart === true,
  });

  let ingestResult = { ingested: 0, alreadyKnown: 0, undecryptable: 0 };
  try {
    ingestResult = await ingestWraps(
      owner,
      wraps,
      async (wrap): Promise<DmMessageRow | null> => {
        await sched.maybeYield();
        if (signal?.aborted) return null;
        // Skip-set hit: previously decrypted, produced no inbox entry (group
        // rumor / non-followed sender) — short-circuit without re-paying the
        // schnorr + NIP-44 cost. Bypassed only on user-intent refreshes (#743).
        if (params.bypassSkipSet !== true && skipSet.has(wrap.id)) {
          skipHits++;
          return null;
        }
        // After an Amber permission denial, drain the remaining wraps without
        // further IPC attempts — they'd all fail the same way this refresh.
        if (permissionDenied) return null;
        misses++;
        let rumor: DecodedRumor | null;
        try {
          rumor = await unwrap(wrap);
        } catch (error) {
          if (params.stopOnPermissionDenied && isPermissionNotGranted(error)) {
            permissionDenied = true;
            if (__DEV__) {
              console.log('[Nostr] Amber NIP-44 permission not granted — stopping NIP-17 unwrap');
            }
            return null;
          }
          params.onSkip?.((error as Error)?.message ?? 'unwrap threw', wrap.id);
          return null;
        }
        if (!rumor) return null;
        // Welcomes belong to the encrypted consent inbox before DM policy.
        if (
          await routeMarmotWelcome(
            rumor,
            owner,
            wrap.id,
            params.isFollowed?.(rumor.pubkey?.toLowerCase() ?? '') ?? false,
            Math.abs(Date.now() / 1000 - rumor.created_at) <= 120,
            () => signal?.aborted === true,
          )
        ) {
          // Only AFTER encrypted invitation persistence succeeds. A v2 skip
          // is a handled Welcome, unlike the legacy v1 follow-gate drops.
          if (skipKey) {
            skipSet.add(wrap.id);
            skipSetDirty = true;
          }
          return null;
        }
        // NIP-171 tickets and group rumors: not 1:1 DMs (nip171InboxRouting).
        let nip171: boolean;
        try {
          nip171 = await routeNip171Rumor(rumor, owner);
        } catch (e) {
          // Storing a ticket failed: leave the wrap for the next refresh
          // rather than stop this run or file it as a 1:1 DM.
          if (__DEV__) console.warn('[NIP-171] inbox routing failed:', e);
          return null;
        }
        if (nip171) {
          if (skipKey) {
            skipSet.add(wrap.id);
            skipSetDirty = true;
          }
          return null;
        }
        // Multi-recipient group rumors also bypass the DM follow gate.
        const routeResult =
          rumor.kind === 16 || rumor.kind === 17
            ? { kind: 'not-group' as const }
            : await tryRouteGroupRumor(
                rumor,
                owner,
                wrap.id,
                () => signal?.aborted === true,
                passesFollowGate,
              );
        if (routeResult.kind !== 'not-group') {
          if (skipKey) {
            skipSet.add(wrap.id);
            skipSetDirty = true;
          }
          return null;
        }
        const partnership = await placeOwnChatReaction(
          rumor,
          owner,
          partnerFromRumor(rumor, owner),
        );
        if (!partnership) return null;
        // B1 — free-text non-follows stay gated. Valid bounded orders
        // persist independently for Orders, but Messages keeps the gate. A
        // successful decrypt with no stored row goes to the skip-set so the
        // next refresh doesn't re-pay it; pull-to-refresh (force) bypasses
        // the CHECK above so a newly-followed sender's wraps re-evaluate (#745).
        const showInMessages = passesFollowGate(partnership.partnerPubkey);
        const orderRumor = isBoundedOrderRumor(rumor);
        if ((rumor.kind === 16 || rumor.kind === 17) && !orderRumor) return skipOrderWrap(wrap.id);
        if (
          orderRumor &&
          !(await admitOrderLifecycle(owner, partnership.partnerPubkey, partnership.fromMe, rumor))
        ) {
          if (retryLifecycle) deferred.push({ wrap, rumor });
          return null;
        }
        if (!showInMessages && !orderRumor) {
          if (skipKey) {
            skipSet.add(wrap.id);
            skipSetDirty = true;
          }
          return null;
        }
        const followed = params.isFollowed?.(partnership.partnerPubkey) ?? showInMessages;
        if (!followed && (rumor.kind === 16 || rumor.kind === 17)) {
          // A transient rate-limit rejection must remain retryable; sent copies use no budget.
          if (!partnership.fromMe && !admitUnfollowedOrder(owner)) return null;
        }
        if (
          !(await acceptOrderRumor(owner, rumor, partnership.fromMe, () => {
            skipOrderWrap(wrap.id);
          }))
        )
          return null;
        if (orderRumor && !partnership.fromMe) claimedOrders.add(rumor);
        const text = textForRumor(rumor);
        // For a structured rumor (order kind 16/17, or an NWC wallet share) the
        // stored `text` is non-human JSON — the in-memory inbox preview must show
        // a readable, SECRET-FREE summary, never the raw blob (an NWC share's
        // content is a bearer connection string). The stored row keeps the raw
        // JSON below so the thread renderer + dmInbox projection re-derive from
        // it. Plain DM rumors pass through unchanged.
        const preview = dmRowPreview(text, rumor.kind, getAppFormatLocale());
        // Inner rumor id — the cross-peer-stable id BOTH sides see for the
        // same logical message. For our own sent rows (fromMe) it's the
        // delivery-store key (#857); for received rows it's the NIP-25
        // reaction / per-message zap target (#205). Computed for both
        // directions now — the delivery reconcile is gated on `fromMe`
        // (useDmDeliveryStatuses), so a received row carrying a rumorId
        // never picks up a spurious delivery tick. Hashing is defensive: a
        // malformed rumor (bad/short pubkey) degrades to no rumorId — the
        // message just won't be reaction-targetable — rather than aborting
        // the whole decrypt batch.
        let rumorId: string | undefined;
        try {
          rumorId = rumorEventId(rumor);
        } catch {
          rumorId = undefined;
        }
        // A reaction / retraction is stored for its target's thread but is
        // never an inbox entry or a bubble (#1321).
        if (showInMessages && !isChatReactionKind(rumor.kind))
          entries.push({
            id: wrap.id,
            partnerPubkey: partnership.partnerPubkey,
            fromMe: partnership.fromMe,
            createdAt: rumor.created_at,
            text: preview,
            // Order payloads stay in the encrypted store (#1550). Document
            // links and kind-15 attachments need their content on the first thread load.
            ...(rumor.kind === 15 ||
            (rumor.kind === 14 && parsePlainFileAttachment(text) !== null) ||
            liveMarkerPhaseOf(text)
              ? { renderText: text }
              : {}),
            wireKind: rumor.kind,
            rumorId,
          });
        if (orderRumor && !partnership.fromMe) admittedOrders.push(rumor);
        return {
          owner,
          eventId: wrap.id,
          conversation: partnership.partnerPubkey,
          createdAt: rumor.created_at,
          sender: partnership.fromMe ? owner : partnership.partnerPubkey,
          content: text,
          fromMe: partnership.fromMe,
          wireKind: rumor.kind,
          // Both directions (#1320): a received message needs it to be reacted
          // to, and a stored reaction needs it so a kind 5 can retract it.
          ...(rumorId ? { rumorId } : {}),
        };
      },
      // Pacing is the scheduler above; disable ingestWraps' count-based yield.
      { yieldEvery: 0, signal },
    );

    // Completion releases these claims itself; do not release a later retry claim.
    for (const rumor of admittedOrders) claimedOrders.delete(rumor);
    await completeOrderRumors(owner, admittedOrders);
  } finally {
    releaseOrderRumors(owner, [...claimedOrders]);
    sched.dispose();
  }

  // Persist skip-set growth only for completed runs. The skip-set's invariant
  // is "entry ⇒ decrypt was paid AND produced no stored row"; an aborted run
  // only walked part of the wraps, so its partial skip-set is incomplete and
  // could mask a not-yet-evaluated followed sender on the retry. (DM rows DO
  // persist on abort — ingestWraps flushes them — but a stored row and a
  // skip-set entry are mutually exclusive per wrap, so there's no conflict.)
  if (skipSetDirty && skipKey && !signal?.aborted) {
    await writeNip17SkipSet(skipKey, skipSet);
  }

  // The first pass persists placed orders before resolving their updates.
  // Reuse decoded rumors: relay ordering is arbitrary and crypto is expensive.
  const retried =
    deferred.length > 0 && !signal?.aborted
      ? await ingestInboxWrapsRun(
          {
            ...params,
            wraps: deferred.map(({ wrap, rumor }) => ({ ...wrap, decoded: rumor })),
            unwrap: (wrap) => wrap.decoded,
          },
          false,
        )
      : undefined;

  return {
    entries: signal?.aborted ? [] : [...entries, ...(retried?.entries ?? [])],
    alreadyKnown: ingestResult.alreadyKnown,
    skipHits,
    misses,
    stored: ingestResult.ingested + (retried?.stored ?? 0),
    yields: sched.yieldCount + (retried?.yields ?? 0),
    permissionDenied,
  };
}
