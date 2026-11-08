import {
  activeAccountRelays,
  eventAuthorRelays,
  watchTestRelayLockdown,
  type RelayConnectionParams,
} from './testRelayRouting';
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { paceRelayReceive } from './nostrRelayReceiveQueue';
import { SimplePool } from 'nostr-tools/pool';
import { normalizeURL } from 'nostr-tools/utils';
import { withRelayHealth } from './healthAwarePool';
import { hydrateRelayHealth } from './relayHealth';
import { withResumableSubscriptions } from './resumablePool';
import { guardPool } from './relaySocketGuard';
import { assertNotWrapOnlyKind } from '../utils/wrapOnlyKinds';

/** `SimplePool` that skips relays known to be dead (#1326, see ./healthAwarePool). */
class HealthAwarePool extends withResumableSubscriptions(withRelayHealth(SimplePool)) {
  private readonly pendingPublishes = new Map<string, number>();
  /** Called (normalised URL) when a relay's last pending pool publish settles. */
  onPublishesDrained?: (url: string) => void;

  async ensureRelay(url: string, params?: RelayConnectionParams) {
    if (!params?.forPublish) url = activeAccountRelays([url])[0];
    const key = normalizeURL(url);
    if (!this.relays.has(key)) {
      // Pre-create with public SDK APIs so the receive hook is installed before
      // connect() binds its WebSocket callback. Keep the existing verifier.
      const relay = new AbstractRelay(key, {
        verifyEvent: this.verifyEvent,
        websocketImplementation: WebSocket,
        enablePing: this.enablePing,
        enableReconnect: this.enableReconnect,
      });
      paceRelayReceive(relay);
      relay.onclose = () => {
        if (this.relays.get(key) === relay) this.relays.delete(key);
      };
      this.relays.set(key, relay);
    }
    return super.ensureRelay(url, params);
  }

  publish(...args: Parameters<SimplePool['publish']>): Promise<string>[] {
    // Gamma order kinds 16/17 never go out bare (NIP-18 repost / NIP-25
    // website reaction when public) — only inside a kind-1059 gift wrap.
    assertNotWrapOnlyKind(args[1].kind, 'publish');
    args[0] = eventAuthorRelays(args[0], args[1]);
    const urls = args[0].map((url) => {
      try {
        return normalizeURL(url);
      } catch {
        // Leave malformed URLs to the underlying publish error handling.
        return url;
      }
    });
    for (const url of urls) {
      this.pendingPublishes.set(url, (this.pendingPublishes.get(url) ?? 0) + 1);
    }
    const finish = (url: string): void => {
      const remaining = this.pendingPublishes.get(url)! - 1;
      if (remaining) {
        this.pendingPublishes.set(url, remaining);
      } else {
        this.pendingPublishes.delete(url);
        this.onPublishesDrained?.(url);
      }
    };
    try {
      const results = super.publish(...args);
      results.forEach((result, i) => {
        // Covers connection and AUTH signing/retry as well as waiting for OK.
        void result.then(
          () => finish(urls[i]),
          () => finish(urls[i]),
        );
      });
      return results;
    } catch (error) {
      urls.forEach(finish);
      throw error;
    }
  }

  /** `only`: normalised URLs to consider; all relays when omitted. */
  pruneIdleRelays(idleThresholdMs = 10000, only?: ReadonlySet<string>): string[] {
    const pruned: string[] = [];
    for (const [url, relay] of this.relays) {
      if (only && !only.has(url)) continue;
      // nostr-tools marks EVENT sends idle before OK and does not count COUNT
      // requests. These private maps are runtime fields in the installed SDK;
      // fail closed if a future version stops exposing them.
      const operations = relay as unknown as {
        openEventPublishes?: Map<string, unknown>;
        openCountRequests?: Map<string, unknown>;
        connectionPromise?: Promise<void>;
      };
      if (
        this.pendingPublishes.has(url) ||
        // Still connecting: a caller is awaiting connect() on this socket.
        (operations.connectionPromise !== undefined && !relay.connected) ||
        operations.openEventPublishes?.size !== 0 ||
        operations.openCountRequests?.size !== 0 ||
        relay.openSubs.size > 0 ||
        relay.ongoingOperations > 0 ||
        relay.idleSince === undefined ||
        Date.now() - relay.idleSince < idleThresholdMs
      )
        continue;
      this.relays.delete(url);
      pruned.push(url);
      relay.close();
    }
    return pruned;
  }
}

/**
 * Shared connection-pool singleton, kept in its own dependency-free module.
 *
 * Feature-specific modules (e.g. `nostrProfileBatch`, `nostrPlacesPublisher`)
 * share this single set of relay WebSockets rather than spinning up parallel
 * `SimplePool` instances — each pool maintains its own sockets per relay, so
 * duplication adds real connection cost. Living here (rather than in
 * `nostrService`) lets those modules import the pool WITHOUT forming an import
 * cycle back to the large `nostrService` surface.
 *
 * `nostrService` imports this same instance, applies its custom fast-path
 * `pool.verifyEvent`, and re-exports `pool` / `trackRelays` for back-compat.
 */
// Closes the sockets nostr-tools abandons mid-connect (see ./relaySocketGuard).
export const pool = guardPool(new HealthAwarePool());
watchTestRelayLockdown(() => {
  pool.destroy();
  connectedRelays.clear();
  releaseWhenIdle.clear();
});

// One-off sockets (e.g. a send's outbox relays) to close once nothing uses them.
// A socket opened by one send may still carry another send's publish when the
// first finishes; it's released when that last publish settles (#1570).
const releaseWhenIdle = new Set<string>();
pool.onPublishesDrained = (url) => {
  if (!releaseWhenIdle.has(url)) return;
  // Let nostr-tools finish its own OK bookkeeping first.
  setTimeout(() => {
    if (releaseWhenIdle.has(url)) pruneIdleRelays([url]);
  }, 0);
};

// Load what we learned about dead relays last session, so they're skipped
// from the first query rather than after two more timeouts.
void hydrateRelayHealth();

// Every relay we've opened a subscription against — tracked so `cleanup()`
// can close them all.
export const connectedRelays = new Set<string>();

// Track all relays we connect to for proper cleanup.
export function trackRelays(relays: string[]): void {
  activeAccountRelays(relays).forEach((r) => connectedRelays.add(r));
}

/** Release idle sockets after transient batches, preserving active subscriptions.
 * `urls` limits it to those relays (e.g. a send's one-off outbox relays). */
export function pruneIdleRelays(urls?: readonly string[]): void {
  let only: Set<string> | undefined;
  if (urls) {
    only = new Set();
    for (const url of urls) {
      try {
        only.add(normalizeURL(url));
      } catch {
        // Invalid URLs never opened a connection.
      }
    }
    if (only.size === 0) return;
  }
  const pruned = new Set(pool.pruneIdleRelays(0, only));
  forgetPruned(pruned);
  if (releaseWhenIdle.size > 0) {
    const pooled = pooledRelayUrls();
    for (const url of releaseWhenIdle) if (!pooled.has(url)) releaseWhenIdle.delete(url);
  }
}

/** Normalised URLs of every relay the pool holds a socket for right now — snapshot
 * it before a transient batch to release only the sockets that batch opened. */
export function pooledRelayUrls(): Set<string> {
  return new Set(pool.listConnectionStatus().keys());
}

/** Release the sockets in `urls` that weren't pooled in `before`: now if idle,
 * otherwise once their last pending publish settles. */
export function releaseNewIdleRelays(urls: readonly string[], before: ReadonlySet<string>): void {
  const opened: string[] = [];
  for (const url of urls) {
    try {
      const key = normalizeURL(url);
      if (!before.has(key)) opened.push(key);
    } catch {
      // Invalid URLs never opened a connection.
    }
  }
  if (opened.length === 0) return;
  opened.forEach((url) => releaseWhenIdle.add(url));
  pruneIdleRelays(opened);
}

function forgetPruned(pruned: ReadonlySet<string>): void {
  for (const url of connectedRelays) {
    try {
      if (pruned.has(normalizeURL(url))) connectedRelays.delete(url);
    } catch {
      // Invalid URLs never opened a connection.
      connectedRelays.delete(url);
    }
  }
}
