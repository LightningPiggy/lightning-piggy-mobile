// #1656: a relay that answers after the publish window is reported as not
// accepting, yet the event lands. The receipt tells "timed out" apart from a
// refusal, and looks the event up on the relay afterwards — telling "not
// there" apart from "couldn't tell".
import type { Event } from 'nostr-tools';
import { createMarmotNetwork } from './marmotNetwork';
import { marmotSendReceipt } from './marmotSendReceipt';
import { RELAY_SKIPPED_REASON } from './relayHealth';
import { setCurrentUserPubkey } from './nostrActiveAccount';

const mockPublish = jest.fn();
const mockQuery = jest.fn();
jest.mock('./nostrPool', () => ({
  pool: {
    publish: (...args: unknown[]) => mockPublish(...args),
    querySyncFilters: (...args: unknown[]) => mockQuery(...args),
    resetTransports: jest.fn().mockResolvedValue(undefined),
  },
  trackRelays: jest.fn(),
}));

const RELAY = 'wss://relay.example.com/';
const envelope = { id: 'e'.repeat(64), kind: 445, tags: [] } as unknown as Event;
const resultFor = (response: Record<string, { from: string; ok: boolean; message?: string }>) =>
  [{ work: { kind: 'applicationMessage', envelope }, response }] as never;

// The account whose session sent it, active unless a test switches away.
const OWNER = 'a'.repeat(64);
const receiptOf = (results: Parameters<typeof marmotSendReceipt>[0]) =>
  marmotSendReceipt(results, OWNER);

beforeEach(() => {
  mockQuery.mockReset();
  setCurrentUserPubkey(OWNER);
});
afterEach(() => {
  jest.useRealTimers();
  setCurrentUserPubkey(null);
});

it('reports a slow relay as timed out, though its publish still lands afterwards', async () => {
  jest.useFakeTimers();
  let landed = false;
  // The relay OKs 12 s in — past the 10 s publish window.
  mockPublish.mockReturnValue([
    new Promise<string>((resolve) =>
      setTimeout(() => {
        landed = true;
        resolve('');
      }, 12_000),
    ),
  ]);
  const network = createMarmotNetwork(() => [], undefined, null);
  const published = network.publish([RELAY], envelope);
  await jest.advanceTimersByTimeAsync(10_000);
  const response = await published;
  expect(response[RELAY]).toMatchObject({ ok: false, message: 'Error: timeout' });
  expect(landed).toBe(false);

  // ...yet the publish was never cancelled: it lands, and the relay holds it.
  await jest.advanceTimersByTimeAsync(2_000);
  expect(landed).toBe(true);
  relaysAnswer({ [RELAY]: { events: [envelope], eose: true } });
  const receipt = receiptOf(resultFor(response));
  expect(receipt.indeterminate).toBe(true);
  await expect(receipt.lookup()).resolves.toBe('found');
  expect(mockQuery).toHaveBeenCalledWith([RELAY], [{ ids: [envelope.id] }], expect.any(Number), {
    requireEose: true,
  });
});

it('counts only an explicit relay refusal as definite', () => {
  const receipt = (message: string) =>
    receiptOf(resultFor({ [RELAY]: { from: RELAY, ok: false, message } }));
  expect(receipt('Error: blocked: not allowed').indeterminate).toBe(false);
  expect(receipt('Error: rate-limited: slow down').indeterminate).toBe(false);
  expect(receipt('Error: error: internal').indeterminate).toBe(false);
  // Never connected / sent on a closed socket: the EVENT never left.
  expect(receipt('Error: connection failure: Error: offline').indeterminate).toBe(false);
  expect(receipt("SendingOnClosedConnection: Tried to send message '[...]'").indeterminate).toBe(
    false,
  );
  // Skipped as unhealthy: nothing was sent.
  expect(receipt(`Error: ${RELAY_SKIPPED_REASON}`).indeterminate).toBe(false);
  // The socket closed after the EVENT went out, before its OK: it may be stored.
  expect(receipt('Error: relay connection closed').indeterminate).toBe(true);
  expect(receipt('Error: publish timed out').indeterminate).toBe(true);
});

// How each relay answers a lookup: what it streamed, and whether it then
// served the read to EOSE (a strict read rejects without it).
type RelayRead = { events: { id: string }[]; eose: boolean };
const relaysAnswer = (reads: Record<string, RelayRead>) =>
  mockQuery.mockImplementation(
    async (urls: string[], _f: unknown, _wait: number, opts?: { requireEose?: boolean }) => {
      const read = reads[urls[0]] ?? { events: [], eose: false };
      if (opts?.requireEose && !read.eose) throw new Error('did not reach EOSE');
      return read.events;
    },
  );

it('reports absent only when every relay completed the read without it', async () => {
  const OTHER = 'wss://other.example.com/';
  const twoRelays = () =>
    receiptOf(
      resultFor({
        [RELAY]: { from: RELAY, ok: false, message: 'Error: timeout' },
        [OTHER]: { from: OTHER, ok: false, message: 'Error: timeout' },
      }),
    );
  // Both completed; one returned an unrelated event: not ours anywhere.
  relaysAnswer({
    [RELAY]: { events: [{ id: 'f'.repeat(64) }], eose: true },
    [OTHER]: { events: [], eose: true },
  });
  await expect(twoRelays().lookup()).resolves.toBe('absent');
  // One answered empty, the other couldn't answer: it may hold it.
  relaysAnswer({ [RELAY]: { events: [], eose: true }, [OTHER]: { events: [], eose: false } });
  await expect(twoRelays().lookup()).resolves.toBe('unknown');
  // Any relay holding it is enough, whatever the others did.
  relaysAnswer({
    [RELAY]: { events: [], eose: false },
    [OTHER]: { events: [envelope], eose: true },
  });
  await expect(twoRelays().lookup()).resolves.toBe('found');
  // Each relay is asked on its own, strictly as well as laxly.
  expect(mockQuery).toHaveBeenCalledWith([OTHER], [{ ids: [envelope.id] }], expect.any(Number), {
    requireEose: true,
  });
  expect(mockQuery).toHaveBeenCalledWith([OTHER], [{ ids: [envelope.id] }], expect.any(Number));
});

it('counts a match even when the relay closed before EOSE', async () => {
  relaysAnswer({ [RELAY]: { events: [envelope], eose: false } });
  const receipt = receiptOf(
    resultFor({ [RELAY]: { from: RELAY, ok: false, message: 'Error: timeout' } }),
  );
  await expect(receipt.lookup()).resolves.toBe('found');
});

it('looks only at relays that may hold it', async () => {
  const OFFLINE = 'wss://offline.example.com/';
  const receipt = receiptOf(
    resultFor({
      [OFFLINE]: { from: OFFLINE, ok: false, message: 'Error: connection failure: offline' },
      [RELAY]: { from: RELAY, ok: false, message: 'Error: timeout' },
    }),
  );
  relaysAnswer({ [RELAY]: { events: [], eose: true } });
  // The never-connected relay can't hold it, so it can't make this unknown.
  await expect(receipt.lookup()).resolves.toBe('absent');
  expect(mockQuery.mock.calls.every(([urls]) => urls[0] === RELAY)).toBe(true);
});

it("can't establish anything while another account is active", async () => {
  const receipt = receiptOf(
    resultFor({ [RELAY]: { from: RELAY, ok: false, message: 'Error: timeout' } }),
  );
  // Switched before the look: its reads would route to the other account's relays.
  setCurrentUserPubkey('b'.repeat(64));
  relaysAnswer({ [RELAY]: { events: [], eose: true } });
  await expect(receipt.lookup()).resolves.toBe('unknown');
  expect(mockQuery).not.toHaveBeenCalled();
  // Switched while the read was out: the same.
  setCurrentUserPubkey(OWNER);
  mockQuery.mockImplementation(async () => {
    setCurrentUserPubkey('b'.repeat(64));
    return [];
  });
  await expect(receipt.lookup()).resolves.toBe('unknown');
  // Back on the sending account, an EOSE-served miss counts again.
  setCurrentUserPubkey(OWNER);
  relaysAnswer({ [RELAY]: { events: [], eose: true } });
  await expect(receipt.lookup()).resolves.toBe('absent');
});

it('belongs to the sending account even if the publish returned after a switch', async () => {
  // Switched while the publish was out: the receipt still names the sender...
  setCurrentUserPubkey('b'.repeat(64));
  const receipt = receiptOf(
    resultFor({ [RELAY]: { from: RELAY, ok: false, message: 'Error: timeout' } }),
  );
  relaysAnswer({ [RELAY]: { events: [], eose: true } });
  // ...so the other account's routing can't establish anything for it.
  await expect(receipt.lookup()).resolves.toBe('unknown');
  setCurrentUserPubkey(OWNER.toUpperCase());
  await expect(receipt.lookup()).resolves.toBe('absent');
});
