import { forgetAppRelayPrefs, setAppRelayEnabled } from './appRelayPrefs';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import { MARMOT_KEY_PACKAGE_RELAYS } from './marmotKeyPackageRelays';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event as NostrEvent,
} from 'nostr-tools';
import {
  loadInvitationKeys,
  queryInvitationKeys,
  removeInvitationDevices,
  type RemoveDevicesArgs,
} from './marmotInvitationKeys';
import { groupInvitationDevices, shapeInvitationKeys } from './marmotInvitationDevices';
import { createMemoryMarmotBackend, createSqliteMarmotBackend } from './marmotStore';
import type { RetireTransport } from './marmotKeyPackageRetire';
import { pool } from './nostrPool';

jest.mock('./nostrPool', () => ({
  pool: { subscribeManyEose: jest.fn() },
  trackRelays: jest.fn(),
}));
jest.mock('./marmotStore', () => ({
  ...jest.requireActual('./marmotStore'),
  createSqliteMarmotBackend: jest.fn(),
}));

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const sk = generateSecretKey();
const owner = getPublicKey(sk);
const RELAY = 'wss://one.test/';
const event = (id: string, slot = 'slot', at = NOW, content = 'key'): NostrEvent => ({
  id,
  pubkey: owner,
  kind: 30443,
  created_at: at,
  content,
  sig: '',
  tags: [
    ['d', slot],
    ['client', 'White Noise Android'],
  ],
});

let backend: ReturnType<typeof createMemoryMarmotBackend>;
beforeEach(() => {
  jest.clearAllMocks();
  backend = createMemoryMarmotBackend();
  jest.mocked(createSqliteMarmotBackend).mockReturnValue(backend);
});

describe('loadInvitationKeys', () => {
  test('queries newest NIP-65 relays with bounds and reports incomplete inventory', async () => {
    const fetch = jest.fn(async (relays: string[], filter) => {
      if (filter.kinds[0] === 10002)
        return [
          { ...event('old', '', 100), kind: 10002, tags: [['r', 'wss://old.test']] },
          { ...event('new', '', 200), kind: 10002, tags: [['r', 'wss://new.test']] },
        ];
      if (relays[0] === 'wss://broken.test') throw new Error('offline');
      return [event('a')];
    });
    const result = await loadInvitationKeys(owner, ['wss://broken.test'], fetch);
    expect(result.partial).toBe(true);
    expect(fetch.mock.calls.some(([rs]) => rs.includes('wss://new.test'))).toBe(true);
    expect(fetch.mock.calls.some(([rs]) => rs.includes('wss://old.test'))).toBe(false);
    for (const [rs, filter] of fetch.mock.calls) {
      expect(rs.length).toBeLessThanOrEqual(12);
      expect(filter.limit).toBeLessThanOrEqual(100);
      expect(filter.authors).toEqual([owner]);
    }
  });

  test("falls back to configured relays when NIP-65 discovery fails, and reports this phone's slot", async () => {
    await backend.set('meta', 'keyPackageSlot', 'mine');
    const result = await loadInvitationKeys(owner, ['wss://one.test'], async (_, filter) => {
      if (filter.kinds?.[0] === 10002) throw new Error('offline');
      return [event('a', 'mine')];
    });
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].thisPhone).toBe(true);
    expect(result.localSlot).toBe('mine');
    expect(result.partial).toBe(true);
  });
});

/** A relay: answers queries from `held`, records what's published. */
function relay(held: NostrEvent[], accepts = true) {
  const published: NostrEvent[] = [];
  const transport: RetireTransport = {
    async query(_relays, filter) {
      return held.filter(
        (e) =>
          filter.kinds?.includes(e.kind) &&
          (!filter['#d'] || e.tags.some((t) => t[0] === 'd' && filter['#d']!.includes(t[1]))),
      );
    },
    async publish(relays, e) {
      published.push(e);
      return accepts ? relays : [];
    },
  };
  return { transport, published };
}

const devicesOf = (events: NostrEvent[], local?: string) =>
  groupInvitationDevices(
    shapeInvitationKeys(owner, [{ relay: RELAY, events }], local ? [local] : []),
    local,
  );

function removal(
  devices: RemoveDevicesArgs['devices'],
  transport: RetireTransport,
  extra: Partial<RemoveDevicesArgs> = {},
) {
  const sign = jest.fn(async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk));
  const args: RemoveDevicesArgs = {
    owner,
    devices,
    relays: [RELAY],
    sign,
    isCurrent: () => true,
    transport,
    ...extra,
  };
  return { sign, run: () => removeInvitationDevices(args) };
}

describe('removeInvitationDevices', () => {
  const stale = () => event('a', 'gone', NOW - 40 * DAY);

  test('removes an old device: one deletion plus one empty replacement in its slot', async () => {
    const r = relay([stale()]);
    const old = devicesOf([stale()]).filter((d) => d.old);
    const { sign, run } = removal(old, r.transport, { onlyIfStillOld: true });
    await expect(run()).resolves.toBe(1);
    expect(sign).toHaveBeenCalledTimes(2); // = signerApprovals(1)
    expect(r.published.map((e) => [e.kind, e.content])).toEqual([
      [5, ''],
      [30443, ''],
    ]);
    expect(r.published[1].tags).toEqual([['d', 'gone']]);
  });

  test('bulk removal never deletes a device refreshed after the list loaded', async () => {
    const old = devicesOf([stale()]).filter((d) => d.old);
    // Another device refreshed its key between loading the list and confirming.
    const r = relay([stale(), event('fresh', 'gone', NOW - 5)]);
    const { sign, run } = removal(old, r.transport, { onlyIfStillOld: true });
    await expect(run()).resolves.toBe(0);
    expect(sign).not.toHaveBeenCalled();
    expect(r.published).toEqual([]);
  });

  test("never this phone's slot, before anything is signed", async () => {
    await backend.set('meta', 'keyPackageSlot', 'mine');
    const r = relay([event('m', 'mine')]);
    const phone = devicesOf([event('m', 'mine')], 'mine');
    const { sign, run } = removal(phone, r.transport);
    await expect(run()).rejects.toThrow('only be refreshed');
    // Even if mislabelled as another device.
    const disguised = phone.map((d) => ({ ...d, kind: 'lightningPiggy' as const }));
    await expect(removal(disguised, r.transport).run()).rejects.toThrow('only be refreshed');
    expect(sign).not.toHaveBeenCalled();
  });

  test('rejects foreign keys and a changed account before signing', async () => {
    const r = relay([event('a', 'other')]);
    const rows = devicesOf([event('a', 'other')]).filter((d) => d.kind !== 'thisPhone');
    const stopped = removal(rows, r.transport, { isCurrent: () => false });
    await expect(stopped.run()).rejects.toThrow('Account changed');
    rows[0].versions[0].event.pubkey = 'cd'.repeat(32);
    const foreign = removal(rows, r.transport);
    await expect(foreign.run()).rejects.toThrow('another account');
    expect(stopped.sign).not.toHaveBeenCalled();
    expect(foreign.sign).not.toHaveBeenCalled();
  });

  test('reports failure when no relay accepts, instead of success', async () => {
    const r = relay([event('a', 'other')], false);
    const rows = devicesOf([event('a', 'other')]).filter((d) => d.kind !== 'thisPhone');
    await expect(removal(rows, r.transport).run()).rejects.toThrow('incomplete');
  });
});

describe('queryInvitationKeys', () => {
  test('a relay deadline rejects before nostr-tools synthesizes EOSE', async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    jest.mocked(pool.subscribeManyEose).mockReturnValue({ close });
    const result = queryInvitationKeys(['wss://slow.test'], { kinds: [30443], limit: 100 });
    const rejected = expect(result).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
    expect(jest.mocked(pool.subscribeManyEose).mock.calls[0][2].maxWait).toBe(6000);
    jest.useRealTimers();
  });

  test('a genuine completed relay scan clears its deadline', async () => {
    jest.useFakeTimers();
    jest.mocked(pool.subscribeManyEose).mockImplementation((_relays, _filter, params) => {
      params.onevent?.(event('a'));
      params.onclose?.(['closed automatically on eose']);
      return { close: jest.fn() };
    });
    await expect(queryInvitationKeys(['wss://one.test'], { limit: 100 })).resolves.toEqual([
      event('a'),
    ]);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});

test('inventory discovers 10051 destinations and exposes local publication failure', async () => {
  await backend.set('keyPackageDiscovery', 'failed', 'true');
  const fetch = jest.fn(async (_relays: string[], filter) => {
    if (filter.kinds.includes(10051))
      return [{ ...event('list'), kind: 10051, tags: [['relay', 'wss://key-package.example']] }];
    return [];
  });
  const result = await loadInvitationKeys(owner, [], fetch);
  expect(result.publicationFailed).toBe(true);
  expect(fetch.mock.calls.some(([rs]) => rs.includes('wss://key-package.example'))).toBe(true);
  expect(fetch.mock.calls.some(([rs]) => rs.includes('wss://relay.eu.whitenoise.chat'))).toBe(true);
});

test('reserves inventory slots for well-known relays with an oversized 10051', async () => {
  const fetch = jest.fn(async (_relays: string[], filter) =>
    filter.kinds.includes(10051)
      ? [
          {
            ...event('list'),
            kind: 10051,
            tags: Array.from({ length: 20 }, (_, i) => ['relay', `wss://owner${i}.example`]),
          },
        ]
      : [],
  );
  const result = await loadInvitationKeys(owner, [], fetch);
  const targets = fetch.mock.calls.filter(([, f]) => f.kinds[0] === 30443).flatMap(([rs]) => rs);
  expect(targets).toHaveLength(12);
  expect(targets).toEqual(
    expect.arrayContaining([
      'wss://relay.eu.whitenoise.chat',
      'wss://relay.us.whitenoise.chat',
      'wss://relay.primal.net',
    ]),
  );
  expect(result.partial).toBe(true);
});

test('hydrates invitation discovery and scan preferences for the owner after a switch', async () => {
  for (const url of MARMOT_KEY_PACKAGE_RELAYS)
    await setAppRelayEnabled(owner, 'marmot', url, false);
  for (const url of DEFAULT_RELAYS) await setAppRelayEnabled(owner, 'default', url, false);
  await forgetAppRelayPrefs(owner);
  setCurrentUserPubkey(null);
  const fetch = jest.fn(async (_relays: string[], _filter: unknown) => [] as NostrEvent[]);
  await loadInvitationKeys(owner, ['wss://personal.example'], fetch);
  for (const [targets] of fetch.mock.calls) {
    expect(targets).toEqual(['wss://personal.example']);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const url of MARMOT_KEY_PACKAGE_RELAYS) await setAppRelayEnabled(owner, 'marmot', url, true);
  for (const url of DEFAULT_RELAYS) await setAppRelayEnabled(owner, 'default', url, true);
  await forgetAppRelayPrefs(owner);
});
