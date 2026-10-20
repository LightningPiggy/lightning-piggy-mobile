// #1656: a relay that answers after the publish window is reported as not
// accepting, yet the event lands. The receipt tells "timed out" apart from a
// refusal, and finds the event on the relay afterwards.
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
  const receipt = marmotSendReceipt(resultFor(response), network);
  expect(receipt.timedOut).toBe(true);
  await expect(receipt.isStored()).resolves.toBe(true);
  expect(mockQuery).toHaveBeenCalledWith([RELAY], [{ ids: [envelope.id] }], expect.any(Number));
});

it('tells an outright refusal apart from a timeout', async () => {
  const receipt = marmotSendReceipt(
    resultFor({ [RELAY]: { from: RELAY, ok: false, message: 'Error: blocked: not allowed' } }),
    { request: jest.fn().mockResolvedValue([]) },
  );
  expect(receipt.timedOut).toBe(false);
  await expect(receipt.isStored()).resolves.toBe(false);
});

it("doesn't count an unrelated event as the one sent", async () => {
  const receipt = marmotSendReceipt(
    resultFor({ [RELAY]: { from: RELAY, ok: false, message: 'publish timed out' } }),
    { request: jest.fn().mockResolvedValue([{ id: 'f'.repeat(64) }]) },
  );
  expect(receipt.timedOut).toBe(true);
  await expect(receipt.isStored()).resolves.toBe(false);
});
