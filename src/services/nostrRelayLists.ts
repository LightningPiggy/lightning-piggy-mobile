import { eventAuthorRelays } from './testRelayRouting';
import type { Event, Filter } from 'nostr-tools';
import { pool, trackRelays } from './nostrPool';
import { relayAllowsKind } from './relayKindPolicy';
import { RELAY_SKIPPED_REASON } from './relayHealth';
import { isConnectionFailure } from './nostrDmPublish';

export interface RelayPublishResult {
  url: string;
  ok: boolean;
  /** Relay's reason on rejection (e.g. "rate-limited: …"), or "timed out". */
  message?: string;
  skipped?: 'kind' | 'unhealthy';
}

/**
 * The NEWEST version of a replaceable event (e.g. kind 10002 / 10050) across
 * relays: collect every relay's reply until each finishes (EOSE) or `maxWaitMs`,
 * then pick the latest by created_at (ties: lowest id, per NIP-01). Unlike a
 * first-reply fetch, a fast relay holding an old copy can't win — needed
 * before letting the user edit and republish a list.
 */
export async function fetchLatestReplaceable(
  pubkey: string,
  kind: number,
  relays: string[],
  maxWaitMs = 6_000,
): Promise<Event | null> {
  trackRelays(relays);
  try {
    const events = await pool.querySync(relays, { kinds: [kind], authors: [pubkey] } as Filter, {
      maxWait: maxWaitMs,
    });
    let best: Event | null = null;
    for (const e of events) {
      if (e.pubkey !== pubkey || e.kind !== kind) continue;
      if (
        !best ||
        e.created_at > best.created_at ||
        (e.created_at === best.created_at && e.id < best.id)
      )
        best = e;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Publish an already-signed replaceable event to each relay and report, per
 * relay, whether it was accepted — so the UI can say exactly where the update
 * landed (some relays rate-limit, require payment or silently drop writes).
 */
export async function publishToRelays(
  event: Event,
  relays: string[],
  timeoutMs = 8_000,
  onResult?: (result: RelayPublishResult) => void,
): Promise<RelayPublishResult[]> {
  relays = eventAuthorRelays(relays, event);
  const allowed = await Promise.all(relays.map((url) => relayAllowsKind(url, event.kind)));
  const targets = relays.filter((_, i) => allowed[i]);
  trackRelays(targets);
  const attempts = targets.length ? pool.publish(targets, event) : [];
  let attemptIndex = 0;
  return Promise.all(
    relays.map(async (url, i): Promise<RelayPublishResult> => {
      if (!allowed[i]) {
        const result: RelayPublishResult = {
          url,
          ok: false,
          skipped: 'kind',
          message: `kind ${event.kind} not accepted`,
        };
        onResult?.(result);
        return result;
      }
      const index = attemptIndex++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<RelayPublishResult>((resolve) => {
        timer = setTimeout(() => resolve({ url, ok: false, message: 'timed out' }), timeoutMs);
      });
      const attempt = Promise.resolve(attempts[index]).then(
        // nostr-tools RESOLVES (not rejects) with "connection failure: …" when
        // it can't reach the relay — that's a failure, never an accept.
        (value: unknown): RelayPublishResult =>
          value === undefined
            ? { url, ok: false, message: 'missing publish result' }
            : isConnectionFailure(value)
              ? { url, ok: false, message: value }
              : { url, ok: true },
        (e: unknown): RelayPublishResult => ({
          url,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
          ...((e instanceof Error ? e.message : String(e)) === RELAY_SKIPPED_REASON
            ? { skipped: 'unhealthy' as const }
            : {}),
        }),
      );
      try {
        const result = await Promise.race([attempt, timeout]);
        onResult?.(result);
        return result;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
