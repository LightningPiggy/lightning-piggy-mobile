// What a Marmot send can still tell us after it returns (#1656).
//
// A relay that doesn't answer within the publish window is reported as not
// accepting — but the EVENT is still on its way: nostr-tools queues it behind
// the socket's connection and sends it whenever that completes (a slow link,
// or the app backgrounded behind an Amber approval). The relay then stores it,
// and its late OK is dropped. So "no relay acknowledged in time" isn't a
// failure yet; the caller can look for the envelope on the relays later.

import type { MarmotGroup } from '@internet-privacy/marmot-ts';
import { pool } from './nostrPool';
import { getCurrentUserPubkey } from './nostrActiveAccount';

type PublishResults = Awaited<ReturnType<MarmotGroup['submitIntent']>>;

/** `unknown`: no relay completed the read, so absence proves nothing. */
export type MarmotLookup = 'found' | 'absent' | 'unknown';

export interface MarmotSendReceipt {
  /** A relay failed without explicitly refusing it (timed out, connection
   * dropped before the OK), so the event may still have landed. */
  indeterminate: boolean;
  /** Whether a target relay now holds one of the sent kind-445 envelopes. */
  lookup: () => Promise<MarmotLookup>;
}

// Definitely not stored on that relay: it said no (NIP-01's machine-readable
// OK prefixes), or the EVENT never left (no connection, sent on a closed one,
// or skipped as unhealthy — RELAY_SKIPPED_REASON). Anything else — a timeout,
// the socket closing after the EVENT went out — leaves the outcome open.
const NOT_STORED =
  /^(?:Error: (?:pow|blocked|rate-limited|invalid|restricted|mute|error|auth-required|connection failure|relay skipped):|SendingOnClosedConnection\b)/i;
const LOOKUP_WAIT_MS = 6_000;

export function marmotSendReceipt(results: PublishResults): MarmotSendReceipt {
  // Reads route through the active account's relays (test accounts are locked
  // to the test relay), so a look made while another account is active asks
  // somewhere else: it proves nothing about where this send went.
  const account = getCurrentUserPubkey();
  const sameAccount = () => getCurrentUserPubkey() === account;
  const ids = results.flatMap((r) => ('envelope' in r.work ? [r.work.envelope.id] : []));
  const responses = results.flatMap((r) => Object.entries(r.response));
  // Relays that refused it or never got it can't hold it: only ask the rest.
  const relays = [
    ...new Set(
      responses
        .filter(([, res]) => !res.ok && !NOT_STORED.test(String(res.message ?? '')))
        .map(([url]) => url),
    ),
  ];
  return {
    indeterminate: relays.length > 0,
    // Each relay on its own: one that answered empty says nothing about one
    // that couldn't answer. Per relay, a lax read keeps whatever arrived (a
    // match counts even if the relay closed before EOSE); only a read served
    // to EOSE can establish that the relay doesn't hold it.
    lookup: async () => {
      if (ids.length === 0 || relays.length === 0 || !sameAccount()) return 'unknown';
      const holds = (events: { id: string }[]) => events.some((e) => ids.includes(e.id));
      const perRelay = await Promise.all(
        relays.map(async (relay): Promise<MarmotLookup> => {
          const [lax, strict] = await Promise.allSettled([
            pool.querySyncFilters([relay], [{ ids }], LOOKUP_WAIT_MS),
            // Rejects when the relay didn't serve the read to EOSE.
            pool.querySyncFilters([relay], [{ ids }], LOOKUP_WAIT_MS, { requireEose: true }),
          ]);
          if ([lax, strict].some((r) => r.status === 'fulfilled' && holds(r.value))) {
            return 'found';
          }
          return strict.status === 'fulfilled' ? 'absent' : 'unknown';
        }),
      );
      // Switched mid-read: the reads may have gone to the other account's relays.
      if (!sameAccount()) return 'unknown';
      if (perRelay.includes('found')) return 'found';
      return perRelay.every((r) => r === 'absent') ? 'absent' : 'unknown';
    },
  };
}
