import { forgetAppRelayPrefs, setAppRelayEnabled } from './appRelayPrefs';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event as NostrEvent,
} from 'nostr-tools';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  MAX_RETIREMENT_ATTEMPTS,
  retireFootprint,
  buildKeyPackageDeletion,
  localKeyPackageFootprint,
  retireMarmotKeyPackages,
  retryPendingRetirement,
  type RetireTransport,
} from './marmotKeyPackageRetire';
import { createMemoryMarmotBackend, encodeMarmotValue } from './marmotStore';

jest.mock('./nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));

const SLOT = 'cd'.repeat(32);
const sk = generateSecretKey();
const owner = getPublicKey(sk);
const sign = jest.fn(async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk));

function transport(
  relayEvents: NostrEvent[],
  accepts: (relay: string, event: NostrEvent) => boolean = () => true,
) {
  const published: { relays: string[]; event: NostrEvent }[] = [];
  const t: RetireTransport = {
    async query(_relays, filter) {
      return relayEvents.filter(
        (e) =>
          filter.kinds?.includes(e.kind) &&
          (!filter['#d'] || e.tags.some((tag) => tag[0] === 'd' && filter['#d']!.includes(tag[1]))),
      );
    },
    async publish(relays, event) {
      published.push({ relays, event });
      return relays.filter((r) => accepts(r, event));
    },
  };
  return { t, published };
}

const kpEvent = (id: string, d: string, relays: string[] = []) =>
  ({
    id,
    kind: 30443,
    pubkey: owner,
    created_at: 1,
    tags: [['d', d], ...(relays.length ? [['relays', ...relays]] : [])],
    content: '',
    sig: '',
  }) as NostrEvent;

const HINT = 'wss://custom.example/';
const PENDING = `marmot_pending_key_retirement_${owner}`;

/** A backend holding one published key package (relay hint HINT). */
async function publishedBackend() {
  const backend = createMemoryMarmotBackend();
  await backend.set('meta', 'keyPackageSlot', SLOT);
  await backend.set(
    'keyPackages',
    'ref1',
    encodeMarmotValue({ identifier: SLOT, published: [kpEvent('a'.repeat(64), SLOT, [HINT])] }),
  );
  return backend;
}

describe('marmotKeyPackageRetire', () => {
  beforeEach(async () => {
    sign.mockClear();
    await AsyncStorage.clear();
  });

  it('deletes every version in our slot, by event id and slot address (NIP-09)', async () => {
    const backend = createMemoryMarmotBackend();
    await backend.set('meta', 'keyPackageSlot', SLOT);
    await backend.set(
      'keyPackages',
      'ref1',
      encodeMarmotValue({ identifier: SLOT, published: [kpEvent('a'.repeat(64), SLOT)] }),
    );
    const relayList = {
      ...kpEvent('f'.repeat(64), ''),
      kind: 10002,
      created_at: 5,
      tags: [['r', 'wss://write.example']],
    };
    const { t, published } = transport([
      relayList,
      kpEvent('b'.repeat(64), SLOT), // an older version still on a relay
      kpEvent('c'.repeat(64), 'ee'.repeat(32)), // another device's slot — untouched
    ]);

    expect(await retireMarmotKeyPackages({ owner, sign, backend, transport: t })).toBe('deleted');
    const [{ relays, event }] = published;
    expect(event.kind).toBe(5);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['k', '30443'],
        ['e', 'a'.repeat(64)],
        ['e', 'b'.repeat(64)],
        ['a', `30443:${owner}:${SLOT}`],
      ]),
    );
    expect(event.tags).not.toContainEqual(['e', 'c'.repeat(64)]);
    expect(relays).toContain('wss://write.example');
    expect(published).toHaveLength(2);
    expect(published[1].event).toMatchObject({
      kind: 30443,
      pubkey: owner,
      content: '',
      tags: [['d', SLOT]],
    });
    expect(published[1].event.created_at).toBeGreaterThan(event.created_at);
    expect(published[1].relays).toEqual(relays);
  });

  it('reports a failed replacement even when the deletion was accepted', async () => {
    const backend = createMemoryMarmotBackend();
    await backend.set('meta', 'keyPackageSlot', SLOT);
    const { t } = transport([]);
    t.publish = async (relays, event) => (event.kind === 5 ? relays : []);
    expect(await retireMarmotKeyPackages({ owner, sign, backend, transport: t })).toBe('failed');
  });

  it('never asks the signer when this install published no key package', async () => {
    const { t, published } = transport([]);
    const outcome = await retireMarmotKeyPackages({
      owner,
      sign,
      backend: createMemoryMarmotBackend(),
      transport: t,
    });
    expect(outcome).toBe('nothing');
    expect(sign).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it("reports 'failed' when the signer refuses", async () => {
    const backend = createMemoryMarmotBackend();
    await backend.set('meta', 'keyPackageSlot', SLOT);
    const { t } = transport([]);
    const refuse = jest.fn(async () => {
      throw new Error('denied');
    });
    expect(await retireMarmotKeyPackages({ owner, sign: refuse, backend, transport: t })).toBe(
      'failed',
    );
  });

  it('never publishes if a remote signer returns another account', async () => {
    const backend = createMemoryMarmotBackend();
    await backend.set('meta', 'keyPackageSlot', SLOT);
    const { t, published } = transport([]);
    const otherKey = generateSecretKey();
    const otherSign = async (template: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent(template, otherKey);
    expect(await retireMarmotKeyPackages({ owner, sign: otherSign, backend, transport: t })).toBe(
      'failed',
    );
    expect(published).toHaveLength(0);
  });

  it('reads slots and event ids from the local store', async () => {
    const backend = createMemoryMarmotBackend();
    await backend.set('keyPackages', 'x', 'not json');
    await backend.set('keyPackages', 'y', encodeMarmotValue({ identifier: SLOT, published: [] }));
    expect(await localKeyPackageFootprint(backend)).toEqual({
      slots: [SLOT],
      eventIds: [],
      relays: [],
    });
    expect(buildKeyPackageDeletion(owner, [], ['1'], 9)).toEqual({
      kind: 5,
      created_at: 9,
      content: '',
      tags: [
        ['k', '30443'],
        ['e', '1'],
      ],
    });
  });

  it('sends to the relays the key package was published to, and the account write relays', async () => {
    const { t, published } = transport([]);
    const outcome = await retireMarmotKeyPackages({
      owner,
      sign,
      relays: ['wss://account-write.example'],
      backend: await publishedBackend(),
      transport: t,
    });
    expect(outcome).toBe('deleted');
    for (const p of published) {
      expect(p.relays).toEqual(expect.arrayContaining([HINT, 'wss://account-write.example']));
    }
  });

  it('is incomplete when only unrelated relays accepted (the original relay was offline)', async () => {
    const { t } = transport([], (relay) => relay !== HINT);
    const backend = await publishedBackend();
    expect(await retireMarmotKeyPackages({ owner, sign, backend, transport: t })).toBe('failed');
    // ...so a public-only record is kept for a retry at the next sign-in.
    const pending = JSON.parse((await AsyncStorage.getItem(PENDING))!);
    expect(pending).toMatchObject({
      slots: [SLOT],
      eventIds: ['a'.repeat(64)],
      relays: [HINT],
      attempts: 0,
    });
    expect(JSON.stringify(pending)).not.toMatch(/private|secret/i);
  });

  it('keeps a pending record without prompting when no signer is available', async () => {
    const { t, published } = transport([]);
    const outcome = await retireMarmotKeyPackages({
      owner,
      sign: null,
      backend: await publishedBackend(),
      transport: t,
    });
    expect(outcome).toBe('failed');
    expect(published).toHaveLength(0);
    expect(await AsyncStorage.getItem(PENDING)).not.toBeNull();
  });

  it('retries a failed sign-out cleanup at the next sign-in, then forgets it', async () => {
    const offline = transport([], () => false);
    const backend = await publishedBackend();
    await retireMarmotKeyPackages({ owner, sign, backend, transport: offline.t });
    // Signed in again (a new slot) — the session retries with the account's signer.
    const NEW_SLOT = 'ef'.repeat(32);
    const { t, published } = transport([]);
    expect(await retryPendingRetirement({ owner, sign, keepSlot: NEW_SLOT, transport: t })).toBe(
      'deleted',
    );
    expect(published[0].event.tags).toContainEqual(['a', `30443:${owner}:${SLOT}`]);
    expect(published.flatMap((p) => p.event.tags)).not.toContainEqual([
      'a',
      `30443:${owner}:${NEW_SLOT}`,
    ]);
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
    expect(await retryPendingRetirement({ owner, sign, transport: t })).toBe('nothing');
  });

  it('never retires the slot this install publishes into now', async () => {
    const backend = await publishedBackend();
    await retireMarmotKeyPackages({ owner, sign: null, backend });
    const { t, published } = transport([]);
    await retryPendingRetirement({ owner, sign, keepSlot: SLOT, transport: t });
    expect(published.flatMap((p) => p.event.tags)).not.toContainEqual([
      'a',
      `30443:${owner}:${SLOT}`,
    ]);
    expect(published.filter((p) => p.event.kind === 30443)).toHaveLength(0);
  });

  it('gives up after MAX_RETIREMENT_ATTEMPTS, and once the keys have expired', async () => {
    const offline = transport([], () => false);
    await retireMarmotKeyPackages({ owner, sign: null, backend: await publishedBackend() });
    for (let i = 0; i < MAX_RETIREMENT_ATTEMPTS; i++) {
      expect(await retryPendingRetirement({ owner, sign, transport: offline.t })).toBe('failed');
    }
    expect(await retryPendingRetirement({ owner, sign, transport: offline.t })).toBe('nothing');
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();

    await AsyncStorage.setItem(
      PENDING,
      JSON.stringify({ slots: [SLOT], eventIds: [], relays: [], expiresAt: 1, attempts: 0 }),
    );
    sign.mockClear();
    expect(await retryPendingRetirement({ owner, sign, transport: offline.t })).toBe('nothing');
    expect(sign).not.toHaveBeenCalled();
  });

  it('does not count a retry abandoned by sign-out as an attempt', async () => {
    await retireMarmotKeyPackages({ owner, sign: null, backend: await publishedBackend() });
    const { t, published } = transport([]);
    const outcome = await retryPendingRetirement({
      owner,
      sign,
      cancelled: () => true,
      transport: t,
    });
    expect(outcome).toBe('failed');
    expect(published).toHaveLength(0);
    expect(JSON.parse((await AsyncStorage.getItem(PENDING))!).attempts).toBe(0);
  });
});

test('includes copied key destinations in the local retirement footprint', async () => {
  const backend = await publishedBackend();
  await backend.set(
    'keyPackageDiscovery',
    'relays',
    JSON.stringify(['wss://relay.eu.whitenoise.chat', 'wss://relay.primal.net']),
  );
  const footprint = await localKeyPackageFootprint(backend);
  expect(footprint.relays).toEqual(
    expect.arrayContaining([HINT, 'wss://relay.eu.whitenoise.chat', 'wss://relay.primal.net']),
  );
});

test('batches sign-out queries and publications and excludes expired copied destinations', async () => {
  const backend = await publishedBackend();
  const expiry = Math.floor(Date.now() / 1000) + 1000;
  const relays = Array.from({ length: 40 }, (_, i) => `wss://copied-${i}.example`);
  await backend.set(
    'keyPackageDiscovery',
    'relayHistory',
    JSON.stringify({
      ...Object.fromEntries(relays.map((relay) => [relay, expiry])),
      'wss://expired.example': 1,
    }),
  );
  const { t, published } = transport([]);
  const query = jest.fn(t.query);
  t.query = query;
  expect(await retireMarmotKeyPackages({ owner, sign, backend, transport: t })).toBe('deleted');
  expect(query.mock.calls.every(([batch]) => batch.length <= 12)).toBe(true);
  expect(published.every(({ relays: batch }) => batch.length <= 12)).toBe(true);
  for (const kind of [5, 30443]) {
    const destinations = published
      .filter(({ event }) => event.kind === kind)
      .flatMap(({ relays: batch }) => batch);
    expect(destinations).toEqual(expect.arrayContaining(relays));
    expect(destinations).not.toContain('wss://expired.example');
  }
});

test('hydrates retirement defaults for the owner after an account switch', async () => {
  await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], false);
  await forgetAppRelayPrefs(owner);
  setCurrentUserPubkey(null);
  const query = jest.fn(async (_relays: string[], _filter: unknown) => [] as NostrEvent[]);
  const t = transport([]);
  await retireFootprint({
    owner,
    footprint: { slots: [SLOT], eventIds: [], relays: [] },
    sign,
    transport: { ...t.t, query },
  });
  const targets = query.mock.calls;
  expect(targets.length).toBeGreaterThan(0);
  expect(targets[0][0]).not.toContain(DEFAULT_RELAYS[0]);
  expect(targets[0][0]).toContain(DEFAULT_RELAYS[1]);
  await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], true);
  await forgetAppRelayPrefs(owner);
});
