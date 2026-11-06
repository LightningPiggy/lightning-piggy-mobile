import { activeAccountRelays, watchTestRelayLockdown } from './testRelayRouting';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { validateEvent, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import { withRelayHealth } from './healthAwarePool';
import { withResumableSubscriptions } from './resumablePool';
import { guardPool } from './relaySocketGuard';

/** Feeds and honours the shared relay-health state (#1326). */
// Reuse the shared generation guard: destroy invalidates pending connects,
// including SDK sockets that cannot close until they finish connecting.
class HealthAwareMarketPool extends withResumableSubscriptions(
  withRelayHealth(AbstractSimplePool),
) {}

/**
 * Relay pool for the market feed and seller snapshots, with structure-only
 * checks at the relay layer.
 *
 * Why a second pool: nostr-tools binds `verifyEvent` per relay connection, so
 * the shared pool can't skip signatures for one subscription. A follow set's
 * listings run to ~1,200 events and a schnorr check costs ~25 ms on a phone,
 * so the shared pool's eager check pinned the JS thread for tens of seconds
 * (#1274). The shared pool keeps verifying every kind for everyone else (the
 * product page reads listings through it).
 *
 * Contract: nothing from this pool is trusted. snapshot services
 * verify every event before use — deletions before they can hide anything,
 * listings lazily (winning revisions only, up to the render cap).
 *
 * Connections are opened per snapshot and closed when the last running
 * snapshot finishes, so this never keeps duplicate sockets open.
 */
const pool: AbstractSimplePool = guardPool(
  new HealthAwareMarketPool({
    verifyEvent: (event: Event): event is VerifiedEvent => validateEvent(event),
    // Same transport as the shared SimplePool (the global WebSocket).
    websocketImplementation: WebSocket,
    maxWaitForConnection: 3000,
  }),
);

watchTestRelayLockdown(() => pool.destroy());

let active = 0;
const opened = new Set<string>();

/** Borrow the pool for one snapshot; call the returned release when done. */
export function acquireMarketListingsPool(urls: readonly string[]): {
  pool: AbstractSimplePool;
  release: () => void;
} {
  active++;
  activeAccountRelays([...urls]).forEach((u) => opened.add(u));
  let released = false;
  return {
    pool,
    release: () => {
      if (released) return;
      released = true;
      if (--active > 0) return;
      pool.close([...opened]);
      opened.clear();
    },
  };
}
