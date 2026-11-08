import type React from 'react';
import { InteractionManager } from 'react-native';
import type { RefreshDmInboxOptions } from './nostrContextTypes';

/**
 * Schedule the cold-start inbox backfill (#751).
 *
 * The first refresh of a session fetches only a recent slice of wraps
 * (COLD_INITIAL_WRAP_LIMIT) so the Messages tab paints fast instead of blocking
 * the JS thread on the full backlog ingest (~12 s for 508 wraps × 5 relays).
 * This tops up to the full backlog afterwards — but in the background:
 *
 *  - deferred via `runAfterInteractions` so it never blocks the tab transition;
 *  - carrying the original `signal`, so a tab-blur cancels it (the in-flight
 *    relay subscription closes via the quorum read in fetchInboxDmEvents);
 *  - with `backfill: true`, which bypasses only the freshness TTL (the capped
 *    first pass just stamped the cursor) and fetches the full wrap limit, but
 *    does not itself bypass the #743 skip-set (when the dev follow gate is
 *    off, `includeNonFollows` still bypasses it — by design, so non-followed
 *    wraps aren't hidden) and RESPECTS the kind-4 `since` floor. It used to run
 *    as `force: true`, inheriting pull-to-refresh's cache bypasses — which
 *    re-decrypted the whole skip-set (~510 wraps) plus the full kind-4 backlog
 *    (~212 events; the NIP-04 plaintext cache is memory-only) on EVERY cold
 *    start: the 28-30 s circuit-1 freeze (#846). The first pass stamping the
 *    cursor is also what marks this pass non-cold, so it can never recurse.
 *
 * `refreshRef` (rather than the callback directly) keeps the caller from having
 * to list refreshDmInbox as its own dependency.
 */
export function scheduleColdStartBackfill(args: {
  isColdStart: boolean;
  signal?: AbortSignal;
  includeNonFollows: boolean;
  refreshRef: React.MutableRefObject<((opts?: RefreshDmInboxOptions) => Promise<void>) | null>;
}): void {
  if (!args.isColdStart || args.signal?.aborted) return;
  InteractionManager.runAfterInteractions(() => {
    // Re-check: the signal may have aborted between scheduling and now (e.g. a
    // tab blur during the interaction window). Skip so we don't toggle loading
    // state or advance the refresh TTL for a backfill the user no longer wants
    // (#752 Copilot). fetchInboxDmEvents would also short-circuit, but bailing
    // here avoids the wasted refreshDmInbox setup entirely.
    if (args.signal?.aborted) return;
    void args.refreshRef.current?.({
      backfill: true,
      includeNonFollows: args.includeNonFollows,
      signal: args.signal,
    });
  });
}
