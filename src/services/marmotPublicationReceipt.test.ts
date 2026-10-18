import type { Event as NostrEvent } from 'nostr-tools';
import { publishWithReceipt } from './marmotPublicationReceipt';
import { createMemoryMarmotBackend } from './marmotStore';
import { selectHealthyRelays } from './relayHealth';

jest.mock('./relayHealth', () => ({ selectHealthyRelays: jest.fn((urls: string[]) => urls) }));
const A = 'wss://one.example';
const B = 'wss://two.example';
const event = { id: 'signed-key', kind: 30443 } as NostrEvent;
beforeEach(() => jest.mocked(selectHealthyRelays).mockImplementation((urls) => [...urls]));

it('persists individual acknowledgements and sends the same event only to missed destinations', async () => {
  const backend = createMemoryMarmotBackend();
  let recovered = false;
  const publish = jest.fn(async (targets: string[], _event: NostrEvent) =>
    Object.fromEntries(targets.map((r) => [r, { from: r, ok: r === A || recovered }])),
  );
  const args = { network: { publish }, backend, key: 'keyAcks', event, targets: [A, B] };
  expect(await publishWithReceipt(args)).toBe(false);
  recovered = true;
  expect(await publishWithReceipt(args)).toBe(true);
  expect(publish.mock.calls.map((c) => c[0])).toEqual([[A, B], [B]]);
  expect(publish.mock.calls.every((c) => c[1] === event)).toBe(true);
  expect(await publishWithReceipt(args)).toBe(true);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(await publishWithReceipt({ ...args, event: { ...event, id: 'replacement' } })).toBe(true);
  expect(publish.mock.calls[2][0]).toEqual([A, B]);
});
it('never acknowledges parked relays, then retries them after recovery', async () => {
  const backend = createMemoryMarmotBackend();
  const publish = jest.fn(async (targets: string[]) =>
    Object.fromEntries(targets.map((r) => [r, { from: r, ok: true }])),
  );
  const args = { network: { publish }, backend, key: 'listAcks', event, targets: [A, B] };
  jest.mocked(selectHealthyRelays).mockReturnValueOnce([A]);
  expect(await publishWithReceipt(args)).toBe(false);
  expect(await publishWithReceipt(args)).toBe(true);
  expect(publish.mock.calls.map((c) => c[0])).toEqual([[A], [B]]);
});
it('uses fresh-key acknowledgements without repeating its initial publication', async () => {
  const backend = createMemoryMarmotBackend();
  const publish = jest.fn(async (targets: string[]) =>
    Object.fromEntries(targets.map((r) => [r, { from: r, ok: true }])),
  );
  const args = { network: { publish }, backend, key: 'keyAcks', event, targets: [A, B] };
  expect(await publishWithReceipt({ ...args, initial: [`${A}/`], alreadyAttempted: true })).toBe(
    false,
  );
  expect(publish).not.toHaveBeenCalled();
  expect(await publishWithReceipt(args)).toBe(true);
  expect(publish.mock.calls[0][0]).toEqual([B]);
});

it('persists completed batches if a later batch fails and retries only the remainder', async () => {
  const backend = createMemoryMarmotBackend();
  const targets = Array.from({ length: 30 }, (_, i) => `wss://relay-${i}.example`);
  let fail = true;
  const publish = jest.fn(async (batch: string[]) => {
    if (batch.includes(targets[12]) && fail) throw new Error('disconnected');
    return Object.fromEntries(batch.map((relay) => [relay, { from: relay, ok: true }]));
  });
  const args = { network: { publish }, backend, key: 'listAcks', event, targets };
  await expect(publishWithReceipt(args)).rejects.toThrow('disconnected');
  fail = false;
  expect(await publishWithReceipt(args)).toBe(true);
  expect(publish.mock.calls.map(([batch]) => batch)).toEqual([
    targets.slice(0, 12),
    targets.slice(12, 24),
    targets.slice(12, 24),
    targets.slice(24),
  ]);
});
