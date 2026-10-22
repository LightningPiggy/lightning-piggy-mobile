// Which of a contact's devices get invited: real kind-30443 key packages,
// one MarmotClient per "install" sharing an account key.
import {
  evaluateKeyPackageForGroup,
  MarmotClient,
  type GroupPublishResult,
} from '@internet-privacy/marmot-ts';
import { InMemoryKeyValueStore } from '@internet-privacy/marmot-ts/extra';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import type { Event as NostrEvent } from 'nostr-tools';

import { installMarmotCryptoProvider, marmotCryptoProvider } from './marmotCryptoProvider';
import {
  buildInviteBatch,
  deliveredAccounts,
  DEVICE_MAX_AGE_SECS,
  MAX_DEVICES_PER_PERSON,
  WHITE_NOISE_MAX_AGE_SECS,
  resolveInvitees,
  selectDeviceKeyPackages,
} from './marmotInvitees';
import { MarmotDmDeviceSync } from './marmotDmDeviceSync';
import { createMemoryMarmotBackend } from './marmotStore';
import {
  MarmotKeyPackageLookupError,
  MarmotNoKeyPackageError,
  MarmotUnusableKeyPackageError,
} from './marmotKeyPackages';

const RELAY = 'wss://relay.test';
const DAY = 24 * 60 * 60;
const slot = (n: number) => n.toString(16).padStart(64, '0');

function makeAccount() {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const signer = {
    getPublicKey: () => pubkey,
    signEvent: (draft: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(draft, sk),
    nip44: {
      encrypt: (pk: string, pt: string) => nip44.encrypt(pt, nip44.getConversationKey(sk, pk)),
      decrypt: (pk: string, ct: string) => nip44.decrypt(ct, nip44.getConversationKey(sk, pk)),
    },
  };
  return { sk, pubkey, signer };
}

/** One install of `account` publishing its key package into slot `d`. */
async function publishDevice(account: ReturnType<typeof makeAccount>, d: string) {
  const published: NostrEvent[] = [];
  const client = new MarmotClient({
    signer: account.signer,
    network: {
      publish: async (relays: string[], e: NostrEvent) => {
        published.push(e);
        return Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }]));
      },
      request: async () => [],
      subscription: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
      getUserInboxRelays: async () => [RELAY],
    },
    cryptoProvider: marmotCryptoProvider,
    groupStateStore: new InMemoryKeyValueStore(),
    keyPackageStore: new InMemoryKeyValueStore(),
  });
  await client.keyPackages.create({ relays: [RELAY], identifier: d, client: 'test' });
  const kp = published.find((e) => e.kind === 30443);
  if (!kp) throw new Error('no key package published');
  return kp;
}

/** Same key package content, re-signed by `sk` with a different date. */
const resign = (e: NostrEvent, sk: Uint8Array, createdAt = e.created_at) =>
  finalizeEvent({ kind: e.kind, tags: e.tags, content: e.content, created_at: createdAt }, sk);

describe('selectDeviceKeyPackages', () => {
  beforeAll(() => installMarmotCryptoProvider());
  const little = makeAccount();
  let devices: NostrEvent[] = [];
  const now = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    devices = [];
    for (let i = 0; i < 12; i++) devices.push(await publishDevice(little, slot(i)));
  }, 60_000);

  it('invites one key package per device, newest first', async () => {
    const [a, b] = devices;
    const olderA = resign(a, little.sk, a.created_at - 60);
    const picked = await selectDeviceKeyPackages(little.pubkey, [
      olderA,
      resign(b, little.sk, b.created_at - 10),
      a,
    ]);
    // Slot A's replaced event is dropped; both devices remain, newest first.
    expect(picked.map((e) => e.id)).toEqual([a.id, expect.any(String)]);
    expect(picked).toHaveLength(2);
    expect(picked.map((e) => e.id)).not.toContain(olderA.id);
  });

  /** Re-sign with a client tag and/or without media v2 (0x800b) advertised. */
  const variant = (e: NostrEvent, o: { client?: string; mediaV2?: boolean; at?: number }) =>
    finalizeEvent(
      {
        kind: e.kind,
        content: e.content,
        created_at: o.at ?? e.created_at,
        tags: [
          ...e.tags
            .filter((t) => t[0] !== 'client')
            .map((t) =>
              t[0] === 'app_components' && o.mediaV2 === false
                ? t.filter((v) => v !== '0x800b')
                : t,
            ),
          ...(o.client ? [['client', o.client]] : []),
        ],
      },
      little.sk,
    );

  it('freshness depends on the client: White Noise 35 days, others 14', async () => {
    const at = (days: number) => now - days * DAY;
    const lp20 = variant(devices[0], { client: 'Lightning Piggy', at: at(20) });
    const wn20 = variant(devices[1], { client: 'White Noise Android', at: at(20) });
    const wn40 = variant(devices[2], { client: 'White Noise Android', at: at(40) });
    const bare10 = variant(devices[3], { at: at(10) });
    const bare15 = variant(devices[4], { at: at(15) });
    const picked = await selectDeviceKeyPackages(
      little.pubkey,
      [lp20, wn20, wn40, bare10, bare15],
      {
        nowSecs: now,
      },
    );
    expect(picked.map((e) => e.id)).toEqual([bare10.id, wn20.id]);
    expect(DEVICE_MAX_AGE_SECS).toBe(14 * DAY);
    expect(WHITE_NOISE_MAX_AGE_SECS).toBe(35 * DAY);
    // Nothing fresh: the newest valid one still keeps the contact reachable.
    const onlyStale = await selectDeviceKeyPackages(little.pubkey, [wn40, lp20], { nowSecs: now });
    expect(onlyStale.map((e) => e.id)).toEqual([lp20.id]);
    // Topping up an existing chat (#1559): stale devices are ignored, no fallback.
    const freshOnly = { nowSecs: now, freshOnly: true };
    const topUp = await selectDeviceKeyPackages(little.pubkey, [lp20, wn20, wn40], freshOnly);
    expect(topUp.map((e) => e.id)).toEqual([wn20.id]);
    expect(await selectDeviceKeyPackages(little.pubkey, [wn40, lp20], freshOnly)).toEqual([]);
    // ...and an unusable key package is "no new device", not an error.
    const year = { nowSecs: now + 365 * DAY, freshOnly: true };
    expect(await selectDeviceKeyPackages(little.pubkey, [devices[0]], year)).toEqual([]);
  });

  it('skips installs without encrypted media v2 (White Noise drops the whole Welcome)', async () => {
    const old = variant(devices[0], { mediaV2: false, at: now - 60 });
    const current = variant(devices[1], { at: now - 120 });
    expect(
      (await selectDeviceKeyPackages(little.pubkey, [old, current], { nowSecs: now })).map(
        (e) => e.id,
      ),
    ).toEqual([current.id]);
    // An old install is still used when it's all they have (1:1 stays possible).
    expect(
      (await selectDeviceKeyPackages(little.pubkey, [old], { nowSecs: now })).map((e) => e.id),
    ).toEqual([old.id]);
  });

  it('a retired slot (empty placeholder) counts as no key package, not an outdated one', async () => {
    const placeholder = finalizeEvent(
      {
        kind: 30443,
        content: '',
        created_at: devices[0].created_at + 10,
        tags: devices[0].tags.filter((t) => t[0] === 'd'),
      },
      little.sk,
    );
    expect(await selectDeviceKeyPackages(little.pubkey, [devices[0], placeholder])).toEqual([]);
  });

  it('pins the library membership reason used to permit sibling devices', async () => {
    const client = new MarmotClient({
      signer: little.signer,
      network: {
        publish: async (relays: string[]) =>
          Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }])),
        request: async () => [],
        subscription: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
        getUserInboxRelays: async () => [RELAY],
      },
      cryptoProvider: marmotCryptoProvider,
      groupStateStore: new InMemoryKeyValueStore(),
      keyPackageStore: new InMemoryKeyValueStore(),
    });
    const group = await client.groups.create('Sibling', { relays: [RELAY] });
    const verdict = evaluateKeyPackageForGroup(group.state, devices[0]);
    expect(verdict.reasons).toEqual(['already a member']);
    const candidates = new Map([[little.pubkey, [devices[0]]]]);
    expect(buildInviteBatch(group.state, little.pubkey, candidates).invited).toEqual([]);
    expect(
      buildInviteBatch(group.state, little.pubkey, candidates, { siblings: true }).invited,
    ).toEqual([devices[0]]);
  });

  it.each(['stale', 'forged', 'wrong author', 'retired'])(
    'adds a fresh Lightning Piggy device alongside a %s White Noise event',
    async (caseName) => {
      const lp = variant(devices[0], { client: 'Lightning Piggy', at: now });
      const wn = variant(devices[1], { client: 'White Noise Android', at: now });
      const ignored =
        caseName === 'stale'
          ? variant(devices[1], { client: 'White Noise Android', at: now - 36 * DAY })
          : caseName === 'forged'
            ? ({ ...JSON.parse(JSON.stringify(wn)), sig: '0'.repeat(128) } as NostrEvent)
            : caseName === 'wrong author'
              ? resign(wn, makeAccount().sk)
              : finalizeEvent(
                  { kind: wn.kind, tags: wn.tags, content: '', created_at: now + 1 },
                  little.sk,
                );
      const invite = jest.fn(async () => undefined);
      const sync = new MarmotDmDeviceSync({
        self: makeAccount().pubkey,
        backend: createMemoryMarmotBackend(),
        fetchKeyPackages: async () => [ignored, lp],
        groupState: async () => ({ ratchetTree: [] }),
        invite,
        silentSigner: true,
        stopped: () => false,
      });
      await sync.sync('group', little.pubkey, 'send');
      expect(invite).toHaveBeenCalledWith('group', new Map([[little.pubkey, [lp]]]));
    },
  );

  it('caps a person at 10 devices AFTER group checks, so a rejected key makes room', async () => {
    const big = makeAccount();
    const client = new MarmotClient({
      signer: big.signer,
      network: {
        publish: async (relays: string[]) =>
          Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }])),
        request: async () => [],
        subscription: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
        getUserInboxRelays: async () => [RELAY],
      },
      cryptoProvider: marmotCryptoProvider,
      groupStateStore: new InMemoryKeyValueStore(),
      keyPackageStore: new InMemoryKeyValueStore(),
    });
    const group = await client.groups.create('Cap', { relays: [RELAY] });
    const dated = devices.map((e, i) => resign(e, little.sk, now - i * 60));
    // The newest one advertises proposals it doesn't support: the group rejects it.
    const bad = finalizeEvent(
      {
        kind: 30443,
        content: dated[0].content,
        created_at: dated[0].created_at,
        tags: dated[0].tags.map((t) => (t[0] === 'mls_proposals' ? [t[0], '0x0001'] : t)),
      },
      little.sk,
    );
    const batch = buildInviteBatch(
      group.state,
      big.pubkey,
      new Map([[little.pubkey, [bad, ...dated.slice(1)]]]),
    );
    expect(batch.devices.get(little.pubkey)).toBe(MAX_DEVICES_PER_PERSON);
    expect(batch.intent?.welcomeRecipients?.map((r) => r.keyPackageEventId)).toEqual(
      dated.slice(1, 11).map((e) => e.id),
    );
    expect(batch.unreachable).toEqual([]);
  });

  it('rejects bad signatures, expired keys and a foreign credential', async () => {
    const good = devices[0];
    const badSig = { ...JSON.parse(JSON.stringify(devices[1])), sig: '0'.repeat(128) };
    // Little's key package re-signed by someone else: the credential inside
    // still names Little, so it must not be accepted as theirs.
    const mallory = makeAccount();
    const foreign = resign(devices[2], mallory.sk);
    expect(await selectDeviceKeyPackages(little.pubkey, [badSig, good])).toEqual([good]);
    await expect(selectDeviceKeyPackages(mallory.pubkey, [foreign])).rejects.toBeInstanceOf(
      MarmotUnusableKeyPackageError,
    );
    // Someone else's events never count as this person's devices.
    expect(await selectDeviceKeyPackages(little.pubkey, [foreign, good])).toEqual([good]);
    // A year on, every lifetime has run out.
    await expect(
      selectDeviceKeyPackages(little.pubkey, [good], { nowSecs: now + 365 * DAY }),
    ).rejects.toBeInstanceOf(MarmotUnusableKeyPackageError);
    expect(await selectDeviceKeyPackages(little.pubkey, [])).toEqual([]);
  });

  it("a contact's White Noise and Lightning Piggy installs are all selected (#1663)", async () => {
    const asClient = (e: NostrEvent, client: string, createdAt: number) =>
      finalizeEvent(
        {
          kind: e.kind,
          content: e.content,
          created_at: createdAt,
          tags: [...e.tags.filter((t) => t[0] !== 'client'), ['client', client]],
        },
        little.sk,
      );
    const lpPhone = asClient(devices[0], 'Lightning Piggy', now);
    const lpTablet = asClient(devices[1], 'Lightning Piggy', now - 60);
    const wnNew = asClient(devices[2], 'White Noise Android', now - 120);
    const wnOld = asClient(devices[3], 'White Noise Android', now - 180);
    const all = await selectDeviceKeyPackages(little.pubkey, [wnOld, lpTablet, wnNew, lpPhone], {
      nowSecs: now,
    });
    // Every app's install, newest first: 1:1s and groups invite them all (#1663).
    expect(all).toEqual([lpPhone, lpTablet, wnNew, wnOld]);
  });

  it('yields between signature checks', async () => {
    const yieldNow = jest.fn();
    await selectDeviceKeyPackages(little.pubkey, devices.slice(0, 3), { yieldNow });
    expect(yieldNow).toHaveBeenCalledTimes(3);
  });

  it('resolves every peer (never ourselves) and names anyone unreachable', async () => {
    const big = makeAccount();
    const middle = makeAccount();
    const ownOtherInstall = await publishDevice(big, slot(99));
    const network = {
      request: jest.fn(async (_relays: string[], filter: unknown) => {
        if (Array.isArray(filter)) return [];
        const f = filter as { kinds: number[]; authors: string[]; limit?: number };
        expect(typeof f.limit).toBe('number'); // bounded (perf rules)
        if (!f.kinds.includes(30443)) return [];
        return [...devices.slice(0, 2), ownOtherInstall].filter((e) =>
          f.authors.includes(e.pubkey),
        );
      }),
    };
    const invitees = await resolveInvitees(network, [RELAY], big.pubkey, [
      little.pubkey,
      big.pubkey,
    ]);
    expect([...invitees.keys()]).toEqual([little.pubkey]);
    expect(invitees.get(little.pubkey)).toHaveLength(2);
    await expect(
      resolveInvitees(network, [RELAY], big.pubkey, [little.pubkey, middle.pubkey]),
    ).rejects.toBeInstanceOf(MarmotNoKeyPackageError);
  });

  it('reports a key-package lookup no relay answered as a lookup failure, not "no key package" (#1658)', async () => {
    const big = makeAccount();
    const request = jest.fn(async (_relays: string[], filter: unknown, _opts?: unknown) => {
      if (Array.isArray(filter)) return [];
      throw new Error('No relay answered: connection failure; query deadline');
    });
    await expect(
      resolveInvitees({ request }, [RELAY], big.pubkey, [little.pubkey]),
    ).rejects.toBeInstanceOf(MarmotKeyPackageLookupError);
    // The key-package read asks the pool to tell "none published" from "no answer".
    const keyPackageCall = request.mock.calls.find((c) => !Array.isArray(c[1]));
    expect(keyPackageCall?.[2]).toEqual({ requireAnswer: true });
  });
});

describe('deliveredAccounts', () => {
  const result = (outcomes: { kind: 'succeeded' | 'failed'; pubkey: string }[]) =>
    [
      {
        welcomeDelivery: {
          kind: 'attempted',
          outcomes: outcomes.map((o, i) => ({
            kind: o.kind,
            recipient: { pubkey: o.pubkey, keyPackageEventId: String(i).repeat(64) },
            ...(o.kind === 'failed' ? { error: 'relay said no' } : { response: {} }),
          })),
        },
      },
    ] as unknown as GroupPublishResult[];

  it('counts a person as reached when any one of their devices got a Welcome', () => {
    const bob = 'b'.repeat(64);
    const carol = 'c'.repeat(64);
    const delivered = deliveredAccounts(
      result([
        { kind: 'failed', pubkey: bob },
        { kind: 'succeeded', pubkey: bob },
        { kind: 'failed', pubkey: carol },
        { kind: 'failed', pubkey: carol },
      ]),
    );
    expect([...delivered]).toEqual([bob]);
    expect(
      deliveredAccounts([{ welcomeDelivery: { kind: 'notRequired' } }] as GroupPublishResult[]),
    ).toEqual(new Set());
  });
});
