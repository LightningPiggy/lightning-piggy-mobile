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
type Behaviour = 'down' | 'eose' | 'event-then-drop' | 'silent' | 'event-then-silent';

const EVENT = { id: 'kp', kind: 30443, pubkey: 'p', created_at: 1 } as Event;

/** Model both wire responses and the SDK EOSE timeout on connected relays. */
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
          const timer = setTimeout(() => params.oneose?.(), params.eoseTimeout);
          queueMicrotask(() => {
            if (mode === 'eose') {
              clearTimeout(timer);
              params.oneose?.();
            } else if (mode === 'event-then-drop') {
              clearTimeout(timer);
              params.onevent?.(EVENT);
              params.onclose?.('relay connection closed');
            } else if (mode === 'event-then-silent') params.onevent?.(EVENT);
          });
          return { close: () => clearTimeout(timer) };
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
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }));
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('rejects a connected silent relay at the REQ deadline, before synthetic EOSE', async () => {
    const pool = makePool({ [A]: 'silent' });
    const settled = jest.fn();
    const read = pool.querySyncFilters([A], [FILTER], 6000, { requireAnswer: true });
    void read.then(settled, settled);
    const result = expect(read).rejects.toThrow(/No relay answered: query deadline/);
    await jest.advanceTimersByTimeAsync(6000);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    await result;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps partial events from a connected relay that never sends EOSE', async () => {
    const pool = makePool({ [A]: 'event-then-silent' });
    const settled = jest.fn();
    const read = pool.querySyncFilters([A], [FILTER], 6000, { requireAnswer: true });
    void read.then(settled, settled);
    await jest.advanceTimersByTimeAsync(6000);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    await expect(read).resolves.toEqual([EVENT]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves the SDK timeout for callers that do not require an answer', async () => {
    const pool = makePool({ [A]: 'silent' });
    const read = pool.querySyncFilters([A], [FILTER], 6000);
    await jest.advanceTimersByTimeAsync(6000);
    await expect(read).resolves.toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

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
