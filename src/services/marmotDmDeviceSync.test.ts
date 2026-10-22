// Topping up an existing 1:1 with devices installed since it began (#1559):
// the pure planner (which devices to add) and the bounded scheduler around it
// (cooldown, retry, send wait, remote signers). The real-MLS end-to-end path
// lives in marmotSessionDmDeviceSync.test.ts.
import type { Event as NostrEvent } from 'nostr-tools';

import {
  DM_DEVICE_SYNC_COOLDOWN_MS,
  DM_DEVICE_SYNC_RETRY_MS,
  MarmotDmDeviceSync,
  planDmDeviceAdds,
  type DmDevicePlanInput,
} from './marmotDmDeviceSync';
import * as invitees from './marmotInvitees';
import { MarmotWelcomeOutbox } from './marmotWelcomeOutbox';
import * as devices from './marmotDevices';
import { AmberSignerError } from './amberErrors';
import { NostrConnectError } from './signerErrors';
import { MAX_DEVICES_PER_PERSON } from './marmotInvitees';
import { createMemoryMarmotBackend } from './marmotStore';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const slot = (n: number) => n.toString(16).padStart(64, '0');

/** A stand-in key package: its leaf signature key rides in `content`. */
function kp(pubkey: string, d: string, sigKey: string, client = 'Lightning Piggy'): NostrEvent {
  return {
    id: `${pubkey.slice(0, 4)}-${d.slice(-4)}-${sigKey}`,
    pubkey,
    kind: 30443,
    created_at: 1_700_000_000,
    tags: [
      ['d', d],
      ['client', client],
    ],
    content: sigKey,
    sig: '',
  };
}

function plan(overrides: Partial<DmDevicePlanInput>) {
  return planDmDeviceAdds({
    self: ME,
    peer: PEER,
    leaves: [
      { pubkey: ME, key: 'me-here' },
      { pubkey: PEER, key: 'peer-phone' },
    ],
    fresh: new Map(),
    invitedSlots: new Set(),
    signatureKeyOf: (e) => e.content,
    ...overrides,
  });
}

const ids = (m: Map<string, NostrEvent[]>) =>
  Object.fromEntries([...m].map(([p, list]) => [p.slice(0, 1), list.map((e) => e.content)]));

describe('planDmDeviceAdds', () => {
  it("adds the contact's new install, never one already in the group", () => {
    const fresh = new Map([
      [PEER, [kp(PEER, slot(2), 'peer-tablet'), kp(PEER, slot(1), 'peer-phone')]],
    ]);
    // The phone's refreshed key package keeps its leaf signing key: a member.
    expect(ids(plan({ fresh }))).toEqual({ b: ['peer-tablet'] });
  });

  it('never adds our own installs, including a rotated key for this install', () => {
    const fresh = new Map([
      [ME, [kp(ME, slot(5), 'me-tablet'), kp(ME, slot(99), 'me-here-rotated')]],
    ]);
    expect(plan({ fresh }).size).toBe(0);
  });

  it('never re-adds a slot already invited into this group (rotated signing key)', () => {
    const fresh = new Map([[PEER, [kp(PEER, slot(1), 'peer-phone-rotated')]]]);
    expect(plan({ fresh, invitedSlots: new Set([`${PEER}:${slot(1)}`]) }).size).toBe(0);
    expect(ids(plan({ fresh }))).toEqual({ b: ['peer-phone-rotated'] });
  });

  it('never re-adds a White Noise slot with a rotated signing key and warns in dev', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fresh = new Map([[PEER, [kp(PEER, slot(1), 'peer-rotated', 'White Noise Android')]]]);
      expect(plan({ fresh, invitedSlots: new Set([`${PEER}:${slot(1)}`]) }).size).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('invited slot changed signing key'),
      );
      // Normal replenishment preserves the signing key and needs no warning.
      warn.mockClear();
      fresh.set(PEER, [kp(PEER, slot(1), 'peer-phone', 'White Noise Android')]);
      expect(plan({ fresh, invitedSlots: new Set([`${PEER}:${slot(1)}`]) }).size).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('one leaf per install: two slots with one signing key add once (#1426)', () => {
    const fresh = new Map([[PEER, [kp(PEER, slot(3), 'peer-new'), kp(PEER, slot(4), 'peer-new')]]]);
    expect(ids(plan({ fresh }))).toEqual({ b: ['peer-new'] });
  });

  it('caps a person at MAX_DEVICES_PER_PERSON leaves, counting those already in', () => {
    const many = Array.from({ length: 12 }, (_, i) => kp(PEER, slot(10 + i), `peer-${i}`));
    const added = plan({ fresh: new Map([[PEER, many]]) }).get(PEER) ?? [];
    expect(added).toHaveLength(MAX_DEVICES_PER_PERSON - 1);
    expect(added[0].content).toBe('peer-0'); // newest first
  });

  it("adds every one of a White Noise contact's installs, across apps, and none of ours (#1663)", () => {
    const fresh = new Map([
      [
        PEER,
        [
          kp(PEER, slot(1), 'peer-lp', 'Lightning Piggy'),
          kp(PEER, slot(2), 'peer-wn-new', 'White Noise Android'),
          kp(PEER, slot(3), 'peer-wn-old', 'White Noise Android'),
        ],
      ],
      [ME, [kp(ME, slot(5), 'me-tablet')]],
    ]);
    // A chat created with only their newest White Noise install (the old
    // 1:1 rule) is topped up with the rest on the next send.
    const leaves = [
      { pubkey: ME, key: 'me-here' },
      { pubkey: PEER, key: 'peer-wn-new' },
    ];
    expect(ids(plan({ fresh, leaves }))).toEqual({ b: ['peer-lp', 'peer-wn-old'] });
  });

  it('only adds the peer when both people publish fresh devices', () => {
    const fresh = new Map([
      [PEER, [kp(PEER, slot(2), 'peer-tablet')]],
      [ME, [kp(ME, slot(5), 'me-tablet')]],
    ]);
    expect(ids(plan({ fresh }))).toEqual({ b: ['peer-tablet'] });
  });
});

describe('MarmotDmDeviceSync scheduling', () => {
  function makeSync(overrides: Partial<ConstructorParameters<typeof MarmotDmDeviceSync>[0]> = {}) {
    let now = 1_000_000;
    const fetchKeyPackages = jest.fn(async (_pk: string): Promise<NostrEvent[]> => []);
    const groupState = jest.fn(async () => ({ ratchetTree: [] }));
    const invite = jest.fn(async () => undefined);
    const backend = createMemoryMarmotBackend();
    const sync = new MarmotDmDeviceSync({
      self: ME,
      backend,
      fetchKeyPackages,
      groupState,
      invite,
      silentSigner: true,
      stopped: () => false,
      now: () => now,
      ...overrides,
    });
    return {
      sync,
      fetchKeyPackages,
      groupState,
      invite,
      backend,
      tick: (ms: number) => (now += ms),
    };
  }

  it('looks only the peer up once, then not again until the cooldown has passed', async () => {
    const { sync, fetchKeyPackages, tick } = makeSync();
    await sync.sync('g1', PEER, 'send');
    expect(fetchKeyPackages.mock.calls.map((c) => c[0])).toEqual([PEER]);
    await sync.sync('g1', PEER, 'send');
    tick(DM_DEVICE_SYNC_COOLDOWN_MS - 1);
    await sync.sync('g1', PEER, 'open');
    expect(fetchKeyPackages).toHaveBeenCalledTimes(1);
    tick(2);
    await sync.sync('g1', PEER, 'send');
    expect(fetchKeyPackages).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup never throws, and is retried sooner than the cooldown', async () => {
    const { sync, fetchKeyPackages, invite, tick } = makeSync();
    fetchKeyPackages.mockRejectedValue(new Error('relay down'));
    await expect(sync.sync('g1', PEER, 'send')).resolves.toBeUndefined();
    expect(invite).not.toHaveBeenCalled();
    tick(DM_DEVICE_SYNC_RETRY_MS - 1);
    await sync.sync('g1', PEER, 'send');
    expect(fetchKeyPackages).toHaveBeenCalledTimes(1);
    tick(2);
    await sync.sync('g1', PEER, 'send');
    expect(fetchKeyPackages).toHaveBeenCalledTimes(2);
  });

  it('a send waits for a slow lookup only briefly', async () => {
    const { sync, fetchKeyPackages } = makeSync({ sendWaitMs: 20 });
    fetchKeyPackages.mockImplementation(() => new Promise<NostrEvent[]>(() => undefined));
    const started = Date.now();
    await sync.sync('g1', PEER, 'send');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('opening a chat never commits for a remote signer — it only warms the lookup', async () => {
    const { sync, fetchKeyPackages, groupState, invite } = makeSync({ silentSigner: false });
    await sync.sync('g1', PEER, 'open');
    expect(fetchKeyPackages).toHaveBeenCalledTimes(1);
    expect(groupState).not.toHaveBeenCalled();
    expect(invite).not.toHaveBeenCalled();
    // The send then reuses the warmed lookup.
    await sync.sync('g1', PEER, 'send');
    expect(fetchKeyPackages).toHaveBeenCalledTimes(1);
    expect(groupState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Amber', () => new AmberSignerError('CANCELLED', 'declined', 'User declined')],
    ['NIP-46', () => new NostrConnectError('permission', 'Signer denied sign_event')],
  ])('%s suppresses the declined package but allows a new package or session', async (_, error) => {
    const selected = jest
      .spyOn(invitees, 'selectDeviceKeyPackages')
      .mockImplementation(async (p) => [kp(p, slot(2), 'new-device')]);
    const signature = jest
      .spyOn(devices, 'keyPackageSignatureKey')
      .mockImplementation((e) => e.content);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const invite = jest.fn().mockRejectedValue(error());
      const { sync, tick } = makeSync({ silentSigner: false, invite });
      await sync.sync('g1', PEER, 'send');
      expect(invite).toHaveBeenCalledTimes(1);
      // Subsequent sends and background opens remain quiet, even beyond cooldown.
      for (const ms of [0, DM_DEVICE_SYNC_RETRY_MS + 1, DM_DEVICE_SYNC_COOLDOWN_MS + 1]) {
        tick(ms);
        await sync.sync('g1', PEER, 'send');
        await sync.sync('g1', PEER, 'open');
      }
      expect(invite).toHaveBeenCalledTimes(1);
      // A new package (even for the same slot) may prompt; other chats are independent.
      selected.mockImplementation(async (p) => [kp(p, slot(2), 'replenished-device')]);
      tick(DM_DEVICE_SYNC_COOLDOWN_MS + 1);
      await sync.sync('g1', PEER, 'send');
      expect(invite).toHaveBeenCalledTimes(2);
      await sync.sync('g2', PEER, 'send');
      expect(invite).toHaveBeenCalledTimes(3);
      const restarted = makeSync({ silentSigner: false, invite });
      await restarted.sync.sync('g1', PEER, 'open');
      expect(invite).toHaveBeenCalledTimes(3);
      await restarted.sync.sync('g1', PEER, 'send');
      expect(invite).toHaveBeenCalledTimes(4);
    } finally {
      selected.mockRestore();
      signature.mockRestore();
      warn.mockRestore();
    }
  });

  it('suppresses a refusal even when Welcome delivery swallows the signer error', async () => {
    const selected = jest
      .spyOn(invitees, 'selectDeviceKeyPackages')
      .mockImplementation(async (p) => [kp(p, slot(2), 'new-device')]);
    const signature = jest
      .spyOn(devices, 'keyPackageSignatureKey')
      .mockImplementation((e) => e.content);
    try {
      const signEvent = jest
        .fn()
        .mockRejectedValue(new NostrConnectError('permission', 'Signer denied sign_event'));
      const encrypt = jest
        .fn()
        .mockRejectedValue(new AmberSignerError('CANCELLED', 'declined', 'User declined'));
      for (const method of ['signEvent', 'encrypt'] as const) {
        const { sync, tick } = makeSync({
          silentSigner: false,
          // marmot-ts catches the error and resolves with a failed delivery outcome.
          invite: async () => {
            const signer = sync.observeSigner(
              {
                getPublicKey: async () => ME,
                signEvent,
                nip44: { encrypt, decrypt: async () => '' },
              },
              'g1',
              [kp(PEER, slot(2), 'new-device')],
            );
            await Promise.resolve(
              method === 'signEvent'
                ? signer.signEvent({ kind: 13, created_at: 1, tags: [], content: '' })
                : signer.nip44!.encrypt(PEER, 'welcome'),
            ).catch(() => undefined);
          },
        });
        await sync.sync('g1', PEER, 'send');
        tick(DM_DEVICE_SYNC_COOLDOWN_MS + 1);
        await sync.sync('g1', PEER, 'send');
        expect(method === 'signEvent' ? signEvent : encrypt).toHaveBeenCalledTimes(1);
      }
    } finally {
      selected.mockRestore();
      signature.mockRestore();
    }
  });

  it('attributes a swallowed refusal only to the active invitation while another chat is queued', async () => {
    const selected = jest
      .spyOn(invitees, 'selectDeviceKeyPackages')
      .mockImplementation(async (p) => [kp(p, slot(2), 'new-device')]);
    const signature = jest
      .spyOn(devices, 'keyPackageSignatureKey')
      .mockImplementation((e) => e.content);
    try {
      const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: string[] = [];
      let transient = true;
      const { sync, tick } = makeSync({
        silentSigner: false,
        invite: (id, plan) =>
          outbox.capture(async () => {
            calls.push(id);
            if (id === 'g1') {
              await gate;
              const signer = sync.observeSigner(
                {
                  getPublicKey: async () => ME,
                  signEvent: async () => {
                    throw new NostrConnectError('permission', 'denied');
                  },
                },
                id,
                [...plan.values()].flat(),
              );
              await Promise.resolve(
                signer.signEvent({ kind: 13, created_at: 1, tags: [], content: '' }),
              ).catch(() => undefined);
            } else if (transient) {
              throw new Error('commit publication failed');
            }
          }),
      });
      const first = sync.sync('g1', PEER, 'send');
      const queued = sync.sync('g2', PEER, 'send');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual(['g1']);
      release();
      await Promise.all([first, queued]);
      transient = false;
      tick(DM_DEVICE_SYNC_COOLDOWN_MS + 1);
      await sync.sync('g1', PEER, 'send');
      await sync.sync('g2', PEER, 'send');
      expect(calls).toEqual(['g1', 'g2', 'g2']);
    } finally {
      selected.mockRestore();
      signature.mockRestore();
    }
  });

  it('remembers an existing White Noise leaf slot before its signing key rotates', async () => {
    let current = kp(PEER, slot(1), 'peer-phone', 'White Noise Android');
    const selected = jest
      .spyOn(invitees, 'selectDeviceKeyPackages')
      .mockImplementation(async () => [current]);
    const signature = jest
      .spyOn(devices, 'keyPackageSignatureKey')
      .mockImplementation((e) => e.content);
    const leaves = jest
      .spyOn(devices, 'readGroupLeaves')
      .mockReturnValue([
        { pubkey: PEER, key: 'peer-phone', leafIndex: 1, keyCreatedAt: null, isOwn: false },
      ]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { sync, fetchKeyPackages, invite, backend, tick } = makeSync();
      fetchKeyPackages.mockImplementation(async () => [current]);
      await sync.sync('g1', PEER, 'send');
      expect(JSON.parse((await backend.get('dmDeviceSlots', 'g1')) ?? '[]')).toEqual([
        `${PEER}:${slot(1)}`,
      ]);
      current = kp(PEER, slot(1), 'peer-rotated', 'White Noise Android');
      tick(DM_DEVICE_SYNC_COOLDOWN_MS + 1);
      await sync.sync('g1', PEER, 'send');
      expect(invite).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('invited slot changed signing key'),
      );
    } finally {
      selected.mockRestore();
      signature.mockRestore();
      leaves.mockRestore();
      warn.mockRestore();
    }
  });

  it('retries a transient remote invite failure after one minute', async () => {
    const selected = jest
      .spyOn(invitees, 'selectDeviceKeyPackages')
      .mockImplementation(async (p) => [kp(p, slot(2), 'new-device')]);
    const signature = jest
      .spyOn(devices, 'keyPackageSignatureKey')
      .mockImplementation((e) => e.content);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const invite = jest
        .fn()
        .mockRejectedValueOnce(new NostrConnectError('failed', 'network timeout'))
        .mockResolvedValue(undefined);
      const { sync, tick } = makeSync({ silentSigner: false, invite });
      await sync.sync('g1', PEER, 'send');
      tick(DM_DEVICE_SYNC_RETRY_MS + 1);
      await sync.sync('g1', PEER, 'send');
      expect(invite).toHaveBeenCalledTimes(2);
    } finally {
      selected.mockRestore();
      signature.mockRestore();
      warn.mockRestore();
    }
  });

  it('a just-sent invite records its slots and skips the next check', async () => {
    const { sync, fetchKeyPackages, backend } = makeSync();
    await sync.noteInvited('g1', [kp(PEER, slot(1), 'k1'), kp(ME, slot(5), 'k2')]);
    await sync.noteInvited('g1', [kp(PEER, slot(1), 'k1')]);
    expect(JSON.parse((await backend.get('dmDeviceSlots', 'g1')) ?? '[]')).toEqual([
      `${PEER}:${slot(1)}`,
      `${ME}:${slot(5)}`,
    ]);
    await sync.sync('g1', PEER, 'send');
    expect(fetchKeyPackages).not.toHaveBeenCalled();
  });

  it('does nothing once the session has stopped', async () => {
    const { sync, fetchKeyPackages } = makeSync({ stopped: () => true });
    await sync.sync('g1', PEER, 'send');
    expect(fetchKeyPackages).not.toHaveBeenCalled();
  });
});
