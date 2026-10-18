import { selectRowsMissingRumorId, setDmRumorIds } from '../services/dmDb';
import { pool } from '../services/nostrPool';
import { querySyncAbortable } from '../services/relayQuery';
import { activeAccountRelays } from '../services/testRelayRouting';
import type { RawGiftWrapEvent } from '../services/nostrService';
import { rumorEventId, type DecodedRumor } from '../utils/nip17Unwrap';
import { createYieldScheduler } from './nostrDecryptPacing';

/** Most rows one thread open backfills. Newest first, so the visible ones go first. */
export const RUMOR_ID_BACKFILL_CAP = 100;

// Wraps already asked for this session, by owner. One no relay still holds
// would otherwise be fetched again on every open of its thread.
const requested = new Map<string, Set<string>>();

/** A lookup's wraps, and whether every relay asked answered it. */
export interface WrapLookup {
  wraps: RawGiftWrapEvent[];
  complete: boolean;
}

/**
 * Gift wraps by event id. A wrap id is public (it's the outer event, already
 * addressed to us), so this reveals nothing a relay doesn't know.
 */
export async function fetchWrapsByIds(
  ids: string[],
  relays: string[],
  signal?: AbortSignal,
): Promise<WrapLookup> {
  if (ids.length === 0 || relays.length === 0) return { wraps: [], complete: true };
  const completedRelays = new Set<string>();
  const events = await querySyncAbortable(
    pool,
    relays,
    { kinds: [1059], ids, limit: ids.length },
    // Rejects when no relay answers (offline, all timed out), so the caller
    // releases the ids for a later open instead of treating them as gone.
    { maxWait: 4000, signal, completedRelays },
  );
  // Only some relays answered: a wrap missing here may be on one that didn't.
  const complete = completedRelays.size >= new Set(activeAccountRelays(relays)).size;
  return { wraps: events as RawGiftWrapEvent[], complete };
}

/**
 * Fill in the rumor id (#1320) on a thread's NIP-17 rows stored before
 * received rows carried one. Without it an old message can't be reacted to,
 * and a peer's reaction to it can't be matched.
 *
 * Wraps the thread open already fetched are reused; the rest of the missing
 * rows' wraps are fetched by id (`fetchWraps`). At most
 * {@link RUMOR_ID_BACKFILL_CAP} rows, yielding between decrypts. A wrap that
 * is gone or no longer decrypts is skipped. Returns the ids it filled, by
 * wrap id.
 */
export async function backfillThreadRumorIds(params: {
  owner: string;
  conversation: string;
  wraps: readonly RawGiftWrapEvent[];
  fetchWraps?: (ids: string[]) => Promise<WrapLookup>;
  unwrap: (wrap: RawGiftWrapEvent) => Promise<DecodedRumor | null> | DecodedRumor | null;
  signal?: AbortSignal;
}): Promise<Map<string, string>> {
  const { owner, conversation, unwrap, signal } = params;
  const filled = new Map<string, string>();
  const asked = requested.get(owner) ?? new Set<string>();
  requested.set(owner, asked);
  // Read past the wraps already asked for this session, so a run of ones no
  // relay holds any more can't keep older, available ones from being reached.
  const rows = await selectRowsMissingRumorId(
    owner,
    conversation,
    RUMOR_ID_BACKFILL_CAP + asked.size,
  );
  const supplied = new Map(params.wraps.map((w) => [w.id, w]));
  const wraps: RawGiftWrapEvent[] = [];
  const toFetch: string[] = [];
  for (const id of rows) {
    if (wraps.length + toFetch.length >= RUMOR_ID_BACKFILL_CAP) break;
    const wrap = supplied.get(id);
    if (wrap) wraps.push(wrap);
    else if (!asked.has(id)) toFetch.push(id);
  }
  if (wraps.length === 0 && toFetch.length === 0) return filled;
  // Asked-for ids are kept only once a lookup completes and its result is
  // saved; a cancelled run, failed read or failed save can try them again.
  const release = () => {
    for (const id of toFetch) asked.delete(id);
  };
  if (toFetch.length > 0 && params.fetchWraps && !signal?.aborted) {
    for (const id of toFetch) asked.add(id);
    const wanted = new Set(toFetch);
    const more = await params.fetchWraps(toFetch).catch(() => {
      release();
      return { wraps: [], complete: true } as WrapLookup;
    });
    for (const w of more.wraps) {
      if (wanted.delete(w.id)) wraps.push(w);
    }
    // A partial lookup can't tell gone from unanswered: ask for those again.
    if (!more.complete) for (const id of wanted) asked.delete(id);
  }
  const sched = createYieldScheduler({ signal, safetyEvery: 8 });
  try {
    for (const wrap of wraps) {
      if (signal?.aborted) break;
      await sched.maybeYield();
      let rumor: DecodedRumor | null;
      try {
        rumor = await unwrap(wrap);
      } catch {
        continue;
      }
      if (!rumor) continue;
      try {
        filled.set(wrap.id, rumorEventId(rumor));
      } catch {
        // A malformed rumor stays without an id, as it would on first ingest.
      }
    }
  } finally {
    sched.dispose();
  }
  if (signal?.aborted) {
    release();
    return new Map();
  }
  try {
    await setDmRumorIds(owner, filled);
  } catch (error) {
    release();
    throw error;
  }
  return filled;
}

export function __resetRumorIdBackfillForTests(): void {
  requested.clear();
}
