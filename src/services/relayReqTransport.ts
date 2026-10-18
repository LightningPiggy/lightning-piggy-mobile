import { authenticateRelay } from './relayAuth';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';

type Params = Parameters<AbstractSimplePool['subscribeMap']>[1];
/** Close the physical REQ synchronously, and prevent late connection/AUTH
 * completions from sending a REQ after its budget slot has been released. */
export function openRelayReq(
  pool: Pick<AbstractSimplePool, 'ensureRelay' | 'seenOn' | 'trackRelays'>,
  url: string,
  filters: Parameters<AbstractSimplePool['subscribe']>[1][],
  params: Params & { onReqOpen?: () => void; eoseTimeout?: number },
  connectedRelay?: Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>,
) {
  let stopped = false;
  let sub: { close(reason?: string): void } | undefined;
  const fail = (error: unknown) => {
    if (!stopped) params.onclose?.([error instanceof Error ? error.message : String(error)]);
  };
  const connected = (relay: Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>) => {
    const arm = (authenticated = false) => {
      if (stopped) return;
      let retired = false;
      params.onReqOpen?.();
      sub = relay.subscribe(filters, {
        ...params,
        abort: undefined, // the budget handle owns cancellation, not the SDK's onabort field
        eoseTimeout: params.eoseTimeout ?? params.maxWait,
        oneose: () => {
          if (!stopped && !retired) params.oneose?.();
        },
        onevent: (event) => {
          if (!stopped && !retired) params.onevent?.(event);
        },
        receivedEvent: (source, id) => {
          if (stopped || retired) return;
          if (pool.trackRelays) {
            const seen = pool.seenOn.get(id) ?? new Set();
            seen.add(source);
            pool.seenOn.set(id, seen);
          }
          params.receivedEvent?.(source, id);
        },
        onclose: (reason) => {
          if (stopped || retired) return;
          retired = true; // SDK CLOSED leaves the old EOSE timer alive
          sub = undefined; // CLOSED/socket close already retired this physical sub
          if (!authenticated && /^(?:ERROR:\s*)?auth-required:/i.test(reason))
            void authenticateRelay(relay)
              .then(() => arm(true))
              .catch(fail);
          else params.onclose?.([reason]);
        },
      });
      if (stopped) sub.close('request already finished');
    };
    arm();
  };
  if (connectedRelay) connected(connectedRelay);
  else void pool.ensureRelay(url, { connectionTimeout: 5000 }).then(connected).catch(fail);
  return {
    close: (reason?: string) => {
      stopped = true;
      const current = sub;
      sub = undefined;
      current?.close(reason);
    },
  };
}
