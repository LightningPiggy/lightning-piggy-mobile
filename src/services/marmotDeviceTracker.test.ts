import { createCredential } from '@internet-privacy/marmot-ts';
import { nodeTypes } from '@internet-privacy/marmot-ts/mls';
import { bytesToHex } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools';

import * as devices from './marmotDevices';
import {
  DEVICE_LOOKUP_COOLDOWN_MS,
  MAX_DEVICE_LOOKUPS,
  MAX_DEVICE_NOTICES,
  MarmotDeviceTracker,
  type TrackedGroup,
} from './marmotDeviceTracker';
import { createMemoryMarmotBackend } from './marmotStore';

const person = () => getPublicKey(generateSecretKey());
const keyHex = (n: number) => bytesToHex(new Uint8Array(32).fill(n));

/** A loaded group whose tree holds `slots` (pubkey + signature-key byte). */
function group(idStr: string, slots: { pubkey: string; key: number }[], epoch: number, own = 0) {
  const ratchetTree: unknown[] = [];
  slots.forEach((s, i) => {
    if (i > 0) ratchetTree.push({ nodeType: nodeTypes.parent, parent: {} });
    ratchetTree.push({
      nodeType: nodeTypes.leaf,
      leaf: {
        credential: createCredential(s.pubkey),
        signaturePublicKey: new Uint8Array(32).fill(s.key),
        extensions: [],
      },
    });
  });
  return {
    idStr,
    state: { ratchetTree, groupContext: { epoch: BigInt(epoch) }, privatePath: { leafIndex: own } },
  } as unknown as TrackedGroup;
}

function setup(fetchKeyPackages = jest.fn(async (_pk: string): Promise<NostrEvent[]> => [])) {
  const backend = createMemoryMarmotBackend();
  const set = jest.spyOn(backend, 'set');
  const groups = new Map<string, TrackedGroup>();
  let now = 1_000_000;
  const make = () =>
    new MarmotDeviceTracker({
      backend,
      groups: () => [...groups.values()],
      fetchKeyPackages,
      ownClient: 'Lightning Piggy',
      now: () => now,
    });
  return {
    backend,
    set,
    groups,
    fetchKeyPackages,
    make,
    advance: (ms: number) => (now += ms),
  };
}

describe('MarmotDeviceTracker', () => {
  const [me, peer] = [person(), person()];

  it('persists the leaves only when they change, not on every epoch', async () => {
    const t = setup();
    const tracker = t.make();
    await tracker.observe(group('g1', [{ pubkey: me, key: 1 }], 0));
    const writes = () => t.set.mock.calls.filter(([ns]) => ns === 'deviceLeaves').length;
    expect(writes()).toBe(1);
    await tracker.observe(group('g1', [{ pubkey: me, key: 1 }], 1)); // rename, say
    expect(writes()).toBe(1);
    await tracker.observe(
      group(
        'g1',
        [
          { pubkey: me, key: 1 },
          { pubkey: peer, key: 2 },
        ],
        2,
      ),
    );
    expect(writes()).toBe(2);
  });

  it('keeps comparing against the stored snapshot after a restart (no re-baseline)', async () => {
    const t = setup();
    await t.make().observe(group('g1', [{ pubkey: me, key: 1 }], 0));
    const restarted = t.make();
    const listener = jest.fn();
    restarted.subscribe(listener);
    await restarted.observe(
      group(
        'g1',
        [
          { pubkey: me, key: 1 },
          { pubkey: peer, key: 2 },
        ],
        1,
      ),
    );
    expect(listener).toHaveBeenCalledWith('g1');
    const notices = await restarted.notices('g1');
    expect(notices).toEqual([
      expect.objectContaining({ pubkey: peer, joined: true, keys: [keyHex(2)], clients: [null] }),
    ]);
  });

  it('captures each commit when it happens, even while an earlier one is being stored', async () => {
    const t = setup();
    const tracker = t.make();
    // One live group object whose state moves on (as marmot-ts's does).
    const live = group('g1', [{ pubkey: me, key: 1 }], 0);
    const advanceTo = (slots: { pubkey: string; key: number }[], epoch: number) => {
      live.state = group('g1', slots, epoch).state;
    };
    void tracker.observe(live);
    advanceTo(
      [
        { pubkey: me, key: 1 },
        { pubkey: peer, key: 2 },
      ],
      1,
    );
    void tracker.observe(live);
    advanceTo([{ pubkey: me, key: 1 }], 2); // …and gone again before storage caught up
    await tracker.observe(live);
    expect(await tracker.notices('g1')).toEqual([
      expect.objectContaining({ pubkey: peer, joined: true, epoch: 1 }),
    ]);
  });

  it('does nothing for a state change that keeps the epoch (an ordinary message)', async () => {
    const t = setup();
    const get = jest.spyOn(t.backend, 'get');
    const tracker = t.make();
    const g = group('g1', [{ pubkey: me, key: 1 }], 4);
    await tracker.observe(g);
    const calls = get.mock.calls.length + t.set.mock.calls.length;
    for (let i = 0; i < 20; i++) await tracker.observe(g);
    expect(get.mock.calls.length + t.set.mock.calls.length).toBe(calls);
  });

  it('counts are cached per epoch (same Map until a commit)', () => {
    const t = setup();
    t.groups.set('g1', group('g1', [{ pubkey: me, key: 1 }], 1));
    const tracker = t.make();
    const first = tracker.counts('g1');
    expect(tracker.counts('g1')).toBe(first);
    t.groups.set(
      'g1',
      group(
        'g1',
        [
          { pubkey: me, key: 1 },
          { pubkey: peer, key: 2 },
        ],
        2,
      ),
    );
    expect(tracker.counts('g1')).not.toBe(first);
    expect(tracker.counts('g1')?.get(peer)).toBe(1);
    expect(tracker.epochOf('g1')).toBe(2);
    expect(tracker.groupCount()).toBe(1);
  });

  it('epochsKey moves only when some group commits or a group appears', () => {
    const t = setup();
    t.groups.set('g1', group('g1', [{ pubkey: me, key: 1 }], 1));
    const tracker = t.make();
    const k1 = tracker.epochsKey();
    expect(tracker.epochsKey()).toBe(k1);
    t.groups.set('g2', group('g2', [{ pubkey: me, key: 3 }], 0));
    const k2 = tracker.epochsKey();
    expect(k2).not.toBe(k1);
    t.groups.set('g1', group('g1', [{ pubkey: me, key: 1 }], 2));
    expect(tracker.epochsKey()).not.toBe(k2);
  });

  it(`keeps at most ${MAX_DEVICE_NOTICES} notices per chat`, async () => {
    const t = setup();
    const tracker = t.make();
    await tracker.observe(group('g1', [{ pubkey: me, key: 1 }], 0));
    for (let i = 1; i <= MAX_DEVICE_NOTICES + 5; i++) {
      // A fresh person joins each epoch (the previous one left).
      await tracker.observe(
        group(
          'g1',
          [
            { pubkey: me, key: 1 },
            { pubkey: person(), key: (i % 200) + 10 },
          ],
          i,
        ),
      );
    }
    const notices = await tracker.notices('g1');
    expect(notices).toHaveLength(MAX_DEVICE_NOTICES);
    expect(notices[notices.length - 1].epoch).toBe(MAX_DEVICE_NOTICES + 5);
  });

  it('a damaged record never breaks tracking (treated as no snapshot)', async () => {
    const t = setup();
    await t.backend.set('deviceLeaves', 'g1', '{not json');
    const tracker = t.make();
    t.groups.set('g1', group('g1', [{ pubkey: me, key: 1 }], 3));
    await tracker.observe(group('g1', [{ pubkey: me, key: 1 }], 3));
    expect(await tracker.notices('g1')).toEqual([]);
    expect((await tracker.devices('g1'))?.people.get(me)?.[0]).toMatchObject({
      baseline: true,
      firstEpoch: 3,
      isOwn: true,
      client: 'Lightning Piggy',
    });
  });

  it('counts and devices are null for a chat that is not loaded', async () => {
    const tracker = setup().make();
    expect(tracker.counts('nope')).toBeNull();
    expect(await tracker.devices('nope')).toBeNull();
    expect(await tracker.resolveClients('nope')).toBe(false);
  });

  it('looks up a bounded number of people, only their own events, once per cooldown', async () => {
    const t = setup();
    const others = Array.from({ length: MAX_DEVICE_LOOKUPS + 3 }, () => person());
    const slots = [{ pubkey: me, key: 1 }, ...others.map((pubkey, i) => ({ pubkey, key: i + 2 }))];
    t.groups.set('g1', group('g1', slots, 1));
    // Every lookup returns an event whose key matches the first other person,
    // but only that person's own event may name their device.
    const forged = { kind: 30443, pubkey: others[1], tags: [['client', 'Forged']] } as NostrEvent;
    const genuine = { kind: 30443, pubkey: others[0], tags: [['client', 'White Noise']] };
    t.fetchKeyPackages.mockImplementation(async () => [forged, genuine as NostrEvent]);
    // Both events carry the first other person's leaf key.
    const sigKey = jest.spyOn(devices, 'keyPackageSignatureKey').mockReturnValue(keyHex(2));
    const tracker = t.make();
    expect(await tracker.resolveClients('g1')).toBe(true);
    expect(t.fetchKeyPackages).toHaveBeenCalledTimes(MAX_DEVICE_LOOKUPS);
    const view = await tracker.devices('g1');
    expect(view?.people.get(others[0])?.[0].client).toBe('White Noise');
    expect(view?.people.get(others[1])?.[0].client).toBeNull();

    // Within the cooldown the same people aren't asked again; the rest are.
    t.fetchKeyPackages.mockClear();
    await tracker.resolveClients('g1');
    const asked = t.fetchKeyPackages.mock.calls.map(([pk]) => pk);
    expect(asked).toEqual(others.slice(MAX_DEVICE_LOOKUPS));
    t.fetchKeyPackages.mockClear();
    await tracker.resolveClients('g1');
    expect(t.fetchKeyPackages).not.toHaveBeenCalled();
    t.advance(DEVICE_LOOKUP_COOLDOWN_MS + 1);
    await tracker.resolveClients('g1');
    expect(t.fetchKeyPackages).toHaveBeenCalled();
    sigKey.mockRestore();
  });

  it('matches our other installs by signature key without assuming they run our app', async () => {
    const t = setup();
    const tracker = t.make();
    const initial = [
      { pubkey: me, key: 1 },
      { pubkey: peer, key: 2 },
    ];
    await tracker.observe(group('g1', initial, 0));
    const updated = group(
      'g1',
      [...initial, { pubkey: me, key: 3 }, { pubkey: me, key: 4 }, { pubkey: me, key: 5 }],
      1,
    );
    t.groups.set('g1', updated);
    await tracker.observe(updated);
    const event = (key: number, client?: string) =>
      ({
        kind: 30443,
        pubkey: me,
        content: String(key),
        created_at: 123,
        tags: client ? [['client', client]] : [],
      }) as NostrEvent;
    t.fetchKeyPackages.mockImplementation(async (pk) =>
      pk === me
        ? [event(3, 'Lightning Piggy'), event(4, 'White Noise'), event(5), event(99, 'Wrong key')]
        : [],
    );
    const signature = jest
      .spyOn(devices, 'keyPackageSignatureKey')
      .mockImplementation((e) => keyHex(Number(e.content)));
    try {
      expect((await tracker.notices('g1'))[0].clients).toEqual([null, null, null]);
      expect(await tracker.resolveClients('g1')).toBe(true);
      expect(t.fetchKeyPackages).toHaveBeenCalledWith(me);
      expect((await tracker.notices('g1'))[0].clients).toEqual([
        'Lightning Piggy',
        'White Noise',
        null,
      ]);
      // Persisted key records repair the original notice after a restart too.
      expect((await t.make().notices('g1'))[0].clients).toEqual([
        'Lightning Piggy',
        'White Noise',
        null,
      ]);
    } finally {
      signature.mockRestore();
    }
  });

  it('a failed lookup is just "unknown"', async () => {
    const t = setup(
      jest.fn(async (_pk: string): Promise<NostrEvent[]> => Promise.reject(new Error('offline'))),
    );
    t.groups.set(
      'g1',
      group(
        'g1',
        [
          { pubkey: me, key: 1 },
          { pubkey: peer, key: 2 },
        ],
        1,
      ),
    );
    const tracker = t.make();
    expect(await tracker.resolveClients('g1')).toBe(false);
    expect((await tracker.devices('g1'))?.people.get(peer)?.[0].client).toBeNull();
  });
});
