// Quorum reads (#1759): one stuck relay must not hold a read to its deadline.
import type { Event as NostrEvent } from 'nostr-tools/pure';
import {
  queryRelaysQuorum,
  RELAY_EOSE_REASON,
  type QuorumRelayHandlers,
  type QuorumStats,
} from './relayQuorumQuery';

const mockFinishAfterRelayReceive = jest.fn((finish: () => void) => finish());
jest.mock('./nostrRelayReceiveQueue', () => ({
  finishAfterRelayReceive: (finish: () => void) => mockFinishAfterRelayReceive(finish),
}));

const ev = (id: string) => ({ id, kind: 4 }) as NostrEvent;

/** Fake relays: the test drives each relay's frames and close reason by hand. */
function fakeRelays(urls: string[]) {
  const handlers = new Map<string, QuorumRelayHandlers>();
  const closed = new Map<string, string | undefined>();
  const open = jest.fn((url: string, h: QuorumRelayHandlers) => {
    handlers.set(url, h);
    return { close: (reason?: string) => closed.set(url, reason) };
  });
  /** A frame through the SDK path: alreadyHaveEvent first, then onevent. */
  const send = (url: string, event: NostrEvent) => {
    const h = handlers.get(url)!;
    if (!h.alreadyHaveEvent(event.id)) h.onevent(event);
  };
  const eose = (url: string) => handlers.get(url)!.onclose(RELAY_EOSE_REASON);
  const fail = (url: string) => handlers.get(url)!.onclose('connection failed');
  return { urls, open, send, eose, fail, closed };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFinishAfterRelayReceive.mockClear();
});
afterEach(() => jest.useRealTimers());

test('resolves after K EOSEs plus the grace period while one relay is stuck', async () => {
  const r = fakeRelays(['wss://a/', 'wss://b/', 'wss://stuck/']);
  const onSettled = jest.fn<void, [QuorumStats]>();
  let done = false;
  const read = queryRelaysQuorum({
    relays: r.urls,
    open: r.open,
    maxWait: 8000,
    quorum: { quorum: 2, graceMs: 1200 },
    onSettled,
  }).then((events) => {
    done = true;
    return events;
  });
  expect(r.open).toHaveBeenCalledTimes(3);
  r.send('wss://a/', ev('1'));
  r.eose('wss://a/');
  r.send('wss://b/', ev('2'));
  r.eose('wss://b/');
  // Quorum reached: a straggler that answers inside the grace still counts.
  await jest.advanceTimersByTimeAsync(600);
  r.send('wss://stuck/', ev('3'));
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(600);
  expect((await read).map((e) => e.id)).toEqual(['1', '2', '3']);
  expect(done).toBe(true);
  // The stuck relay is closed by us; the answered ones closed themselves.
  expect([...r.closed.keys()]).toEqual(['wss://stuck/']);
  expect(onSettled).toHaveBeenCalledWith(
    expect.objectContaining({ relays: 3, eosed: 2, failed: 0, cut: 1, outcome: 'quorum' }),
  );
  expect(onSettled.mock.calls[0][0].ms).toBe(1200);
  // The backstop never fired.
  expect(mockFinishAfterRelayReceive).not.toHaveBeenCalled();
});

test('quorum is capped at the relay count, and finishes at once when all answered', async () => {
  const r = fakeRelays(['wss://only/']);
  const onSettled = jest.fn<void, [QuorumStats]>();
  const read = queryRelaysQuorum({
    relays: r.urls,
    open: r.open,
    maxWait: 8000,
    quorum: { quorum: 2, graceMs: 1200 },
    onSettled,
  });
  r.eose('wss://only/');
  await expect(read).resolves.toEqual([]);
  expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'all', cut: 0 }));
});

test('failed relays do not count toward the quorum but do finish the read', async () => {
  const r = fakeRelays(['wss://a/', 'wss://down1/', 'wss://down2/']);
  const onSettled = jest.fn<void, [QuorumStats]>();
  const read = queryRelaysQuorum({
    relays: r.urls,
    open: r.open,
    maxWait: 8000,
    quorum: { quorum: 2, graceMs: 1200 },
    onSettled,
  });
  r.fail('wss://down1/');
  r.eose('wss://a/');
  r.fail('wss://down2/');
  await read;
  expect(onSettled).toHaveBeenCalledWith(
    expect.objectContaining({ eosed: 1, failed: 2, cut: 0, outcome: 'all' }),
  );
});

test('the deadline is the backstop when fewer than K relays answer', async () => {
  const r = fakeRelays(['wss://a/', 'wss://stuck1/', 'wss://stuck2/']);
  const onSettled = jest.fn<void, [QuorumStats]>();
  let done = false;
  const read = queryRelaysQuorum({
    relays: r.urls,
    open: r.open,
    maxWait: 8000,
    quorum: { quorum: 2, graceMs: 1200 },
    onSettled,
  }).then((events) => {
    done = true;
    return events;
  });
  r.send('wss://a/', ev('1'));
  r.eose('wss://a/');
  await jest.advanceTimersByTimeAsync(7999);
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect((await read).map((e) => e.id)).toEqual(['1']);
  // Drains received events through the receive queue, like querySyncAbortable.
  expect(mockFinishAfterRelayReceive).toHaveBeenCalledTimes(1);
  expect(r.closed.has('wss://stuck1/') && r.closed.has('wss://stuck2/')).toBe(true);
  expect(onSettled).toHaveBeenCalledWith(
    expect.objectContaining({ eosed: 1, cut: 2, outcome: 'deadline' }),
  );
});

test('abort resolves immediately with what arrived and closes every pending REQ', async () => {
  const r = fakeRelays(['wss://a/', 'wss://b/']);
  const controller = new AbortController();
  const onSettled = jest.fn<void, [QuorumStats]>();
  const read = queryRelaysQuorum({
    relays: r.urls,
    open: r.open,
    maxWait: 8000,
    quorum: { quorum: 2, graceMs: 1200 },
    signal: controller.signal,
    onSettled,
  });
  r.send('wss://a/', ev('1'));
  controller.abort();
  expect((await read).map((e) => e.id)).toEqual(['1']);
  expect([...r.closed.keys()].sort()).toEqual(['wss://a/', 'wss://b/']);
  expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted' }));
  // Late frames after the abort are dropped before parse.
  r.send('wss://b/', ev('2'));
  expect(r.open.mock.calls[1][1].alreadyHaveEvent('3')).toBe(true);
});

test('an already-aborted signal opens no REQ', async () => {
  const r = fakeRelays(['wss://a/']);
  const controller = new AbortController();
  controller.abort();
  await expect(
    queryRelaysQuorum({
      relays: r.urls,
      open: r.open,
      maxWait: 8000,
      quorum: { quorum: 2, graceMs: 1200 },
      signal: controller.signal,
    }),
  ).resolves.toEqual([]);
  expect(r.open).not.toHaveBeenCalled();
});

test('known ids and cross-relay duplicates are skipped before parse', async () => {
  const r = fakeRelays(['wss://a/', 'wss://b/']);
  const onSettled = jest.fn<void, [QuorumStats]>();
  const read = queryRelaysQuorum({
    relays: r.urls,
    open: r.open,
    maxWait: 8000,
    quorum: { quorum: 2, graceMs: 1200 },
    alreadyHaveEvent: (id) => id === 'known',
    onSettled,
  });
  const [a, b] = [r.open.mock.calls[0][1], r.open.mock.calls[1][1]];
  expect(a.alreadyHaveEvent('known')).toBe(true);
  expect(a.alreadyHaveEvent('new')).toBe(false);
  expect(b.alreadyHaveEvent('new')).toBe(true); // already seen on relay a
  a.onevent(ev('new'));
  r.eose('wss://a/');
  r.eose('wss://b/');
  expect((await read).map((e) => e.id)).toEqual(['new']);
  expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ skippedKnown: 1 }));
});

test('a throwing onSettled still resolves the read', async () => {
  const r = fakeRelays(['wss://a/']);
  const read = queryRelaysQuorum({
    relays: r.urls,
    open: r.open,
    maxWait: 8000,
    quorum: { quorum: 2, graceMs: 1200 },
    onSettled: () => {
      throw new Error('logger blew up');
    },
  });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => r.eose('wss://a/')).not.toThrow();
  warn.mockRestore();
  await expect(read).resolves.toEqual([]);
});
