import {
  activeAccountRelays,
  activeAccountRelayRequests,
  eventAuthorRelays,
  type RelayConnectionParams,
} from './testRelayRouting';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import {
  RelayReqBudget,
  reqPriority,
  reqLabel,
  isReqLimitError,
  type ReqOptions,
} from './relayReqBudget';
import { openRelayReq } from './relayReqTransport';
import { discoverRelayReqLimit } from './relayReqLimit';
import { finishAfterRelayReceive } from './nostrRelayReceiveQueue';
import { PERF_LOGS_ENABLED } from '../utils/perfLog';
import { normalizeURL } from 'nostr-tools/utils';
import {
  RELAY_CONNECT_TIMEOUT_MS,
  RELAY_SKIPPED_REASON,
  noteNetworkActivity,
  recordRelayFailure,
  recordRelaySuccess,
  recordRelayConnectionObservation,
  recordRelayPublish,
  selectHealthyRelays,
} from './relayHealth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS mixin constructor signature
type PoolClass = abstract new (...args: any[]) => AbstractSimplePool;

/**
 * Makes a nostr-tools pool class stop waiting on relays known to be dead
 * (#1326). Applied to the shared pool (`./nostrPool`) and the market
 * snapshot's pool (`./marketListingsPool`).
 *
 * - Every connection attempt is capped at `RELAY_CONNECT_TIMEOUT_MS` and its
 *   outcome feeds `./relayHealth`, once per physical attempt. Only NEW
 *   connections count as a relay success; a reused open socket proves nothing.
 *   Events and publish OKs on open sockets corroborate that the network works.
 * - Subscriptions (and so `querySync` / `get` / `subscribeMany`) leave out
 *   parked relays, so aggregate EOSE no longer waits on them.
 * - Publishes skip parked relays too. The returned array still lines up with
 *   the `relays` argument: a skipped relay's promise rejects with
 *   `RELAY_SKIPPED_REASON`, so per-relay result reporting keeps working.
 *
 * `selectHealthyRelays` always keeps the healthiest 2 relays of a request,
 * so nothing is ever sent nowhere. Callers that connect relay by relay via
 * `ensureRelay` should pick their URLs with `selectHealthyRelays` themselves.
 */
export function withRelayHealth<TBase extends PoolClass>(Base: TBase) {
  abstract class HealthAware extends Base {
    /** One recorded outcome per physical connection attempt, by relay. */
    private readonly connectAttempts = new Map<string, Promise<void>>();

    private readonly reqBudgets = new Map<string, RelayReqBudget>();
    private readonly observedRelays = new WeakSet<object>();
    private readonly budgetOwners = new Map<string, object>();

    private budget(url: string): RelayReqBudget {
      const key = normalizeURL(url);
      let budget = this.reqBudgets.get(key);
      if (!budget) {
        budget = new RelayReqBudget(key);
        this.reqBudgets.set(key, budget);
        void discoverRelayReqLimit(key).then((max) => {
          if (max) budget?.restrictMax(max);
        });
      }
      return budget;
    }

    /** Override the conservative default with a configured/known relay limit. */
    setRelaySubscriptionLimit(url: string, max: number): void {
      this.budget(url).setMax(max);
    }

    close(urls: string[]): void {
      for (const url of urls) {
        const key = normalizeURL(url);
        this.reqBudgets.get(key)?.dispose();
        this.reqBudgets.delete(key);
        this.budgetOwners.delete(key);
      }
      super.close(urls);
    }

    destroy(): void {
      for (const budget of this.reqBudgets.values()) budget.dispose();
      this.reqBudgets.clear();
      this.budgetOwners.clear();
      super.destroy();
    }

    ensureRelay(
      url: string,
      params?: RelayConnectionParams,
    ): ReturnType<AbstractSimplePool['ensureRelay']> {
      if (!params?.forPublish) url = activeAccountRelays([url])[0];
      let key = url;
      let wasConnected = false;
      try {
        key = normalizeURL(url);
        wasConnected = this.relays.get(key)?.connected === true;
      } catch {
        // Unparseable URL: super.ensureRelay rejects below and we record it.
      }
      const connectionTimeout = Math.min(
        params?.connectionTimeout ?? RELAY_CONNECT_TIMEOUT_MS,
        RELAY_CONNECT_TIMEOUT_MS,
      );
      const startedAt = Date.now();
      const connecting = super.ensureRelay(url, { ...params, connectionTimeout });
      // The SDK registers the relay before awaiting connect(). Claim the budget
      // for it now: a replaced socket (resetTransports) may close only once its
      // drained operations settle, by which time the replacement's REQs are
      // already queued in this budget and must not be disposed with the old one.
      const created = this.relays.get(key);
      if (created) this.budgetOwners.set(key, created);
      const relay = connecting.then((relay) => {
        this.budgetOwners.set(key, relay);
        if (!this.observedRelays.has(relay)) {
          this.observedRelays.add(relay);
          const subscribe = relay.subscribe?.bind(relay);
          if (subscribe)
            relay.subscribe = (filters, params) => {
              const sub = subscribe(filters, params);
              if (reqPriority(filters) === 0 && PERF_LOGS_ENABLED)
                console.log(`[Marmot] inbox armed on ${relay.url}`);
              return sub;
            };
          const previousClose = relay.onclose;
          relay.onclose = () => {
            // The SDK can deliver close twice. An old socket must not retire
            // a replacement budget or invoke its URL-based pool cleanup.
            if (this.budgetOwners.get(key) !== relay) return;
            this.budgetOwners.delete(key);
            const budget = this.reqBudgets.get(key);
            this.reqBudgets.delete(key);
            // The SDK calls onclose before closing its subscriptions. Use its
            // failure reason so budget cleanup cannot turn a dropped read into EOSE.
            budget?.dispose('relay connection closed');
            previousClose?.();
          };
          const previous = relay.onnotice;
          relay.onnotice = (reason) => {
            previous?.(reason);
            if (this.budgetOwners.get(key) === relay) this.reqBudgets.get(key)?.notice(reason);
          };
        }
        return relay;
      });
      // A reused open socket proves nothing either way. Concurrent callers
      // share nostr-tools' single connection promise, so only the caller that
      // started the attempt records its outcome, and an abort by that caller
      // (which rejects every waiter) records nothing.
      if (wasConnected || this.connectAttempts.has(key)) return relay;
      const outcome = relay.then(
        () => {
          recordRelaySuccess(url);
          recordRelayConnectionObservation(url, Date.now() - startedAt);
        },
        (error: unknown) => {
          if (!params?.abort?.aborted) {
            recordRelayFailure(url);
            recordRelayConnectionObservation(url, Date.now() - startedAt, error);
          }
        },
      );
      this.connectAttempts.set(key, outcome);
      void outcome.finally(() => this.connectAttempts.delete(key));
      return relay;
    }

    /** Raw relay consumers (snapshots/reconciliation) share the same slots. */
    subscribeRelay(
      relay: Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>,
      filters: Parameters<typeof relay.subscribe>[0],
      params: Parameters<typeof relay.subscribe>[1] & { reqOptions?: ReqOptions },
      /** The URL the caller connected; the socket is shared per normalised URL. */
      url: string = relay.url,
    ): { close: (reason?: string) => void } {
      let closed = false;
      let generation = 0;
      let handle: ReturnType<RelayReqBudget['add']> | undefined;
      const options = params.reqOptions ?? { mode: 'oneshot', label: reqLabel(filters, 'oneshot') };
      const abort = () => close('aborted');
      const notify = (reason: string) => {
        if (closed) return;
        closed = true;
        params.abort?.removeEventListener('abort', abort);
        params.onclose?.(reason);
      };
      const close = (reason = 'closed by caller') => {
        try {
          handle?.close(reason);
        } finally {
          notify(reason);
        }
      };
      handle = this.budget(url).add(
        reqPriority(filters),
        () => {
          const current = ++generation;
          let ended = false;
          const sub = openRelayReq(
            { ensureRelay: async () => relay, seenOn: this.seenOn, trackRelays: this.trackRelays },
            url,
            filters,
            {
              ...params,
              abort: undefined,
              onevent: (event) => {
                if (!closed && current === generation) {
                  noteNetworkActivity();
                  params.onevent?.(event);
                }
              },
              oneose: () => {
                if (!closed && current === generation) {
                  try {
                    params.oneose?.();
                  } finally {
                    if (options.mode === 'oneshot') close('closed automatically on eose');
                  }
                }
              },
              onclose: (reasons) => {
                const reason = reasons.join('; ');
                ended = true;
                if (closed || current !== generation) return;
                if (isReqLimitError(reason)) queueMicrotask(() => handle?.retry());
                else {
                  handle?.close();
                  notify(reason);
                }
              },
            },
            relay,
          );
          return {
            close: (reason) => {
              generation++;
              if (!ended) sub.close(reason);
            },
          };
        },
        notify,
        options,
      );
      if (closed) handle.close();
      if (!closed) params.abort?.addEventListener('abort', abort, { once: true });
      if (params.abort?.aborted) abort();
      return { close };
    }

    subscribeMap(
      requests: Parameters<AbstractSimplePool['subscribeMap']>[0],
      params: Parameters<AbstractSimplePool['subscribeMap']>[1] & {
        reqOptions?: ReqOptions;
        onReqOpen?: () => void;
      },
    ): ReturnType<AbstractSimplePool['subscribeMap']> {
      requests = activeAccountRelayRequests(requests);
      const keep = new Set(selectHealthyRelays(requests.map((r) => r.url)));
      const healthy = requests.filter((r) => keep.has(r.url));
      const grouped = new Map<string, typeof requests>();
      for (const request of healthy) {
        const key = normalizeURL(request.url);
        grouped.set(key, [...(grouped.get(key) ?? []), { ...request, url: key }]);
      }
      const eosed = new Set<string>();
      const reasons = new Map<string, string>();
      const seen = new Set<string>();
      const delivered = new Set<string>();
      const handles: { close: (reason?: string) => void }[] = [];
      let closed = false;
      let didEose = false;
      let notifiedClose = false;
      const close = (reason = 'closed by caller', deferNotification = true) => {
        if (closed) return;
        closed = true;
        params.abort?.removeEventListener('abort', abort);
        handles.forEach((handle) => handle.close(reason));
        notifyClose(
          [...grouped.keys()].map((url) => reasons.get(url) ?? reason),
          deferNotification,
        );
      };
      const abort = () => close('aborted', false);
      const notifyClose = (errors: string[], deferNotification = false) => {
        if (notifiedClose) return;
        notifiedClose = true;
        closed = true;
        params.abort?.removeEventListener('abort', abort);
        // Match the SDK pool's asynchronous caller-close notification. NIP-46
        // fromURI closes its pairing REQ before marking the handshake successful.
        // Retire the REQ immediately, but let that caller finish before notifying.
        if (deferNotification) void Promise.resolve().then(() => params.onclose?.(errors));
        else params.onclose?.(errors);
      };
      const eose = (url: string) => {
        eosed.add(url);
        if (!didEose && eosed.size === grouped.size) {
          didEose = true;
          params.oneose?.();
        }
      };
      for (const [url, batch] of grouped) {
        const filters = batch.map((r) => r.filter);
        const options = params.reqOptions ?? { mode: 'live', label: reqLabel(filters, 'live') };
        let generation = 0;
        let handle: ReturnType<RelayReqBudget['add']> | undefined;
        handle = this.budget(url).add(
          reqPriority(batch.map((r) => r.filter)),
          () => {
            const current = ++generation;
            const sub = openRelayReq(this, url, filters, {
              ...params,
              alreadyHaveEvent: (id) => {
                if (closed || current !== generation || params.alreadyHaveEvent?.(id)) return true;
                const have = seen.has(id);
                seen.add(id);
                return have;
              },
              onevent: (event) => {
                if (closed || current !== generation || delivered.has(event.id)) return;
                delivered.add(event.id);
                noteNetworkActivity();
                params.onevent?.(event);
              },
              oneose: () => {
                if (!closed && current === generation) {
                  try {
                    eose(url);
                  } finally {
                    if (options.mode === 'oneshot') {
                      handle?.close('closed automatically on eose');
                      reasons.set(url, 'closed automatically on eose');
                      if (reasons.size === grouped.size) notifyClose([...reasons.values()]);
                    }
                  }
                }
              },
              onclose: (errors) => {
                if (closed || current !== generation) return;
                if (errors.some(isReqLimitError)) {
                  queueMicrotask(() => handle?.retry());
                  return;
                }
                reasons.set(url, errors.join('; '));
                handle?.close();
                eose(url);
                if (reasons.size === grouped.size) notifyClose([...reasons.values()]);
              },
            });
            return {
              close: (reason) => {
                generation++;
                sub.close(reason);
              },
            };
          },
          (reason) => {
            reasons.set(url, reason);
            eose(url);
            if (!closed && reasons.size === grouped.size) notifyClose([...reasons.values()]);
          },
          options,
        );
        handles.push(handle);
      }
      if (!closed) params.abort?.addEventListener('abort', abort, { once: true });
      if (params.abort?.aborted) abort();
      if (grouped.size === 0) queueMicrotask(() => close('no healthy relays'));
      return { close };
    }

    /** Snapshots free each relay's slot at EOSE, including slow-relay fan-outs. */
    subscribeEose(
      urls: Parameters<AbstractSimplePool['subscribeEose']>[0],
      filter: Parameters<AbstractSimplePool['subscribeEose']>[1],
      params: Parameters<AbstractSimplePool['subscribeEose']>[2] &
        Pick<Parameters<AbstractSimplePool['subscribeMap']>[1], 'alreadyHaveEvent'> & {
          reqOptions?: ReqOptions;
        },
    ): ReturnType<AbstractSimplePool['subscribeEose']> {
      urls = activeAccountRelays(urls);
      const relays = [...new Set(selectHealthyRelays(urls).map(normalizeURL))];
      const seen = new Set<string>();
      const delivered = new Set<string>();
      const reasons = new Map<string, string>();
      const closers: { close: (reason?: string) => void }[] = [];
      let finished = false;
      for (const url of relays) {
        const timer = setTimeout(
          () => finishAfterRelayReceive(() => sub.close('query deadline')),
          (params.maxWait ?? 10_000) + RELAY_CONNECT_TIMEOUT_MS,
        );
        const sub = this.subscribeMap([{ url, filter }], {
          ...params,
          reqOptions: params.reqOptions ?? {
            mode: 'oneshot',
            label: reqLabel([filter], 'oneshot'),
          },
          // Per-relay subscribeMap calls must share dedup before SDK parsing/verification.
          alreadyHaveEvent: (id) => {
            if (params.alreadyHaveEvent?.(id)) return true;
            const have = seen.has(id);
            seen.add(id);
            return have;
          },
          onevent: (event) => {
            if (delivered.has(event.id)) return;
            delivered.add(event.id);
            params.onevent?.(event);
          },
          oneose: () => {}, // subscribeMap's one-shot lifecycle closes this relay at EOSE
          onclose: (errors) => {
            clearTimeout(timer);
            reasons.set(url, errors.join('; '));
            if (!finished && reasons.size === relays.length) {
              finished = true;
              params.onclose?.([...reasons.values()]);
            }
          },
        });
        closers.push(sub);
      }
      if (!relays.length) queueMicrotask(() => params.onclose?.([]));
      return { close: (reason) => closers.forEach((sub) => sub.close(reason)) };
    }

    /** A multi-filter one-shot sends just one fresh REQ per relay. */
    querySyncFilters(
      urls: string[],
      filters: Parameters<AbstractSimplePool['subscribe']>[1][],
      maxWait: number,
      /** `requireAnswer`: reject an EMPTY read no relay completed (all failed,
       * timed out in the REQ budget, or were skipped), so the caller can tell
       * "nothing published" from "couldn't ask". Timing is unchanged. */
      options: { abort?: AbortSignal; requireEose?: boolean; requireAnswer?: boolean } = {},
    ): Promise<NostrEvent[]> {
      return new Promise((resolve, reject) => {
        const events: NostrEvent[] = [];
        this.subscribeMap(
          urls.flatMap((url) => filters.map((filter) => ({ url, filter }))),
          {
            // Strict recovery must expire before the SDK's synthetic timeout EOSE.
            maxWait: options.requireEose ? maxWait + RELAY_CONNECT_TIMEOUT_MS : maxWait,
            abort: options.abort,
            reqOptions: {
              mode: 'oneshot',
              label: reqLabel(filters, 'oneshot'),
              timeoutMs: options.requireEose ? maxWait : maxWait + RELAY_CONNECT_TIMEOUT_MS,
            },
            onevent: (event) => events.push(event),
            onclose: (reasons) => {
              // A read is authoritative once ANY relay served its history to
              // EOSE. Group relay lists routinely carry a dead, AUTH-gated or
              // slow relay (and the health layer always keeps two), so demanding
              // EOSE from every relay would hold live delivery for ever. Only a
              // read that no relay completed (failed, timed out, skipped) rejects.
              const eosed = reasons.filter((reason) => reason === 'closed automatically on eose');
              if (options.requireEose && !options.abort?.aborted && eosed.length === 0)
                reject(new Error('Group recovery did not reach EOSE: ' + reasons.join('; ')));
              else if (
                options.requireAnswer &&
                !options.abort?.aborted &&
                eosed.length === 0 &&
                events.length === 0
              )
                reject(new Error('No relay answered: ' + reasons.join('; ')));
              else resolve(events);
            },
          },
        );
      });
    }

    publish(
      relays: string[],
      event: NostrEvent,
      params?: Parameters<AbstractSimplePool['publish']>[2],
    ): Promise<string>[] {
      relays = eventAuthorRelays(relays, event);
      const keep = new Set(selectHealthyRelays(relays));
      const kept = relays.filter((r) => keep.has(r));
      // The SDK calls this.ensureRelay asynchronously for writes. Give this
      // operation a facade that carries the write context, without changing
      // the singleton's read routing or mutable connection bookkeeping.
      const publisher = Object.create(this) as this;
      publisher.ensureRelay = (url, options) =>
        this.ensureRelay(url, { ...options, forPublish: true });
      const results = super.publish.call(publisher, kept, event, params).map((p, i) =>
        // nostr-tools RESOLVES a failed connect with "connection failure: …".
        // Turn that into a rejection here, once, so no caller can mistake an
        // unreachable relay for an accepted publish (Promise.any /
        // allSettled callers would otherwise report success). An OK from a
        // relay proves the network works (corroborates failures).
        p
          .then((reason) => {
            if (String(reason).startsWith('connection failure')) throw new Error(String(reason));
            noteNetworkActivity();
            recordRelayPublish(kept[i], event.pubkey, true);
            return reason;
          })
          .catch((error: unknown) => {
            recordRelayPublish(kept[i], event.pubkey, false, error);
            throw error;
          }),
      );
      if (kept.length === relays.length) return results;
      let next = 0;
      return relays.map((r) =>
        keep.has(r) ? results[next++] : Promise.reject(new Error(RELAY_SKIPPED_REASON)),
      );
    }
  }
  return HealthAware;
}
