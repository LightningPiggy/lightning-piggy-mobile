import type { NostrWelcomeDelivery } from '@internet-privacy/marmot-ts';
import { GiftWrapFactory } from 'applesauce-common/factories/gift-wrap';
import type { Event as NostrEvent } from 'nostr-tools';

import { MarmotDmDeviceSync } from './marmotDmDeviceSync';
import { createMemoryMarmotBackend } from './marmotStore';
import { MarmotWelcomeOutbox } from './marmotWelcomeOutbox';
import { MAX_PENDING_WELCOME_PAYLOADS, MarmotWelcomePayloads } from './marmotWelcomePayloads';
import { NostrConnectError } from './signerErrors';

const GROUP = 'group';
const keyPackage = { id: 'package', pubkey: 'b'.repeat(64) } as NostrEvent;
const wrap = { id: 'wrap', kind: 1059, tags: [['p', keyPackage.pubkey]] } as NostrEvent & {
  kind: 1059;
};

function setup() {
  const backend = createMemoryMarmotBackend();
  const outbox = new MarmotWelcomeOutbox(backend);
  const devices = new MarmotDmDeviceSync({
    self: 'a'.repeat(64),
    backend,
    fetchKeyPackages: async () => [],
    groupState: async () => ({ ratchetTree: [] }),
    invite: async () => undefined,
    silentSigner: false,
    stopped: () => false,
  });
  const signEvent = jest.fn(async () => wrap);
  const publish = jest.fn(async () => ({ relay: { from: 'relay', ok: true } }));
  const delivery = {
    signer: { getPublicKey: () => 'a'.repeat(64), signEvent },
    network: { getUserInboxRelays: async () => ['relay'], publish },
    createRumor: () => ({}),
  } as unknown as NostrWelcomeDelivery;
  const payloads = new MarmotWelcomePayloads(backend, outbox, devices, () => false);
  payloads.attach({ idStr: GROUP, runtime: { welcomeDelivery: delivery } } as Parameters<
    MarmotWelcomePayloads['attach']
  >[0]);
  const seed = () =>
    backend.set(
      'welcomePayloads',
      `${GROUP}:${keyPackage.id}`,
      JSON.stringify({
        groupId: GROUP,
        keyPackage,
        rumor: {},
        relays: ['relay'],
        queuedAt: Math.floor(Date.now() / 1000),
      }),
    );
  return { backend, outbox, devices, signEvent, publish, payloads, seed, delivery };
}

describe('MarmotWelcomePayloads retries', () => {
  beforeEach(() => {
    jest.spyOn(GiftWrapFactory, 'create').mockImplementation(async (signer) => {
      await signer.signEvent({ kind: 13, created_at: 1, tags: [], content: '' });
      return wrap;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['declined', 'delivered'] as const)(
    'rechecks queued concurrent retries after the first is %s',
    async (outcome) => {
      const { backend, outbox, signEvent, publish, payloads, seed } = setup();
      await seed();
      // Hold the shared capture queue until both flushes have queued their retry.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = outbox.capture(() => gate);
      const queued = jest.spyOn(outbox, 'capture');
      if (outcome === 'declined') {
        signEvent.mockRejectedValue(new NostrConnectError('permission', 'denied'));
      }
      const first = payloads.flush();
      const second = payloads.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queued).toHaveBeenCalledTimes(2);
      release();
      await Promise.all([held, first, second]);
      expect(signEvent).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(outcome === 'delivered' ? 1 : 0);
      expect(await backend.get('welcomePayloads', `${GROUP}:${keyPackage.id}`)).toEqual(
        outcome === 'delivered' ? null : expect.any(String),
      );
    },
  );

  it('removes corrupt rows and still retries the remaining payloads', async () => {
    const { backend, signEvent, payloads, seed } = setup();
    await backend.set('welcomePayloads', 'corrupt', '{');
    await seed();
    await payloads.flush();
    expect(await backend.get('welcomePayloads', 'corrupt')).toBeNull();
    expect(signEvent).toHaveBeenCalledTimes(1);
    expect(await backend.keys('welcomePayloads')).toEqual([]);
  });
});

describe('MarmotWelcomePayloads storage bound', () => {
  it('drops expired and corrupt entries and keeps at most the cap, oldest first', async () => {
    const { backend, delivery, signEvent } = setup();
    signEvent.mockRejectedValue(new Error('signer offline'));
    const now = Math.floor(Date.now() / 1000);
    await backend.set('welcomePayloads', 'corrupt', '{');
    await backend.set(
      'welcomePayloads',
      'expired',
      JSON.stringify({ groupId: GROUP, keyPackage, rumor: {}, relays: [], queuedAt: 0 }),
    );
    for (let i = 0; i < MAX_PENDING_WELCOME_PAYLOADS; i++) {
      await backend.set(
        'welcomePayloads',
        `old-${i}`,
        JSON.stringify({
          groupId: GROUP,
          keyPackage,
          rumor: {},
          relays: [],
          queuedAt: now - 100 + i,
        }),
      );
    }
    await delivery
      .deliver({
        recipient: { keyPackageEvent: { id: 'fresh', pubkey: keyPackage.pubkey } },
        groupRelays: ['relay'],
      } as unknown as Parameters<NostrWelcomeDelivery['deliver']>[0])
      .catch(() => undefined);
    const keys = await backend.keys('welcomePayloads');
    expect(keys).toHaveLength(MAX_PENDING_WELCOME_PAYLOADS);
    expect(keys).not.toContain('corrupt');
    expect(keys).not.toContain('expired');
    expect(keys).not.toContain('old-0');
    expect(keys).toContain(`${GROUP}:fresh`);
  });
});
