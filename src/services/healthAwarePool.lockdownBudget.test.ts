import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { withRelayHealth } from './healthAwarePool';
import { discoverRelayReqLimit } from './relayReqLimit';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';

jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: jest.fn(async () => undefined) }));
jest.mock('./relayHealth', () => ({
  RELAY_CONNECT_TIMEOUT_MS: 5000,
  noteNetworkActivity: jest.fn(),
  recordRelayFailure: jest.fn(),
  recordRelayConnectionObservation: jest.fn(),
  recordRelayPublish: jest.fn(),
  recordRelaySuccess: jest.fn(),
  selectHealthyRelays: (relays: string[]) => relays,
}));

class FakePool {
  relays = new Map();
  seenOn = new Map();
  trackRelays = false;
  close() {}
  destroy() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake implements the transport surface under test
const BudgetPool = withRelayHealth(FakePool as any);
const makePool = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin is an abstract constructor
  new (BudgetPool as any)() as FakePool & {
    subscribeRelay(
      relay: Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>,
      filters: { kinds: number[]; limit: number }[],
      params: object,
      url?: string,
    ): unknown;
  };

const PUBLIC = 'wss://relay.damus.io/';
const rawRelay = (url: string) =>
  ({
    url,
    subscribe: () => ({ close: jest.fn() }),
  }) as unknown as Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>;

afterEach(() => {
  setCurrentUserPubkey(null);
  jest.mocked(discoverRelayReqLimit).mockClear();
});

test('lockdown: the budget is keyed by the redirected test relay, not the caller URL', () => {
  setCurrentUserPubkey([...TEST_ACCOUNT_PUBKEYS][0]);
  const pool = makePool();
  // The caller asked for a public relay; ensureRelay connected the test relay.
  pool.subscribeRelay(rawRelay(TEST_RELAY_URL), [{ kinds: [1], limit: 1 }], {}, PUBLIC);
  const keys = jest.mocked(discoverRelayReqLimit).mock.calls.map(([k]) => k);
  expect(keys).toHaveLength(1);
  expect(keys[0]).not.toContain('damus');
  expect(keys[0]).toContain(new URL(TEST_RELAY_URL).host);
  pool.destroy();
});

test('outside lockdown the budget stays keyed by the connected public relay', () => {
  setCurrentUserPubkey('f'.repeat(64));
  const pool = makePool();
  pool.subscribeRelay(rawRelay(PUBLIC), [{ kinds: [1], limit: 1 }], {}, PUBLIC);
  expect(jest.mocked(discoverRelayReqLimit).mock.calls.map(([k]) => k)).toEqual([PUBLIC]);
  pool.destroy();
});
