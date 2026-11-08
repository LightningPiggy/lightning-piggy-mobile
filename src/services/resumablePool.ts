import { activeAccountRelayRequests } from './testRelayRouting';
import type { AbstractSimplePool, SubCloser } from 'nostr-tools/abstract-pool';
import { normalizeURL } from 'nostr-tools/utils';
import type { AbstractRelay } from 'nostr-tools/abstract-relay';
import { RelayOperationDrain } from './relayOperationDrain';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS mixin constructor signature
type PoolClass = abstract new (...args: any[]) => AbstractSimplePool;

/** Replace stale transports without losing other features sharing their sockets. */
export function withResumableSubscriptions<TBase extends PoolClass>(Base: TBase) {
  abstract class ResumablePool extends Base {
    private resetsInFlight = 0;
    private readonly operationDrains = new WeakMap<AbstractRelay, RelayOperationDrain>();
    private readonly retiredRelays = new Set<AbstractRelay>();
    private readonly publishes = new Map<string, Set<Promise<string>>>();

    private teardownGeneration = 0;
    private readonly relayGenerations = new Map<string, number>();

    async ensureRelay(
      ...args: Parameters<AbstractSimplePool['ensureRelay']>
    ): Promise<AbstractRelay> {
      const url = normalizeURL(args[0]);
      const teardownGeneration = this.teardownGeneration;
      const relayGeneration = this.relayGenerations.get(url);
      // The SDK deletes the URL unconditionally when connect() rejects. Give
      // each attempt its own registry so an old failure cannot evict a replacement.
      // Inherit pool configuration and callbacks while retaining SDK AUTH setup.
      const attempt = Object.create(this) as this;
      const existing = this.relays.get(url);
      attempt.relays = new Map(existing ? [[url, existing]] : []);
      const result = super.ensureRelay.call(attempt, ...args);
      const relay = attempt.relays.get(url);
      if (relay && !this.operationDrains.has(relay)) {
        this.relays.set(url, relay);
        this.operationDrains.set(relay, new RelayOperationDrain(relay));
        const onclose = relay.onclose;
        relay.onclose = () => {
          this.retiredRelays.delete(relay);
          if (this.relays.get(url) === relay) {
            onclose?.();
            this.relays.delete(url);
          }
        };
      }
      try {
        const connected = await result;
        if (
          this.teardownGeneration !== teardownGeneration ||
          this.relayGenerations.get(url) !== relayGeneration
        ) {
          connected.close();
          throw new Error('relay connection closed by us');
        }
        return connected;
      } catch (error) {
        if (this.relays.get(url) === relay) this.relays.delete(url);
        throw error;
      }
    }

    publish(...args: Parameters<AbstractSimplePool['publish']>): Promise<string>[] {
      const results = super.publish(...args);
      results.forEach((result, i) => {
        const url = normalizeURL(args[0][i]);
        const pending = this.publishes.get(url) ?? new Set<Promise<string>>();
        this.publishes.set(url, pending);
        pending.add(result);
        const finish = () => {
          pending.delete(result);
          if (pending.size === 0) this.publishes.delete(url);
        };
        void result.then(finish, finish);
      });
      return results;
    }

    close(urls: string[]): void {
      const targets = new Set(urls.map(normalizeURL));
      for (const url of targets) {
        this.relayGenerations.set(url, (this.relayGenerations.get(url) ?? 0) + 1);
      }
      for (const entry of [...this.subscriptions]) {
        entry.removeRoutes(targets);
      }
      super.close(urls);
      for (const relay of this.retiredRelays) {
        if (targets.has(relay.url)) relay.close();
      }
    }

    destroy(): void {
      this.teardownGeneration++;
      for (const entry of [...this.subscriptions]) entry.stop();
      this.pendingOpens.clear();
      super.destroy();
      // COUNT has no SDK timeout; explicit pool teardown still releases it.
      for (const relay of this.retiredRelays) relay.close();
      this.retiredRelays.clear();
    }

    private readonly pendingOpens = new Set<() => void>();
    private readonly subscriptions = new Set<{
      urls: string[];
      pause(): Promise<void>;
      open(): void;
      stop(): void;
      removeRoutes(targets: Set<string>): void;
    }>();

    subscribeMap(
      requests: Parameters<AbstractSimplePool['subscribeMap']>[0],
      params: Parameters<AbstractSimplePool['subscribeMap']>[1],
    ): SubCloser {
      requests = activeAccountRelayRequests(requests);
      /** `onclose`, which the health layer below calls with each reason's relay too. */
      const onclose = params.onclose as ((reasons: string[], urls?: string[]) => void) | undefined;
      let activeRequests = requests;
      let generation = 0;
      let stopped = false;
      let sub: SubCloser | undefined;
      const entry = {
        urls: requests.map(({ url }) => normalizeURL(url)),
        removeRoutes: (targets: Set<string>) => {
          activeRequests = activeRequests.filter(({ url }) => !targets.has(normalizeURL(url)));
          // The SDK closes only the targeted relay's child subscription. Keep
          // healthy children running, and exclude removed routes on later resets.
          if (activeRequests.length === 0) entry.stop();
          else entry.urls = activeRequests.map(({ url }) => normalizeURL(url));
        },
        stop: () => {
          if (stopped) return;
          stopped = true;
          generation++;
          this.subscriptions.delete(entry);
          this.pendingOpens.delete(entry.open);
          void sub?.close('relay connection closed by us');
          onclose?.(
            entry.urls.map(() => 'relay connection closed by us'),
            entry.urls,
          );
        },
        pause: async () => {
          generation++;
          await sub?.close();
        },
        open: () => {
          if (stopped) return;
          if (this.resetsInFlight > 0) {
            this.pendingOpens.add(entry.open);
            return;
          }
          const currentGeneration = ++generation;
          const current = () => generation === currentGeneration;
          sub = super.subscribeMap(activeRequests, {
            ...params,
            onevent: (event) => {
              if (current()) params.onevent?.(event);
            },
            oneose: () => {
              if (current()) params.oneose?.();
            },
            // The health layer also passes each reason's relay: keep it.
            onclose: (reasons: string[], urls?: string[]) => {
              if (!current()) return;
              stopped = true;
              this.subscriptions.delete(entry);
              onclose?.(reasons, urls);
            },
          });
        },
      };
      this.subscriptions.add(entry);
      entry.open();
      return {
        close: (reason) => {
          stopped = true;
          this.subscriptions.delete(entry);
          this.pendingOpens.delete(entry.open);
          return sub?.close(reason) ?? Promise.resolve();
        },
      };
    }

    async resetTransports(relays: string[]): Promise<void> {
      const targets = new Set(relays.map(normalizeURL));
      const teardownGeneration = this.teardownGeneration;
      const relayGenerations = new Map(
        [...targets].map((url) => [url, this.relayGenerations.get(url)]),
      );
      const affected = [...this.subscriptions].filter((entry) =>
        entry.urls.some((url) => targets.has(url)),
      );
      this.resetsInFlight++;
      // Wait for in-flight subscription opens before replacing sockets. Keep
      // caller close handles stable, and suppress intentional close callbacks.
      try {
        await Promise.all(affected.map((entry) => entry.pause()));
        for (const url of targets) {
          if (
            this.teardownGeneration !== teardownGeneration ||
            this.relayGenerations.get(url) !== relayGenerations.get(url)
          )
            continue;
          const relay = this.relays.get(url);
          const drain = relay && this.operationDrains.get(relay);
          if (!relay || !drain) {
            super.close([url]);
            continue;
          }
          // New reads use a fresh transport immediately. Keep the old one for
          // EVENT/AUTH/COUNT responses, including pool-level AUTH retry chains.
          for (const result of this.publishes.get(url) ?? []) drain.track(result);
          this.relays.delete(url);
          this.retiredRelays.add(relay);
          drain.retire();
        }
      } finally {
        // New subscriptions must not open on sockets about to be replaced.
        // Drain only after every concurrent reset has finished closing them.
        affected.forEach((entry) => entry.open());
        if (--this.resetsInFlight === 0) {
          const pending = [...this.pendingOpens];
          this.pendingOpens.clear();
          pending.forEach((open) => open());
        }
      }
    }
  }
  return ResumablePool;
}
