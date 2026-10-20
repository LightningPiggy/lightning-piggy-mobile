// What a Marmot send can still tell us after it returns (#1656).
//
// A relay that doesn't answer within the publish window is reported as not
// accepting — but the EVENT is still on its way: nostr-tools queues it behind
// the socket's connection and sends it whenever that completes (a slow link,
// or the app backgrounded behind an Amber approval). The relay then stores it,
// and its late OK is dropped. So "no relay acknowledged in time" isn't a
// failure yet; the caller can look for the envelope on the relays later.

import type { MarmotGroup, NostrNetworkInterface } from '@internet-privacy/marmot-ts';

type PublishResults = Awaited<ReturnType<MarmotGroup['submitIntent']>>;

export interface MarmotSendReceipt {
  /** A relay timed out (rather than refusing), so the event may still land. */
  timedOut: boolean;
  /** Whether any target relay now holds one of the sent kind-445 envelopes. */
  isStored: () => Promise<boolean>;
}

const TIMEOUT = /timed? ?out/i;

export function marmotSendReceipt(
  results: PublishResults,
  network: Pick<NostrNetworkInterface, 'request'>,
): MarmotSendReceipt {
  const ids = results.flatMap((r) => ('envelope' in r.work ? [r.work.envelope.id] : []));
  const responses = results.flatMap((r) => Object.entries(r.response));
  const relays = [...new Set(responses.map(([url]) => url))];
  return {
    timedOut: responses.some(([, res]) => !res.ok && TIMEOUT.test(String(res.message ?? ''))),
    isStored: async () =>
      ids.length > 0 &&
      relays.length > 0 &&
      (await network.request(relays, { ids })).some((e) => ids.includes(e.id)),
  };
}
