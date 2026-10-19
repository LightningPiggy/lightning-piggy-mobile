// querySyncFilters' `requireAnswer` (#1658): an empty read that no relay
// completed must reject, so "nothing published" and "couldn't ask" differ.
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { Event } from 'nostr-tools/pure';
import { withRelayHealth } from './healthAwarePool';

jest.mock('./nostrVerifyCache', () => ({
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));
jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
jest.mock('./relayHealth', () => ({
  RELAY_CONNECT_TIMEOUT_MS: 5000,
  noteNetworkActivity: jest.fn(),
  recordRelayFailure: jest.fn(),
  recordRelayConnectionObservation: jest.fn(),
  recordRelayPublish: jest.fn(),
  recordRelaySuccess: jest.fn(),
  selectHealthyRelays: (urls: string[]) => urls,
}));

type Relay = Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>;
type Params = Parameters<Relay['subscribe']>[1];
type Behaviour = 'down' | 'eose' | 'event-then-drop';

const EVENT = { id: 'kp', kind: 30443, pubkey: 'p', created_at: 1 } as Event;

/** Each relay URL behaves as configured: unreachable, empty EOSE, or one
 * event followed by a dropped socket (no EOSE). */
function makePool(behaviour: Record<string, Behaviour>) {
  class FakePool {
    relays = new Map();
    seenOn = new Map();
    ensureRelay(url: string) {
      const key = url.replace(/\/?$/, '/');
      const mode = behaviour[key];
      if (mode === 'down') return Promise.reject(new Error('connection failure'));
      const relay = {
        url: key,
        connected: true,
        subscribe: (_filters: unknown, params: Params) => {
          queueMicrotask(() => {
            if (mode === 'eose') params.oneose?.();
            else {
              params.onevent?.(EVENT);
              params.onclose?.('relay connection closed');
            }
          });
          return { close: () => undefined };
        },
      };
      this.relays.set(key, relay);
      return Promise.resolve(relay);
    }
    close() {}
    destroy() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake transport has only the surface under test
  const Pool = withRelayHealth(FakePool as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor is abstract
  return new (Pool as any)() as {
    querySyncFilters: (
      urls: string[],
      filters: object[],
      wait: number,
      opts?: { requireAnswer?: boolean },
    ) => Promise<Event[]>;
  };
}

const FILTER = { kinds: [30443], authors: ['p'], limit: 50 };
const A = 'wss://a.example/';
const B = 'wss://b.example/';

describe('querySyncFilters requireAnswer', () => {
  it('rejects when every relay failed and nothing arrived', async () => {
    const pool = makePool({ [A]: 'down', [B]: 'down' });
    await expect(
      pool.querySyncFilters([A, B], [FILTER], 6000, { requireAnswer: true }),
    ).rejects.toThrow(/No relay answered/);
  });

  it('still resolves empty without the option (existing callers unchanged)', async () => {
    const pool = makePool({ [A]: 'down', [B]: 'down' });
    await expect(pool.querySyncFilters([A, B], [FILTER], 6000)).resolves.toEqual([]);
  });

  it('resolves empty when a relay completed the read: nothing is published', async () => {
    const pool = makePool({ [A]: 'down', [B]: 'eose' });
    await expect(
      pool.querySyncFilters([A, B], [FILTER], 6000, { requireAnswer: true }),
    ).resolves.toEqual([]);
  });

  it('keeps events that arrived even if no relay reached EOSE', async () => {
    const pool = makePool({ [A]: 'down', [B]: 'event-then-drop' });
    await expect(
      pool.querySyncFilters([A, B], [FILTER], 6000, { requireAnswer: true }),
    ).resolves.toEqual([EVENT]);
  });
});
