import { activeAccountRelays } from './testRelayRouting';
import { reqLabel, type ReqOptions } from './relayReqBudget';
import type { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { finishAfterRelayReceive } from './nostrRelayReceiveQueue';

/**
 * Abortable variant of `pool.querySync`. nostr-tools' `querySync` collects
 * events until EOSE but its public *type* omits the `abort` param — even though
 * the implementation forwards it down to `subscribe`, which closes the sub on
 * abort (see nostr-tools pool.js). This typed wrapper exposes that: the promise
 * resolves with whatever has arrived when EOSE fires, the `maxWait` deadline's
 * receive backlog drains, OR `signal` aborts (which closes immediately).
 *
 * That last case is the point — it lets a screen cancel an in-flight inbox
 * fetch on tab-blur/unmount instead of the JS thread chewing through the full
 * wrap backlog after the user has already navigated away (#751: the abort was
 * plumbed to refreshDmInbox but never reached the relay subscription, so
 * nav-away still waited the full fetch). The pool is passed in (rather than
 * imported) to keep this a leaf module with no dependency back on nostrService.
 */
export function querySyncAbortable(
  pool: Pick<SimplePool, 'subscribeMany'>,
  relays: string[],
  filter: Filter,
  params: {
    maxWait?: number;
    signal?: AbortSignal;
    rejectOnAllRelaysFailure?: boolean;
    rejectOnTimeout?: boolean;
    /** Collect only completed relay snapshots; callers reuse this set for pagination. */
    completedRelays?: Set<string>;
  },
): Promise<NostrEvent[]> {
  relays = activeAccountRelays(relays);
  if (params.completedRelays) {
    const completed = params.completedRelays;
    completed.clear();
    return Promise.allSettled(
      [...new Set(relays)].map(async (relay) => {
        const events = await querySyncAbortable(pool, [relay], filter, {
          ...params,
          completedRelays: undefined,
          rejectOnAllRelaysFailure: true,
          rejectOnTimeout: true,
        });
        if (params.signal?.aborted) return [];
        completed.add(relay);
        return events;
      }),
    ).then((results) => {
      if (!completed.size && !params.signal?.aborted)
        throw new Error('No relay completed the query');
      const events = new Map<string, NostrEvent>();
      for (const result of results)
        if (result.status === 'fulfilled')
          for (const event of result.value) events.set(event.id, event);
      return [...events.values()];
    });
  }
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    // SimplePool already de-dupes across relays (`_knownIds`), but this is
    // the one shared read path for reviews / comments / shipping / inbox — a
    // belt-and-braces Set keeps every caller free of duplicate rows/counts.
    const seen = new Set<string>();
    if (params.signal?.aborted || relays.length === 0) {
      resolve(events);
      return;
    }
    let settled = false;
    let closer: { close: (reason?: string) => void } | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      params.signal?.removeEventListener('abort', onAbort);
      try {
        closer?.close();
      } catch {
        // sub may already be closing (abort/eose race) — ignore.
      }
      if (error) reject(error);
      else resolve(events);
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });
    // A quiet deadline is not proof that every relay failed: another relay
    // may have served a valid empty result while aggregate EOSE is still pending.
    // Explicit all-relay failures are rejected by onclose below.
    if (params.maxWait !== undefined)
      deadline = setTimeout(
        () =>
          finishAfterRelayReceive(() =>
            finish(
              params.rejectOnTimeout ? new Error('Relay query timed out before EOSE') : undefined,
            ),
          ),
        params.maxWait,
      );
    const queryParams: Parameters<SimplePool['subscribeMany']>[2] & { reqOptions: ReqOptions } = {
      reqOptions: {
        mode: 'oneshot',
        label: reqLabel([filter], 'oneshot'),
        timeoutMs: params.maxWait,
      },
      // Our deadline queues its completion marker first. The pool's SDK timeout
      // also drains through the receive queue (and bounds connection timeouts).
      maxWait: params.maxWait !== undefined ? params.maxWait + 1000 : undefined,
      abort: params.signal,
      onevent(event) {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        events.push(event);
      },
      oneose() {
        // The pool emits aggregate EOSE immediately before aggregate close
        // on failure or budget expiry. Let onclose inspect those reasons first.
        if (params.rejectOnAllRelaysFailure || params.rejectOnTimeout)
          queueMicrotask(() => finish());
        else finish();
      },
      onclose(reasons: (string | { url: string; reason: string })[]) {
        // nostr-tools close reasons, verbatim (abstract-relay.js / pool.js):
        // "connection failed" / "connection timed out" (optionally "relay "-
        // prefixed; never connected), "relay connection closed" + "websocket
        // closed" (the socket dropped after connecting), "auth timed out" (a
        // NIP-42 challenge never completed), and the pool's "connection skipped
        // by allowConnectingToRelay". A relay that
        // REFUSED the query — NIP-42 "auth was required and attempted, but
        // failed…", or a CLOSED with the NIP-01 "auth-required:" /
        // "restricted:" prefixes (including strfry's "ERROR:" wrapper)
        // didn't serve an empty result either.
        // Deliberate closes ("closed by caller", "… closed by us") are NOT
        // failures.
        const allFailed =
          params.rejectOnAllRelaysFailure &&
          !params.signal?.aborted &&
          (events.length === 0 || params.rejectOnTimeout) &&
          reasons.length > 0 &&
          reasons.every((reason) =>
            /^(?:relay )?connection (?:failed|timed out|closed|skipped by allowConnectingToRelay)$|^websocket closed$|^auth timed out$|^auth was required|(^|:\s*)(?:auth-required|restricted):/i.test(
              typeof reason === 'string' ? reason : reason.reason,
            ),
          );
        const timedOut =
          params.rejectOnTimeout &&
          reasons.some(
            (reason) => (typeof reason === 'string' ? reason : reason.reason) === 'query deadline',
          );
        finish(
          allFailed
            ? new Error('All relays failed to connect')
            : timedOut
              ? new Error('Relay query timed out before EOSE')
              : undefined,
        );
      },
    };
    closer = pool.subscribeMany(relays, filter, queryParams);
    // A synchronous callback can finish before the closer is assigned.
    if (settled) {
      try {
        closer?.close();
      } catch {
        /* already closed synchronously */
      }
    }
  });
}
