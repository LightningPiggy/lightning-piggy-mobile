/**
 * Decides how an open 1:1 thread catches up with live traffic.
 *
 * A live message is persisted to the local DM store by the live subscription
 * before (or just after) it is announced, so the thread only needs to re-read
 * the store: a relay round trip per message (two kind-4 queries over every
 * relay, up to 15 s each) bought nothing on a warm store and competed with the
 * live subscriptions for the REQ budget.
 *
 * The one case the store can't cover is a write that never lands (a failed
 * upsert). So a live message that sees no store commit for this thread within
 * `gapMs` counts as a gap, and gets a single relay fetch.
 *
 * Limitation: gap detection is per thread, not per message. Live
 * announcements carry only the peer, not the event id, so any commit to the
 * thread (another message, an own send, a reaction) inside the window counts
 * as covering it: a failed upsert of B can be masked by A's commit. Such a
 * row shows on the next open, refocus or pull-to-refresh. Conversely, a
 * commit slower than `gapMs` (a cold-start backlog) costs one spurious fetch,
 * which is the pre-change behaviour.
 *
 * Live messages and store commits share one coalesced read, so a relay burst
 * costs one store read.
 */
export interface ConversationLiveRefreshOptions {
  /** Re-read the thread from the local store. */
  readStore: () => void;
  /** Fetch the thread from relays (gap fallback only). */
  fetchRelay: () => void;
  /** Off for protocols whose store has no relay fallback (Marmot). */
  trackGaps: boolean;
  coalesceMs?: number;
  /** A commit this recent already covers a live message announced after it. */
  commitGraceMs?: number;
  /** How long a live message may wait for its store commit. */
  gapMs?: number;
  now?: () => number;
}

export interface ConversationLiveRefreshCounts {
  liveMessages: number;
  storeCommits: number;
  storeReads: number;
  gapFetches: number;
}

export interface ConversationLiveRefresh {
  onLiveMessage: () => void;
  onStoreCommit: () => void;
  /** Queue a store read (coalesced with any pending one). */
  scheduleStoreRead: () => void;
  counts: () => ConversationLiveRefreshCounts;
  dispose: () => void;
}

export const LIVE_REFRESH_COALESCE_MS = 150;
export const LIVE_REFRESH_COMMIT_GRACE_MS = 2_000;
export const LIVE_REFRESH_GAP_MS = 8_000;

export function createConversationLiveRefresh({
  readStore,
  fetchRelay,
  trackGaps,
  coalesceMs = LIVE_REFRESH_COALESCE_MS,
  commitGraceMs = LIVE_REFRESH_COMMIT_GRACE_MS,
  gapMs = LIVE_REFRESH_GAP_MS,
  now = Date.now,
}: ConversationLiveRefreshOptions): ConversationLiveRefresh {
  let storeTimer: ReturnType<typeof setTimeout> | undefined;
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCommitAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  const counts: ConversationLiveRefreshCounts = {
    liveMessages: 0,
    storeCommits: 0,
    storeReads: 0,
    gapFetches: 0,
  };

  const scheduleStoreRead = () => {
    if (disposed || storeTimer) return;
    storeTimer = setTimeout(() => {
      storeTimer = undefined;
      if (disposed) return;
      counts.storeReads++;
      readStore();
    }, coalesceMs);
  };

  return {
    scheduleStoreRead,
    onStoreCommit() {
      if (disposed) return;
      counts.storeCommits++;
      lastCommitAt = now();
      clearTimeout(gapTimer);
      gapTimer = undefined;
      scheduleStoreRead();
    },
    onLiveMessage() {
      if (disposed) return;
      counts.liveMessages++;
      scheduleStoreRead();
      if (!trackGaps || gapTimer || now() - lastCommitAt <= commitGraceMs) return;
      gapTimer = setTimeout(() => {
        gapTimer = undefined;
        if (disposed) return;
        counts.gapFetches++;
        fetchRelay();
      }, gapMs);
    },
    counts: () => ({ ...counts }),
    dispose() {
      disposed = true;
      clearTimeout(storeTimer);
      clearTimeout(gapTimer);
    },
  };
}
