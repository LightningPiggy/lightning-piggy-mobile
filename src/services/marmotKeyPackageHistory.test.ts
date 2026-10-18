import type { Event as NostrEvent } from 'nostr-tools';

import { createMemoryMarmotBackend } from './marmotStore';
import { createStopGate, fenceBackend } from './marmotSessionFence';
import {
  KEY_PACKAGE_HISTORY_SECS,
  keyPackageRelayHistory,
  rememberKeyPackageRelays,
} from './marmotKeyPackageHistory';

jest.mock('@internet-privacy/marmot-ts', () => ({
  ...jest.requireActual('@internet-privacy/marmot-ts'),
  getKeyPackageLifetime: (event: NostrEvent) =>
    event.content
      ? { notBefore: BigInt(event.created_at), notAfter: BigInt(event.content) }
      : undefined,
}));

const now = 1_800_000_000;
const event = (id: string, expires: number) =>
  ({
    id,
    created_at: now,
    content: String(expires),
  }) as NostrEvent;

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now * 1000));
afterEach(() => jest.restoreAllMocks());

it('expires obsolete copies while retaining destinations of a newer copied key', async () => {
  const backend = createMemoryMarmotBackend();
  await rememberKeyPackageRelays(
    backend,
    ['wss://old.example', 'wss://shared.example'],
    event('a', now + 100),
  );
  await rememberKeyPackageRelays(
    backend,
    ['wss://new.example', 'wss://shared.example'],
    event('b', now + 500),
  );
  jest.spyOn(Date, 'now').mockReturnValue((now + 4000) * 1000);
  expect(await keyPackageRelayHistory(backend)).toEqual({
    'wss://new.example': now + 4100,
    'wss://shared.example': now + 4100,
  });
  jest.spyOn(Date, 'now').mockReturnValue((now + 5000) * 1000);
  expect(await keyPackageRelayHistory(backend)).toEqual({});
});

it('migrates legacy relay arrays once without renewing their deadline on reads', async () => {
  const backend = createMemoryMarmotBackend();
  await backend.set('keyPackageDiscovery', 'relays', JSON.stringify(['wss://legacy.example']));
  expect(await keyPackageRelayHistory(backend)).toEqual({
    'wss://legacy.example': now + KEY_PACKAGE_HISTORY_SECS,
  });
  expect(await backend.get('keyPackageDiscovery', 'relays')).toBeNull();
  jest.spyOn(Date, 'now').mockReturnValue((now + KEY_PACKAGE_HISTORY_SECS + 1) * 1000);
  expect(await keyPackageRelayHistory(backend)).toEqual({});
});

it('expires undecodable legacy keys by publication age rather than extending each retry', async () => {
  const backend = createMemoryMarmotBackend();
  const old = { id: 'old', created_at: now, content: '' } as NostrEvent;
  await rememberKeyPackageRelays(backend, ['wss://old.example'], old);
  jest.spyOn(Date, 'now').mockReturnValue((now + KEY_PACKAGE_HISTORY_SECS + 1) * 1000);
  await rememberKeyPackageRelays(backend, ['wss://old.example'], old);
  expect(await keyPackageRelayHistory(backend)).toEqual({});
});

it('preserves copied destinations when an inventory migration/prune overlaps maintenance', async () => {
  const storage = createMemoryMarmotBackend();
  await storage.set('keyPackageDiscovery', 'relays', JSON.stringify(['wss://legacy.example']));
  await storage.set(
    'keyPackageDiscovery',
    'relayHistory',
    JSON.stringify({ 'wss://expired.example': now - 1 }),
  );
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const inventory = {
    ...storage,
    owner: 'alice',
    set: async (namespace: string, key: string, value: string) => {
      if (key === 'relayHistory') {
        entered();
        await blocked;
      }
      await storage.set(namespace, key, value);
    },
  };
  // Separate adapters for the same account, as inventory and session use.
  const maintenance = fenceBackend({ ...storage, owner: 'alice' }, createStopGate());
  const read = keyPackageRelayHistory(inventory);
  await started;
  const copy = rememberKeyPackageRelays(
    maintenance,
    ['wss://copy.example'],
    event('copy', now + 500),
  );
  // Let an unprotected update finish before the stale inventory write lands.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all([read, copy]);
  // Retirement reads this same history; the signed key need not tag the copy.
  expect(await keyPackageRelayHistory(maintenance)).toEqual({
    'wss://legacy.example': now + KEY_PACKAGE_HISTORY_SECS,
    'wss://copy.example': now + 4100,
  });
});

it('merges concurrent copy destinations and retains the longest lifetime', async () => {
  const backend = createMemoryMarmotBackend();
  await Promise.all([
    rememberKeyPackageRelays(
      backend,
      ['wss://first.example', 'wss://shared.example'],
      event('first', now + 500),
    ),
    rememberKeyPackageRelays(
      backend,
      ['wss://second.example', 'wss://shared.example'],
      event('second', now + 100),
    ),
    keyPackageRelayHistory(backend),
  ]);
  expect(await keyPackageRelayHistory(backend)).toEqual({
    'wss://first.example': now + 4100,
    'wss://second.example': now + 3700,
    'wss://shared.example': now + 4100,
  });
});

it('continues queued operations after a storage failure', async () => {
  const backend = createMemoryMarmotBackend();
  jest.spyOn(backend, 'set').mockRejectedValueOnce(new Error('storage failed'));
  const failed = keyPackageRelayHistory(backend);
  const copy = rememberKeyPackageRelays(backend, ['wss://copy.example'], event('copy', now + 500));
  await expect(failed).rejects.toThrow('storage failed');
  await copy;
  expect(await keyPackageRelayHistory(backend)).toEqual({ 'wss://copy.example': now + 4100 });
});
