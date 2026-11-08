import { isFollowed } from '../utils/followPubkeys';
import type { DecodedRumor } from '../utils/nip17Unwrap';
import type { DmInboxEntry } from '../utils/conversationSummaries';

// Account-owned, bounded recovery during follow reconciliation (#851 / #1458).
// Both kind-4 and kind-1059 hold decrypted inbox previews in memory while
// follows load. Backlog replays silently; only fresh inbound carries a
// notification. No ciphertext or secrets are persisted by this buffer.
// Cached friends can replay after the offline timeout; unmatched entries
// remain recoverable until reconciliation completes (which clears strangers).
// Subscription teardown retains pending entries; identity teardown clears them.

export interface DeferredFollowGateEntry {
  partnerPubkey: string;
  entry: DmInboxEntry;
  // A two-party chat must be re-routed after trust hydrates: a preceding
  // subject-tagged rumor may establish its room. Preserve the original tags.
  groupRumor?: DecodedRumor;
  /** Original decrypted body; the inbox preview may redact structured content. */
  content?: string;
  /** Full invitation needed by the Marmot router on release. */
  rumor?: DecodedRumor;
  /** Release an unpersisted dedup claim when bounded recovery evicts this item. */
  onEvict?: () => void;
  // Notification payload to (re)fire if the partner becomes followed.
  // Undefined for own echoes / non-fresh arrivals that should stay silent.
  notify?: { title: string; body: string };
}

export interface LiveSubFollowGateBuffer {
  // Buffer an inbound deferred while follows reconcile.
  defer: (item: DeferredFollowGateEntry) => void;
  // Re-test buffered entries against the now-current follows. Entries that
  // pass are removed and handed to `onPass` (newest-last); the rest stay
  // buffered in case follows are still partially hydrated.
  reevaluate: (follows: Set<string>, onPass: (item: DeferredFollowGateEntry) => void) => void;
  // Drop strangers after reconciliation (each handed to `onDrop`, which may
  // still notify per the Web of Trust tier), or everything on account
  // switch/sign-out (no `onDrop`).
  clear: (onDrop?: (item: DeferredFollowGateEntry) => void) => void;
  /** Earliest deferred kind-4 timestamp, retained across drains and re-opens. */
  readonly kind4RecoverySince?: number;
  // Test/observability hook.
  readonly size: number;
}

// Bound memory even when reconciliation is slow or never completes offline.
export const FOLLOW_GATE_DEFER_CAP = 50;

export function createLiveSubFollowGateBuffer(
  cap: number = FOLLOW_GATE_DEFER_CAP,
): LiveSubFollowGateBuffer {
  // Keyed by inbox-entry id so a wrap delivered twice (multi-relay) only
  // buffers once and a later real ingest can't double-replay it.
  const deferred = new Map<string, DeferredFollowGateEntry>();
  // One timestamp bounds recovery metadata even after overflow. Keep it for
  // this account store lifetime: a newer persisted cursor cannot prove that
  // all older evicted or cancelled messages were recovered.
  let kind4RecoverySince: number | undefined;
  return {
    defer(item) {
      if (item.entry.wireKind === 4) {
        kind4RecoverySince = Math.min(kind4RecoverySince ?? Infinity, item.entry.createdAt);
      }
      if (deferred.has(item.entry.id)) return;
      // Evict oldest (insertion-order) when at cap so the buffer stays bounded.
      if (deferred.size >= cap) {
        const oldest = deferred.keys().next().value;
        if (oldest !== undefined) {
          const evicted = deferred.get(oldest);
          deferred.delete(oldest);
          evicted?.onEvict?.();
        }
      }
      deferred.set(item.entry.id, item);
    },
    reevaluate(follows, onPass) {
      if (deferred.size === 0) return;
      for (const [id, item] of deferred) {
        if (isFollowed(follows, item.partnerPubkey)) {
          deferred.delete(id);
          onPass(item);
        }
      }
    },
    clear(onDrop) {
      const dropped = onDrop ? [...deferred.values()] : [];
      deferred.clear();
      for (const item of dropped) onDrop?.(item);
    },
    get kind4RecoverySince() {
      return kind4RecoverySince;
    },
    get size() {
      return deferred.size;
    },
  };
}
