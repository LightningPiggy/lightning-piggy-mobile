import { forgetAppRelayPrefs, setAppRelayEnabled } from './appRelayPrefs';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import type { MarmotClient } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent, EventTemplate, Filter } from 'nostr-tools';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { fetchKeyPackageEvents } from './marmotInvitees';
import { maintainKeyPackage } from './marmotKeyPackageLifecycle';
import { maintainDiscoverableKeyPackage } from './marmotKeyPackageDiscovery';
import { MARMOT_KEY_PACKAGE_RELAYS } from './marmotKeyPackageRelays';
import { createMemoryMarmotBackend } from './marmotStore';

jest.mock('./marmotKeyPackageLifecycle', () => ({
  maintainKeyPackage: jest.fn(async () => 'unchanged'),
  currentKeyPackage: (list: unknown[]) => list[0],
}));

const owner = 'a'.repeat(64);
const event = {
  id: 'key',
  kind: 30443,
  created_at: 1,
  pubkey: owner,
  tags: [],
  content: 'key',
  sig: '',
} as NostrEvent;
function setup() {
  const backend = createMemoryMarmotBackend();
  const publish = jest.fn(async (relays: string[], _event: NostrEvent) =>
    Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }])),
  );
  const signEvent = jest.fn(async (draft: EventTemplate) => ({
    ...draft,
    id: 'list',
    pubkey: owner,
    sig: '',
  }));
  const client = {
    keyPackages: { list: async () => [{ published: [event] }] },
    network: { publish },
    signer: { signEvent },
  } as unknown as Pick<MarmotClient, 'keyPackages' | 'network' | 'signer'>;
  const opts = {
    relays: ['wss://own.example'],
    slot: 'slot',
    client: 'test',
    isUpToDate: () => true,
    acceptedRelays: () => ['wss://own.example', ...MARMOT_KEY_PACKAGE_RELAYS],
  };
  return { backend, client, publish, signEvent, opts };
}
beforeEach(() => jest.mocked(maintainKeyPackage).mockResolvedValue('unchanged'));
it('migrates an existing key, advertises 10051 on indexers, and does no writes on relaunch', async () => {
  const t = setup();
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls[0][0]).toEqual(['wss://own.example', ...MARMOT_KEY_PACKAGE_RELAYS]);
  expect(t.publish.mock.calls[0][1]).toBe(event);
  expect(t.publish.mock.calls[1][0]).toContain('wss://purplepag.es');
  expect(t.publish.mock.calls[1][1].kind).toBe(10051);
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.signEvent).toHaveBeenCalledTimes(1);
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, {
    ...t.opts,
    relays: ['wss://changed.example'],
  });
  expect(t.publish).toHaveBeenCalledTimes(4);
  expect(t.signEvent).toHaveBeenCalledTimes(2);
});
it('does not duplicate a newly published key and does not publish a list after key failure', async () => {
  const t = setup();
  jest.mocked(maintainKeyPackage).mockResolvedValueOnce('failed');
  await expect(maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts)).resolves.toBe(
    'failed',
  );
  expect(t.publish).not.toHaveBeenCalled();
  jest.mocked(maintainKeyPackage).mockResolvedValueOnce('published');
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  expect(t.publish).toHaveBeenCalledTimes(1);
  expect(t.publish.mock.calls[0][1].kind).toBe(10051);
});
it('retries a rejected list without republishing the accepted key', async () => {
  const t = setup();
  t.publish
    .mockImplementationOnce(async (relays) =>
      Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }])),
    )
    .mockImplementationOnce(async () => ({ relay: { from: 'relay', ok: false } }));
  await expect(maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts)).rejects.toThrow(
    'not accepted',
  );
  expect(await t.backend.get('keyPackageDiscovery', 'failed')).toBe('true');
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  expect(t.publish.mock.calls.map((c) => c[1].kind)).toEqual([30443, 10051, 10051]);
  expect(t.signEvent).toHaveBeenCalledTimes(1);
  expect(await t.backend.get('keyPackageDiscovery', 'failed')).toBe('false');
});
it('never signs or publishes discovery after cancellation', async () => {
  const t = setup();
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, {
    ...t.opts,
    cancelled: () => true,
  });
  expect(t.publish).not.toHaveBeenCalled();
  expect(t.signEvent).not.toHaveBeenCalled();
});
it('publishes both the key and list to LAN only for locked owners', async () => {
  const t = setup();
  await maintainDiscoverableKeyPackage(t.client, t.backend, [...TEST_ACCOUNT_PUBKEYS][0], t.opts);
  expect(
    t.publish.mock.calls.every((c) => JSON.stringify(c[0]) === JSON.stringify([TEST_RELAY_URL])),
  ).toBe(true);
  expect(t.signEvent.mock.calls[0][0].tags).toEqual([['relay', TEST_RELAY_URL]]);
});
it('reads newest peer 10051 first, then NIP-65 write relays, then well-known relays, bounded', async () => {
  const lists = [
    { ...event, kind: 10051, id: 'old', created_at: 1, tags: [['relay', 'wss://stale.example']] },
    { ...event, kind: 10051, id: 'new', created_at: 2, tags: [['relay', 'wss://key.example']] },
    {
      ...event,
      kind: 10002,
      tags: [
        ['r', 'wss://write.example', 'write'],
        ['r', 'wss://read.example', 'read'],
      ],
    },
  ];
  const request = jest.fn(async (_relays: string[], filter: Filter | Filter[]) =>
    Array.isArray(filter) ? lists : [event],
  );
  expect(await fetchKeyPackageEvents({ request }, ['wss://lookup.example'], owner)).toEqual([
    event,
  ]);
  expect(request.mock.calls[0][0]).toContain('wss://purplepag.es');
  expect(request.mock.calls[0][1]).toEqual([
    { kinds: [10051], authors: [owner], limit: 1 },
    { kinds: [10002], authors: [owner], limit: 1 },
  ]);
  expect(request.mock.calls[1][0]).toEqual([
    'wss://key.example',
    'wss://write.example',
    ...MARMOT_KEY_PACKAGE_RELAYS,
    'wss://lookup.example',
  ]);
  expect(request.mock.calls[1][1]).toEqual({ kinds: [30443], authors: [owner], limit: 50 });
});

it('retains well-known destinations even when peer relay lists are oversized', async () => {
  const many = (prefix: string) =>
    Array.from({ length: 100 }, (_, i) => `wss://${prefix}${i}.example`);
  const request = jest.fn(async (_relays: string[], filters: Filter | Filter[]) =>
    Array.isArray(filters)
      ? [
          { ...event, kind: 10051, tags: many('key').map((r) => ['relay', r]) },
          { ...event, kind: 10002, tags: many('write').map((r) => ['r', r]) },
        ]
      : [],
  );
  await fetchKeyPackageEvents({ request }, many('lookup'), owner);
  expect(request.mock.calls[0][0].length).toBeLessThanOrEqual(12);
  expect(request.mock.calls[0][0]).toEqual(
    expect.arrayContaining(['wss://purplepag.es', 'wss://user.kindpag.es']),
  );
  expect(request.mock.calls[1][0]).toHaveLength(27);
  expect(request.mock.calls[1][0]).toEqual(expect.arrayContaining(MARMOT_KEY_PACKAGE_RELAYS));
});
it('checks cancellation after storage waits before asking a signer', async () => {
  const t = setup();
  let stopped = false;
  const get = t.backend.get;
  t.backend.get = async (namespace, key) => {
    const result = await get(namespace, key);
    if (key === 'timestamp') stopped = true;
    return result;
  };
  await expect(
    maintainDiscoverableKeyPackage(t.client, t.backend, owner, {
      ...t.opts,
      cancelled: () => stopped,
    }),
  ).rejects.toThrow('cancelled');
  expect(t.signEvent).not.toHaveBeenCalled();
});

it('advertises accepted keys while retaining partial receipts for later retries', async () => {
  const t = setup();
  let recovered = false;
  t.publish.mockImplementation(async (relays) =>
    Object.fromEntries(
      relays.map((r) => [r, { from: r, ok: !r.includes('us.whitenoise') || recovered }]),
    ),
  );
  await expect(maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts)).resolves.toBe(
    'failed',
  );
  expect(t.publish.mock.calls.map((c) => c[1].kind)).toEqual([30443, 10051]);
  expect(await t.backend.get('keyPackageDiscovery', 'list')).toBeNull();
  recovered = true;
  await expect(maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts)).resolves.toBe(
    'unchanged',
  );
  expect(t.publish.mock.calls.slice(2).map((c) => c[0])).toEqual([
    ['wss://relay.us.whitenoise.chat'],
    ['wss://relay.us.whitenoise.chat'],
  ]);
  expect(t.signEvent).toHaveBeenCalledTimes(1);
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  expect(t.publish).toHaveBeenCalledTimes(4);
});

it('corrects a partially published relay edit when settings revert, retrying the same corrective event', async () => {
  const t = setup();
  t.signEvent.mockImplementation(async (draft) => ({
    ...draft,
    id: `list-${draft.created_at}`,
    pubkey: owner,
    sig: '',
  }));
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  const original = t.publish.mock.calls.find(([, signed]) => signed.kind === 10051)![1];
  let rejectedRelay: string | undefined = 'wss://purplepag.es';
  t.publish.mockImplementation(async (relays) =>
    Object.fromEntries(relays.map((r) => [r, { from: r, ok: r !== rejectedRelay }])),
  );
  await expect(
    maintainDiscoverableKeyPackage(t.client, t.backend, owner, {
      ...t.opts,
      relays: ['wss://changed.example'],
    }),
  ).resolves.toBe('failed');
  const partial = JSON.parse(
    (await t.backend.get('keyPackageDiscovery', 'pendingList'))!,
  ) as NostrEvent;
  expect(partial.created_at).toBeGreaterThan(original.created_at);
  expect(await t.backend.get('keyPackageDiscovery', 'failed')).toBe('true');

  // Fail the corrective event on the removed relay, then recover on a later run.
  rejectedRelay = 'wss://changed.example';
  await expect(maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts)).resolves.toBe(
    'failed',
  );
  const corrective = JSON.parse(
    (await t.backend.get('keyPackageDiscovery', 'pendingList'))!,
  ) as NostrEvent;
  expect(corrective.created_at).toBeGreaterThan(partial.created_at);
  expect(corrective.tags).toEqual(original.tags);
  expect(t.publish.mock.calls.at(-1)![0]).toEqual(
    expect.arrayContaining(['wss://own.example', 'wss://changed.example', 'wss://purplepag.es']),
  );
  expect(await t.backend.get('keyPackageDiscovery', 'failed')).toBe('true');

  rejectedRelay = undefined;
  await expect(maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts)).resolves.toBe(
    'unchanged',
  );
  expect(t.publish.mock.calls.at(-1)).toEqual([['wss://changed.example'], corrective]);
  expect(t.signEvent).toHaveBeenCalledTimes(3);
  expect(await t.backend.get('keyPackageDiscovery', 'failed')).toBe('false');
  const calls = t.publish.mock.calls.length;
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  expect(t.publish).toHaveBeenCalledTimes(calls);
});

it('bounds every batch across 30 relay edits without retaining acknowledged corrections', async () => {
  const t = setup();
  t.signEvent.mockImplementation(async (draft) => ({
    ...draft,
    id: `list-${draft.created_at}`,
    pubkey: owner,
    sig: '',
  }));
  let recovered = false;
  const rejecting = 'wss://edit-0-0.example';
  t.publish.mockImplementation(async (relays) =>
    Object.fromEntries(relays.map((r) => [r, { from: r, ok: r !== rejecting || recovered }])),
  );
  for (let edit = 0; edit < 30; edit++) {
    await expect(
      maintainDiscoverableKeyPackage(t.client, t.backend, owner, {
        ...t.opts,
        relays: Array.from({ length: 9 }, (_, i) => `wss://edit-${edit}-${i}.example`),
      }),
    ).resolves.toBe('failed');
    expect(JSON.parse((await t.backend.get('keyPackageDiscovery', 'pendingListTargets'))!)).toEqual(
      [rejecting],
    );
  }
  expect(t.publish.mock.calls.every(([relays]) => relays.length <= 12)).toBe(true);
  const finalList = t.publish.mock.calls.filter(([, signed]) => signed.kind === 10051).at(-1)![1];
  expect(
    t.publish.mock.calls
      .filter(([, signed]) => signed.id === finalList.id)
      .flatMap(([relays]) => relays),
  ).not.toContain('wss://edit-0-1.example');

  // Restart with the persisted queue: the rejecting destination gets the same
  // signed correction, and acknowledged removed destinations stay retired.
  recovered = true;
  const calls = t.publish.mock.calls.length;
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, {
    ...t.opts,
    relays: Array.from({ length: 9 }, (_, i) => `wss://edit-29-${i}.example`),
  });
  expect(t.publish.mock.calls.slice(calls)).toEqual([[[rejecting], finalList]]);
});

it('keeps discovery indexers bound to the owner after the active account changes', async () => {
  const indexer = RELAY_LIST_INDEXERS[0];
  await setAppRelayEnabled(owner, 'indexers', indexer, false);
  const t = setup();
  setCurrentUserPubkey(null);
  await maintainDiscoverableKeyPackage(t.client, t.backend, owner, t.opts);
  expect(t.publish.mock.calls[1][0]).not.toContain(indexer);
  expect(t.publish.mock.calls[1][0]).toContain(RELAY_LIST_INDEXERS[1]);
  await setAppRelayEnabled(owner, 'indexers', indexer, true);
  await forgetAppRelayPrefs(owner);
});
