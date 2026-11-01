import { AppState, type AppStateStatus } from 'react-native';
import type { Event, Filter } from 'nostr-tools';
import { MarmotSession, buildMarmotRumor } from './marmotSession';
import {
  RELAY,
  makeRelay,
  makeSession,
  unwrapWelcomes,
  waitFor,
  waitForSettled,
} from './marmotSessionTestKit';

const mockQuery = jest.fn();
const mockPublish = jest.fn();
const mockSubscribe = jest.fn();
const mockResetTransports = jest.fn();
jest.mock('./nostrPool', () => ({
  pool: {
    querySync: (...args: unknown[]) => mockQuery(...args),
    // Group history and recovery read through the multi-filter one-shot (#1399).
    querySyncFilters: (relays: string[], filters: Filter[]) =>
      mockQuery(relays, filters.length === 1 ? filters[0] : filters),
    publish: (...args: unknown[]) => mockPublish(...args),
    subscribeMany: (...args: unknown[]) => mockSubscribe(...args),
    // The merged group REQ arms one physical subscription per relay; model it
    // on the same in-memory relay so the live-after-ingest assertions below
    // see every kind-445 subscription the session opens.
    subscribeMap: (
      requests: { url: string; filter: Filter }[],
      params: { onevent: (e: Event) => void; onReqOpen?: () => void },
    ) => {
      const subs = requests.map(({ url, filter }) =>
        mockSubscribe([url], filter, { onevent: params.onevent }),
      );
      params.onReqOpen?.();
      return { close: () => subs.forEach((sub: { close(): void }) => sub.close()) };
    },
    resetTransports: async (...args: unknown[]) => mockResetTransports(...args),
  },
  trackRelays: jest.fn(),
}));

it.each(Array.from({ length: Number(process.env.MARMOT_PERF_SAMPLES ?? 1) }, (_, i) => i + 1))(
  'resumes >500 offline messages and an older epoch before live delivery (sample %i)',
  async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const originalBob = makeSession(relay);
    let bob: MarmotSession | undefined;
    let offline = false;
    const callbacks = new Set<(state: AppStateStatus) => void>();
    const stateListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_name, cb) => {
        callbacks.add(cb);
        return { remove: () => callbacks.delete(cb) };
      });
    mockQuery.mockImplementation((relays: string[], filter: Filter) =>
      relay.network.request(relays, filter),
    );
    mockPublish.mockImplementation((relays: string[], event: Event) =>
      relays.map(async (url) => {
        await relay.network.publish([url], event);
        return 'saved';
      }),
    );
    const sockets = new Set<{ unsubscribe(): void }>();
    mockSubscribe.mockImplementation(
      (relays: string[], filter: Filter, observer: { onevent: (e: Event) => void }) => {
        const sub = relay.network.subscription(relays, filter).subscribe({
          next: (event) => {
            if (!offline) observer.onevent(event);
          },
        });
        sockets.add(sub);
        return {
          close: () => {
            sub.unsubscribe();
            sockets.delete(sub);
          },
        };
      },
    );
    let resetStartedAt = 0;
    mockResetTransports.mockImplementation(() => {
      resetStartedAt = performance.now();
      for (const sub of sockets) sub.unsubscribe();
      sockets.clear();
    });
    let clock: jest.SpyInstance | undefined;
    try {
      await alice.session.start();
      await originalBob.session.start();
      await waitFor(() =>
        relay.events.some((e) => e.kind === 30443 && e.pubkey === originalBob.pubkey),
      );
      const group = await alice.session.createGroup('Resume catch-up', [originalBob.pubkey]);
      await originalBob.session.acceptWelcome(unwrapWelcomes(relay, originalBob)[0]);
      await waitForSettled(originalBob.session, group.id);
      originalBob.session.stop();
      const inbox: string[] = [];
      // Use the production network/reconnect wiring with real MLS and durable state.
      bob = new MarmotSession({
        pubkey: originalBob.pubkey,
        signerType: 'nsec',
        signer: originalBob.signer,
        backend: originalBob.backend,
        getWriteRelays: () => [RELAY],
        getLookupRelays: () => [RELAY],
      });
      bob.subscribe({ onMessage: (m) => inbox.push(m.rumor.id) });
      await bob.start();
      await waitFor(() => mockSubscribe.mock.calls.some(([, f]) => f.kinds.includes(445)));
      offline = true;
      for (const cb of callbacks) cb('background');
      let timestamp = Date.now() - 550_000;
      clock = jest.spyOn(Date, 'now').mockImplementation(() => timestamp);
      const expected: string[] = [];
      for (let i = 0; i < 505; i++) {
        timestamp += 1000;
        if (i === 3) await alice.session.rename(group.id, 'Offline epoch');
        const rumor = buildMarmotRumor(alice.pubkey, { kind: 9, content: `offline ${i}` });
        expected.push(rumor.id);
        await alice.session.sendRumor(group.id, rumor);
      }
      clock.mockRestore();
      clock = undefined;
      expect(inbox).toEqual([]);
      const requestsBefore = mockQuery.mock.calls.length;
      const subscriptionsBefore = mockSubscribe.mock.calls.length;
      // Every message must already have been ingested when live delivery opens.
      const subscribe = mockSubscribe.getMockImplementation()!;
      mockSubscribe.mockImplementation((...args) => {
        if (args[1].kinds.includes(445)) expect(inbox).toEqual(expected);
        return subscribe(...args);
      });
      offline = false;
      const resumeStartedAt = performance.now();
      for (const cb of [...callbacks]) cb('active');
      await waitFor(() => mockSubscribe.mock.calls.length > subscriptionsBefore);
      expect(
        mockQuery.mock.calls
          .slice(requestsBefore)
          .some(([, f]) => f.kinds.includes(445) && f.until !== undefined),
      ).toBe(true);
      expect(inbox).toEqual(expected);
      if (process.env.MARMOT_PERF_SAMPLES) {
        process.stdout.write(
          `[PerfBlock] marmotResume groups=1 messages=505 olderCommits=1 activeToLive=${(performance.now() - resumeStartedAt).toFixed(2)}ms backfillToLive=${(performance.now() - resetStartedAt).toFixed(2)}ms\n`,
        );
      }
      // The group's relays: ours plus the Marmot relays every new chat now gets.
      expect(mockResetTransports).toHaveBeenCalledWith(expect.arrayContaining([RELAY]));
      const live = buildMarmotRumor(alice.pubkey, { kind: 9, content: 'live after catch-up' });
      await alice.session.sendRumor(group.id, live);
      await waitFor(() => inbox.includes(live.id));
      expect(inbox).toEqual([...expected, live.id]);
    } finally {
      clock?.mockRestore();
      bob?.stop();
      alice.session.stop();
      originalBob.session.stop();
      stateListener.mockRestore();
    }
  },
  120_000,
);
