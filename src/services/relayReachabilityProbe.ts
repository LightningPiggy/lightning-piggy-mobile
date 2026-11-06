import { activeAccountRelays, watchTestRelayLockdown } from './testRelayRouting';
import { closeSocketNowOrOnOpen } from './relaySocketGuard';
import {
  createProbeCache,
  finishProbe,
  PROBE_TIMEOUT_MS,
  type ProbeEvent,
  type ProbeResult,
} from '../utils/relayReachability';

const activeSockets = new Set<WebSocket>();
const activeRelayHttpProbes = new Set<AbortController>();
watchTestRelayLockdown(() => {
  for (const socket of activeSockets) {
    socket.onmessage = socket.onerror = socket.onclose = null;
    closeSocketNowOrOnOpen(socket);
  }
  activeSockets.clear();
  for (const controller of activeRelayHttpProbes) controller.abort();
  activeRelayHttpProbes.clear();
});

export const reachabilityCache = createProbeCache();
// Shared by all focused lists (including Blossom); never exceed three transports.
let running = 0;
const queue: (() => void)[] = [];
function drain() {
  while (running < 3 && queue.length) queue.shift()!();
}

function socketProbe(url: string, signal: AbortSignal): Promise<ProbeResult | undefined> {
  return new Promise((resolve) => {
    let socket: WebSocket | undefined;
    let done = false;
    const finish = (event?: ProbeEvent, message = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (socket) {
        activeSockets.delete(socket);
        socket.onmessage = socket.onerror = socket.onclose = null;
        // A slow relay may still be CONNECTING here (the 6 s timeout, or the
        // screen losing focus); it must not open later and stay open.
        closeSocketNowOrOnOpen(socket);
      }
      resolve(event ? finishProbe(undefined, event, Date.now(), message) : undefined);
    };
    const cancel = () => finish();
    const timer = setTimeout(() => finish('timeout'), PROBE_TIMEOUT_MS);
    signal.addEventListener('abort', cancel);
    try {
      socket = new WebSocket(activeAccountRelays([url])[0]);
      activeSockets.add(socket);
      socket.onopen = () => {
        try {
          socket!.send(
            JSON.stringify([
              'REQ',
              'reachability',
              { kinds: [0], since: Math.floor(Date.now() / 1000) - 60, limit: 1 },
            ]),
          );
        } catch (error) {
          finish('error', String(error));
        }
      };
      socket.onmessage = () => finish('message');
      socket.onerror = (event) =>
        finish('error', (event as unknown as { message?: string }).message);
      socket.onclose = () => finish('close');
    } catch (error) {
      finish('error', String(error));
    }
  });
}

async function httpProbe(
  url: string,
  signal: AbortSignal,
  service: ReachabilityService,
): Promise<ProbeResult | undefined> {
  const controller = new AbortController();
  if (service === 'nostr') activeRelayHttpProbes.add(controller);
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  try {
    const root = new URL(url);
    if (root.protocol !== 'https:') throw new Error('HTTPS required');
    root.pathname = '/';
    root.search = '';
    root.hash = '';
    const response = await fetch(root.toString(), { method: 'HEAD', signal: controller.signal });
    if (
      !(service === 'nostr' && controller.signal.aborted && !timedOut) &&
      (response.status === 405 || response.status === 501)
    ) {
      await fetch(root.toString(), { method: 'GET', signal: controller.signal });
    }
    // Any HTTP response demonstrates reachability, including auth / missing root.
    return signal.aborted || (service === 'nostr' && controller.signal.aborted && !timedOut)
      ? undefined
      : finishProbe(undefined, 'message', Date.now());
  } catch (error) {
    return signal.aborted || (controller.signal.aborted && !timedOut)
      ? undefined
      : finishProbe(undefined, timedOut ? 'timeout' : 'error', Date.now(), String(error));
  } finally {
    clearTimeout(timer);
    activeRelayHttpProbes.delete(controller);
    signal.removeEventListener('abort', cancel);
  }
}

export type ReachabilityService = 'nostr' | 'blossom';

/** DEV routing can send the same input URL to two different services. */
export function reachabilityCacheKey(url: string, service: ReachabilityService = 'nostr'): string {
  if (!__DEV__) return url;
  const target = service === 'nostr' ? activeAccountRelays([url])[0] : url;
  return `${service}:${target}`;
}

export function probeReachability(
  url: string,
  signal: AbortSignal,
  service: ReachabilityService = 'nostr',
): Promise<ProbeResult | undefined> {
  return new Promise((resolve) => {
    const cancelQueued = () => {
      const index = queue.indexOf(start);
      if (index >= 0) {
        queue.splice(index, 1);
        resolve(undefined);
      }
    };
    const start = () => {
      signal.removeEventListener('abort', cancelQueued);
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      running++;
      const target = service === 'nostr' ? activeAccountRelays([url])[0] : url;
      void (
        target.startsWith('https:')
          ? httpProbe(target, signal, service)
          : socketProbe(target, signal)
      )
        .then(resolve)
        .finally(() => {
          running--;
          drain();
        });
    };
    signal.addEventListener('abort', cancelQueued);
    queue.push(start);
    drain();
  });
}
