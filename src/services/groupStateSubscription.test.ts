/**
 * kind-30200 group-state subscription (#1793): both viewer filters must
 * ride one physical REQ per relay, each bounded by a `limit`, with no
 * `since` (a group's state event can be old and still current).
 */
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import {
  GROUP_STATE_KIND,
  GROUP_STATE_LIMIT,
  pool,
  subscribeGroupStateForViewer,
} from './nostrService';
import { withRelayHealth } from './healthAwarePool';

jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
jest.mock('./relayHealth', () => ({
  ...jest.requireActual('./relayHealth'),
  noteNetworkActivity: jest.fn(),
  recordRelayFailure: jest.fn(),
  recordRelayConnectionObservation: jest.fn(),
  recordRelayPublish: jest.fn(),
  recordRelaySuccess: jest.fn(),
  selectHealthyRelays: (relays: string[]) => relays,
}));

type Requests = Parameters<AbstractSimplePool['subscribeMap']>[0];
type Params = Parameters<AbstractSimplePool['subscribeMap']>[1];

/** Transport stand-in: every subscribeMap that reaches it is one physical REQ. */
class FakeTransport {
  relays = new Map();
  reqs: Requests[] = [];
  relay = { connected: true, onnotice: jest.fn() };
  ensureRelay(url: string) {
    return Promise.resolve({
      ...this.relay,
      url,
      subscribe: (
        filters: Requests[number]['filter'][],
        params: Parameters<Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>['subscribe']>[1],
      ) =>
        FakeTransport.prototype.subscribeMap.call(
          this,
          filters.map((filter) => ({ url, filter })),
          { ...params, onclose: (errors) => params.onclose?.(errors[0]) },
        ),
    });
  }
  subscribeMap(requests: Requests, _params: Params) {
    this.reqs.push(requests);
    return { close: () => {} };
  }
  close() {}
  destroy() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake implements the transport surface under test
const BudgetPool = withRelayHealth(FakeTransport as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin is an abstract constructor
const makePool = () => new (BudgetPool as any)() as FakeTransport & AbstractSimplePool;
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const reqsPerRelay = (t: FakeTransport) => {
  const counts: Record<string, number> = {};
  for (const req of t.reqs)
    for (const url of new Set(req.map((r) => r.url))) counts[url] = (counts[url] ?? 0) + 1;
  return counts;
};

const ME = 'a'.repeat(64);
const RELAYS = ['wss://relay.one/', 'wss://relay.two/'];

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function captureRequests(): {
  requests: Requests;
  close: jest.Mock;
  subscribeMany: jest.SpyInstance;
} {
  const close = jest.fn();
  const out = { requests: [] as Requests, close };
  jest.spyOn(pool, 'subscribeMap').mockImplementation((requests) => {
    out.requests = requests;
    return { close };
  });
  const subscribeMany = jest.spyOn(pool, 'subscribeMany');
  const unsubscribe = subscribeGroupStateForViewer({
    viewerPubkey: ME,
    relays: RELAYS,
    onEvent: jest.fn(),
  });
  unsubscribe();
  return { ...out, subscribeMany };
}

test('sends both viewer filters in one subscribeMap call, each bounded and without since', () => {
  const { requests, close, subscribeMany } = captureRequests();
  expect(subscribeMany).not.toHaveBeenCalled();
  expect(pool.subscribeMap).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  const p = { kinds: [GROUP_STATE_KIND], '#p': [ME], limit: GROUP_STATE_LIMIT };
  const a = { kinds: [GROUP_STATE_KIND], authors: [ME], limit: GROUP_STATE_LIMIT };
  expect(requests).toEqual(
    RELAYS.flatMap((url) => [
      { url, filter: p },
      { url, filter: a },
    ]),
  );
  for (const { filter } of requests) expect(filter).not.toHaveProperty('since');
});

test('physical REQs per relay through the budgeted pool: 2 before, 1 after', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  const { requests } = captureRequests();
  jest.restoreAllMocks();

  // Before #1793: two subscribeMany calls, i.e. one subscribeMap per filter.
  const before = makePool();
  const filtersOf = (i: number) => requests.filter((_, j) => j % 2 === i);
  before.subscribeMap(filtersOf(0), {});
  before.subscribeMap(filtersOf(1), {});
  // After: the single subscribeMap call the service now makes.
  const after = makePool();
  after.subscribeMap(requests, {});
  await tick();

  expect(reqsPerRelay(before)).toEqual({ [RELAYS[0]]: 2, [RELAYS[1]]: 2 });
  expect(reqsPerRelay(after)).toEqual({ [RELAYS[0]]: 1, [RELAYS[1]]: 1 });
  // The one REQ carries both filters.
  for (const req of after.reqs) expect(req).toHaveLength(2);
  before.destroy();
  after.destroy();
});
