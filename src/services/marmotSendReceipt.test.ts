// #1656: a relay that answers after the publish window is reported as not
// accepting, yet the event lands. The receipt tells "timed out" apart from a
// refusal, and looks the event up on the relay afterwards — telling "not
// there" apart from "couldn't tell".
import type { Event } from 'nostr-tools';
import { createMarmotNetwork } from './marmotNetwork';
import { marmotSendReceipt } from './marmotSendReceipt';

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

beforeEach(() => mockQuery.mockReset());
afterEach(() => jest.useRealTimers());

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
  mockQuery.mockResolvedValue([envelope]);
  const receipt = marmotSendReceipt(resultFor(response));
  expect(receipt.indeterminate).toBe(true);
  await expect(receipt.lookup()).resolves.toBe('found');
  expect(mockQuery).toHaveBeenCalledWith([RELAY], [{ ids: [envelope.id] }], expect.any(Number), {
    requireEose: true,
  });
});

it('counts only an explicit relay refusal as definite', () => {
  const receipt = (message: string) =>
    marmotSendReceipt(resultFor({ [RELAY]: { from: RELAY, ok: false, message } }));
  expect(receipt('Error: blocked: not allowed').indeterminate).toBe(false);
  expect(receipt('Error: rate-limited: slow down').indeterminate).toBe(false);
  expect(receipt('Error: error: internal').indeterminate).toBe(false);
  // Never connected / sent on a closed socket: the EVENT never left.
  expect(receipt('Error: connection failure: Error: offline').indeterminate).toBe(false);
  expect(receipt("SendingOnClosedConnection: Tried to send message '[...]'").indeterminate).toBe(
    false,
  );
  // The socket closed after the EVENT went out, before its OK: it may be stored.
  expect(receipt('Error: relay connection closed').indeterminate).toBe(true);
  expect(receipt('Error: publish timed out').indeterminate).toBe(true);
});

it('reports absent only when every relay completed the read without it', async () => {
  const OTHER = 'wss://other.example.com/';
  const twoRelays = () =>
    marmotSendReceipt(
      resultFor({
        [RELAY]: { from: RELAY, ok: false, message: 'Error: timeout' },
        [OTHER]: { from: OTHER, ok: false, message: 'Error: timeout' },
      }),
    );
  // Both completed; one returned an unrelated event: not ours anywhere.
  mockQuery.mockResolvedValueOnce([{ id: 'f'.repeat(64) }]).mockResolvedValueOnce([]);
  await expect(twoRelays().lookup()).resolves.toBe('absent');
  // One answered empty, the other couldn't answer: it may hold it.
  mockQuery.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('did not reach EOSE'));
  await expect(twoRelays().lookup()).resolves.toBe('unknown');
  // Any relay holding it is enough, whatever the others did.
  mockQuery.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([envelope]);
  await expect(twoRelays().lookup()).resolves.toBe('found');
  // Each relay is asked on its own.
  expect(mockQuery).toHaveBeenCalledWith([OTHER], [{ ids: [envelope.id] }], expect.any(Number), {
    requireEose: true,
  });
});
