import { pool, trackRelays, DM_INBOX_LIMIT, type RawInboxDmEvent } from './nostrService';

// Live sub never looks further back than this — caps cold-start restream
// cost when inboxLastSeen is very stale (e.g. user hasn't opened the app in
// weeks). The bulk fetch (fetchInboxDmEvents) handles deeper backfill on tab
// open.
const DM_LIVE_SUB_MAX_LOOKBACK_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Long-lived kind-4 (NIP-04) + kind-1059 (NIP-17 gift wrap) inbox subscription for the current
 * viewer (#349). Returns a cleanup function.
 *
 * All filters share one REQ per relay so small relay budgets cannot starve
 * gift wraps behind the legacy DM stream. Aggregate EOSE fires once after
 * every relay finishes replaying the combined inbox.
 */
export function subscribeInboxDmsForViewer(input: {
  viewerPubkey: string;
  relays: string[];
  onEvent: (ev: RawInboxDmEvent) => void;
  // Fires once after aggregate EOSE for the combined inbox filters.
  onEose?: () => void;
  // Optional kind-4 `since` cursor (unix seconds). When provided, the kind-4 filter resolves to `clamp(providedSince - 120s, now-7d, now)` — the 120 s safety buffer in case relay clock skew tagged a wrap slightly older than our cursor, the 7-day floor caps cold-start restream when the cursor is very stale, and the `now` cap defends against a future-dated cursor (corrupted persisted value or a wrap with a bad clock) that would otherwise silently miss new DMs until wall-clock catches up. If absent, falls back to the 7-day floor.
  sinceK4?: number;
  // Cap on the kind-1059 backlog the relay re-streams when the sub opens.
  // Wraps can't use a `since` cursor (randomised NIP-59 timestamps), so without
  // a bound the relay replays the FULL wrap history on every arm and nostr-tools
  // parses every event synchronously before our knownWrapIds early-return —
  // re-introducing the cold-start ingest freeze via the live-sub path even when
  // refreshDmInbox capped its own fetch (#751, Copilot review on #752). Defaults
  // to DM_INBOX_LIMIT; callers pass the smaller cold-start limit. New wraps still
  // arrive live after EOSE regardless of this cap, and the deeper backlog is
  // covered by refreshDmInbox's deferred full backfill.
  wrapsLimit?: number;
  // Fires when the combined inbox subscription has CLOSED on every relay
  // (nostr-tools aggregates per-relay closes and calls once with the
  // reasons) — i.e. the caller has gone deaf to new wraps. Added for the
  // background DM watch's self-re-arm (#958): the pool deliberately does
  // NOT auto-reconnect (enableReconnect stays default-false app-wide), so
  // a long-lived caller must react to this itself. NB it also fires on an
  // intentional close via the returned cleanup — callers must guard.
  onWrapsClose?: (reasons: string[]) => void;
  // Native-engine mode (Stage 2 M2 of #1036): the rust-nostr pool owns the
  // kind-1059 filter, so the JS pool must not open a competing wrap sub —
  // only kind-4. `onWrapsClose` then rides
  // kind-4 sub: it is the remaining JS stream, and the
  // self-re-arm (#934/#958) must keep working for it (the engine reconnects
  // its own sockets independently).
  skipWraps?: boolean;
}): () => void {
  trackRelays(input.relays);
  const onevent = (ev: Parameters<typeof input.onEvent>[0]): void => {
    input.onEvent(ev);
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const lookbackFloor = nowSec - DM_LIVE_SUB_MAX_LOOKBACK_SECONDS;
  const requested = input.sinceK4 !== undefined ? Math.max(0, input.sinceK4 - 120) : lookbackFloor;
  // Upper-bound at `nowSec` so a future-dated persisted cursor (or one bumped by a wrap with a bad created_at) doesn't drop us into a `since` in the future where the relay returns nothing.
  const sinceK4 = Math.min(nowSec, Math.max(lookbackFloor, requested));
  // One physical REQ serves the entire inbox, even when the relay allows only
  // one live slot. Keep separate filters so wraps never inherit a since cursor.
  const filters = [
    {
      kinds: [4],
      '#p': [input.viewerPubkey],
      since: sinceK4,
      limit: DM_INBOX_LIMIT,
    },
    ...(!input.skipWraps
      ? [{ kinds: [1059], '#p': [input.viewerPubkey], limit: input.wrapsLimit ?? DM_INBOX_LIMIT }]
      : []),
  ];
  let eosed = false;
  const sub = pool.subscribeMap(
    input.relays.flatMap((url) => filters.map((filter) => ({ url, filter }))),
    {
      onevent,
      oneose: () => {
        if (eosed) return;
        eosed = true;
        input.onEose?.();
      },
      onclose: input.onWrapsClose,
    },
  );
  return () => sub.close();
}
