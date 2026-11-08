// Where a Marmot Welcome goes (#1402): the invitee's 10050; only on a
// confirmed absence, their own hints; else nowhere (queued unsigned, retried).
import type { NostrWelcomeDelivery } from '@internet-privacy/marmot-ts';
import { GiftWrapFactory } from 'applesauce-common/factories/gift-wrap';
import type { Event as NostrEvent } from 'nostr-tools';
import { AppState, type AppStateStatus } from 'react-native';

import { MarmotDmDeviceSync } from './marmotDmDeviceSync';
import { createMemoryMarmotBackend } from './marmotStore';
import { INVITE_CHANGE_COALESCE_MS, MarmotWelcomeOutbox } from './marmotWelcomeOutbox';
import {
  MarmotWelcomePayloads,
  NO_RELAYS_RETRY_MS,
  WELCOME_RETRY_DELAY_MS,
} from './marmotWelcomePayloads';
import {
  keyPackageRelayHints,
  MAX_WELCOME_HINT_RELAYS,
  MarmotInviteesUnreachableError,
  MarmotNoWelcomeRelaysError,
  requireWelcomeDestination,
  welcomeRelays,
} from './marmotWelcomeRelays';

const INVITEE = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const INBOX = 'wss://inbox.example.com/';
const READ = 'wss://read.example.com/';
const keyPackage = (tags: string[][] = [], pubkey = INVITEE, id = 'package') =>
  ({ id, pubkey, kind: 30443, tags }) as unknown as NostrEvent;
const hinted = keyPackage([
  ['relays', 'wss://hint.example.com', 'ws://lan.example.com', 'wss://192.168.1.10'],
]);
/** `relays` per pubkey; an Error makes that lookup reject (unknown). */
const inboxOf = (relays: string[] | Error, byPubkey: Record<string, string[] | Error> = {}) => ({
  getUserInboxRelays: jest.fn(async (pubkey: string) => {
    const r = byPubkey[pubkey] ?? relays;
    if (r instanceof Error) throw r;
    return r;
  }),
});
const reasonOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof MarmotNoWelcomeRelaysError ? e.reason : 'other'),
  );

describe('welcomeRelays', () => {
  it("uses the invitee's 10050 inbox alone when they publish one", async () => {
    const network = inboxOf([INBOX]);
    const read = jest.fn(async () => [READ]);
    expect(await welcomeRelays(network, hinted, read)).toEqual([INBOX]);
    expect(network.getUserInboxRelays).toHaveBeenCalledWith(INVITEE);
    expect(read).not.toHaveBeenCalled();
  });

  it('on a confirmed absence, uses their NIP-65 read relays, then the KeyPackage hints', async () => {
    const read = jest.fn(async () => [READ, 'wss://hint.example.com/']);
    expect(await welcomeRelays(inboxOf([]), hinted, read)).toEqual([
      READ,
      'wss://hint.example.com/',
    ]);
    expect(read).toHaveBeenCalledWith(INVITEE);
    // Public wss hints only; read relays alone are enough.
    expect(await welcomeRelays(inboxOf([]), hinted)).toEqual(['wss://hint.example.com/']);
    expect(await welcomeRelays(inboxOf([]), keyPackage(), async () => [READ])).toEqual([READ]);
  });

  it(`caps the combined hints at ${MAX_WELCOME_HINT_RELAYS}, read relays first`, async () => {
    const many = Array.from({ length: 10 }, (_, i) => `wss://r${i}.example.com/`);
    const relays = await welcomeRelays(inboxOf([]), hinted, async () => many);
    expect(relays).toEqual(many.slice(0, MAX_WELCOME_HINT_RELAYS));
  });

  it('an inbox lookup that could not tell is unknown — never a fall-through to the hints', async () => {
    const read = jest.fn(async () => [READ]);
    expect(await reasonOf(welcomeRelays(inboxOf(new Error('offline')), hinted, read))).toBe(
      'unknown',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('throws noRelays — no default relays — when it is confirmed there is nothing', async () => {
    expect(await reasonOf(welcomeRelays(inboxOf([]), keyPackage(), async () => []))).toBe(
      'noRelays',
    );
    const failedRead = async () => Promise.reject(new Error('offline'));
    expect(await reasonOf(welcomeRelays(inboxOf([]), keyPackage(), failedRead))).toBe('noRelays');
  });

  it('treats malformed KeyPackage tags as no hints', () => {
    expect(keyPackageRelayHints({ pubkey: INVITEE } as NostrEvent)).toEqual([]);
    expect(keyPackageRelayHints(keyPackage([['relays']]))).toEqual([]);
  });
});

describe('requireWelcomeDestination', () => {
  const none = keyPackage([], INVITEE);
  const otherNone = keyPackage([], OTHER, 'other');
  const noRead = async () => [];

  it('throws when it is confirmed that nobody can be reached', async () => {
    const devices = new Map([
      [INVITEE, [none]],
      [OTHER, [otherNone]],
    ]);
    const error = await requireWelcomeDestination(inboxOf([]), devices, noRead).catch((e) => e);
    expect(error).toBeInstanceOf(MarmotInviteesUnreachableError);
    expect((error as MarmotInviteesUnreachableError).people).toEqual([INVITEE, OTHER]);
  });

  it('goes ahead when anyone is reachable, by inbox or by a device hint', async () => {
    const devices = new Map([
      [INVITEE, [none]],
      [OTHER, [otherNone]],
    ]);
    await expect(
      requireWelcomeDestination(inboxOf([], { [OTHER]: [INBOX] }), devices, noRead),
    ).resolves.toBeUndefined();
    const hintedDevice = new Map([[INVITEE, [none, hinted]]]);
    await expect(
      requireWelcomeDestination(inboxOf([]), hintedDevice, noRead),
    ).resolves.toBeUndefined();
  });

  it('does not block on a lookup that could not tell', async () => {
    const devices = new Map([[INVITEE, [none]]]);
    await expect(
      requireWelcomeDestination(inboxOf(new Error('offline')), devices, noRead),
    ).resolves.toBeUndefined();
  });

  it('accepts an empty invite', async () => {
    await expect(
      requireWelcomeDestination(inboxOf([]), new Map(), noRead),
    ).resolves.toBeUndefined();
  });
});

describe('MarmotWelcomePayloads routing and retries', () => {
  const GROUP = 'group';
  const wrap = { id: 'wrap', kind: 1059, tags: [['p', INVITEE]] } as NostrEvent;

  function setup(inbox: string[] | Error, read: string[] = []) {
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
    const publish = jest.fn(async (relays: string[]) =>
      Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }])),
    );
    const network = { inbox, publish, getUserInboxRelays: jest.fn() };
    network.getUserInboxRelays.mockImplementation(async () => {
      if (network.inbox instanceof Error) throw network.inbox;
      return network.inbox;
    });
    const delivery = {
      signer: { getPublicKey: () => 'a'.repeat(64), signEvent },
      network,
      createRumor: () => ({}),
    } as unknown as NostrWelcomeDelivery;
    const payloads = new MarmotWelcomePayloads(
      backend,
      outbox,
      devices,
      () => false,
      async () => read,
    );
    payloads.attach({ idStr: GROUP, runtime: { welcomeDelivery: delivery } } as Parameters<
      MarmotWelcomePayloads['attach']
    >[0]);
    const deliver = (kp: NostrEvent) =>
      delivery.deliver({
        recipient: { pubkey: INVITEE, keyPackageEventId: kp.id, keyPackageEvent: kp },
        // The group's relays: never a Welcome destination.
        groupRelays: ['wss://group.example.com'],
      } as unknown as Parameters<NostrWelcomeDelivery['deliver']>[0]);
    const stored = async () =>
      JSON.parse((await backend.get('welcomePayloads', `${GROUP}:package`)) ?? 'null') as {
        reason?: string;
      } | null;
    return { backend, outbox, signEvent, publish, network, deliver, payloads, stored };
  }

  beforeEach(() => {
    jest.spyOn(GiftWrapFactory, 'create').mockImplementation(async (signer) => {
      await signer.signEvent({ kind: 13, created_at: 1, tags: [], content: '' });
      return wrap as never;
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('reports the chat as changed when a Welcome is queued and when its reason is recorded', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const t = setup([]);
    const seen: string[] = [];
    const stop = t.outbox.changes.subscribe((id) => seen.push(id));
    await t.deliver(keyPackage()).catch(() => undefined);
    await jest.advanceTimersByTimeAsync(INVITE_CHANGE_COALESCE_MS);
    // Queued + reason recorded in one burst: one notification for the chat.
    expect(seen).toEqual([GROUP]);
    stop();
  });

  it('a group dropped while the inbox lookup is pending: no signer prompt, nothing queued or sent', async () => {
    const t = setup([INBOX]);
    let answer!: (relays: string[]) => void;
    t.network.getUserInboxRelays.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (answer = resolve)),
    );
    const pending = t.deliver(hinted);
    while (!answer) await new Promise((resolve) => setTimeout(resolve, 0));
    await t.payloads.drop(GROUP, { outbox: true });
    answer([INBOX]);
    await expect(pending).rejects.toThrow('dropped');
    expect(t.signEvent).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
    expect(await t.outbox.pending()).toEqual([]);
    expect(await t.backend.keys('welcomePayloads')).toEqual([]);
  });

  it('a group dropped while the signer is open: the signed Welcome is neither queued nor sent', async () => {
    const t = setup([INBOX]);
    let approve!: () => void;
    t.signEvent.mockImplementationOnce(
      () => new Promise<NostrEvent>((resolve) => (approve = () => resolve(wrap))),
    );
    const pending = t.deliver(hinted);
    while (!approve) await new Promise((resolve) => setTimeout(resolve, 0));
    await t.payloads.drop(GROUP, { outbox: true });
    approve();
    await expect(pending).rejects.toThrow('dropped');
    expect(t.publish).not.toHaveBeenCalled();
    expect(await t.outbox.pending()).toEqual([]);
    expect(await t.backend.keys('welcomePayloads')).toEqual([]);
  });

  it('publishes to the invitee inbox', async () => {
    const t = setup([INBOX]);
    await t.deliver(hinted);
    expect(t.publish).toHaveBeenCalledWith([INBOX], wrap);
  });

  it('uses the invitee hints on a confirmed absence — not the group relays', async () => {
    const t = setup([], [READ]);
    await t.deliver(hinted);
    expect(t.publish).toHaveBeenCalledWith([READ, 'wss://hint.example.com/'], wrap);
  });

  it.each([
    ['noRelays', [] as string[]],
    ['unknown', new Error('offline')],
  ] as const)(
    '%s: asks no signer, signs and publishes nothing, keeps it queued with its reason',
    async (reason, inbox) => {
      const t = setup(inbox);
      await expect(t.deliver(reason === 'unknown' ? hinted : keyPackage())).rejects.toBeInstanceOf(
        MarmotNoWelcomeRelaysError,
      );
      expect(t.signEvent).not.toHaveBeenCalled();
      expect(t.publish).not.toHaveBeenCalled();
      // Nothing frozen in the signed outbox: the next retry decides again.
      expect(await t.outbox.pending()).toEqual([]);
      expect((await t.stored())?.reason).toBe(reason);
      expect(await t.payloads.waitingForRelays(GROUP)).toEqual(
        new Set(reason === 'noRelays' ? [INVITEE] : []),
      );
      expect(await t.payloads.inviteStatus(GROUP)).toEqual(
        new Map([[INVITEE, reason === 'noRelays' ? 'waitingForRelays' : 'pending']]),
      );
    },
  );

  it('retries with backoff, then delivers once the invitee publishes an inbox', async () => {
    const t = setup([]);
    await t.deliver(keyPackage()).catch(() => undefined);
    const lookups = () => t.network.getUserInboxRelays.mock.calls.length;
    expect(lookups()).toBe(1);
    // Inside the backoff: a send / open doesn't redo the lookup.
    await t.payloads.retry(GROUP);
    expect(lookups()).toBe(1);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + NO_RELAYS_RETRY_MS);
    t.network.inbox = [INBOX];
    await t.payloads.retry(GROUP);
    expect(t.publish).toHaveBeenCalledWith([INBOX], wrap);
    expect(t.signEvent).toHaveBeenCalledTimes(1);
    expect(await t.payloads.inviteStatus(GROUP)).toEqual(new Map());
  });

  it('local keys: retries in full 3 s after session start and on each foreground resume', async () => {
    const changes: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, listener) => {
      changes.push(listener);
      return { remove: jest.fn() };
    });
    const t = setup(new Error('offline'));
    await t.deliver(hinted).catch(() => undefined);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + NO_RELAYS_RETRY_MS);
    t.network.inbox = [INBOX];
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const stop = t.payloads.scheduleRetries(true);
    await jest.advanceTimersByTimeAsync(WELCOME_RETRY_DELAY_MS - 1);
    expect(t.publish).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(t.publish).toHaveBeenCalledWith([INBOX], wrap);

    // A later Welcome with nowhere to go yet is picked up on resume.
    t.network.inbox = new Error('offline');
    await t.deliver(keyPackage([], INVITEE, 'package')).catch(() => undefined);
    clock.mockReturnValue(now + 3 * NO_RELAYS_RETRY_MS);
    t.network.inbox = [INBOX];
    changes.forEach((change) => change('active'));
    await jest.advanceTimersByTimeAsync(WELCOME_RETRY_DELAY_MS);
    expect(t.publish).toHaveBeenCalledTimes(2);
    stop();
  });

  it('remote signers: start / resume only re-check (no signing); a user action signs', async () => {
    const changes: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, listener) => {
      changes.push(listener);
      return { remove: jest.fn() };
    });
    const t = setup([]);
    await t.deliver(keyPackage()).catch(() => undefined);
    expect(await t.payloads.inviteStatus(GROUP)).toEqual(new Map([[INVITEE, 'waitingForRelays']]));
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + NO_RELAYS_RETRY_MS);
    // They publish an inbox: the background pass sees it but asks no signer.
    t.network.inbox = [INBOX];
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const stop = t.payloads.scheduleRetries(false);
    await jest.advanceTimersByTimeAsync(WELCOME_RETRY_DELAY_MS);
    expect(t.network.getUserInboxRelays).toHaveBeenCalledTimes(2);
    expect(t.signEvent).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
    // The status is kept true: no longer waiting on their relays, just not sent yet.
    expect((await t.stored())?.reason).toBeUndefined();
    expect(await t.payloads.inviteStatus(GROUP)).toEqual(new Map([[INVITEE, 'pending']]));
    // Resume: still no signing.
    clock.mockReturnValue(now + 2 * NO_RELAYS_RETRY_MS);
    changes.forEach((change) => change('active'));
    await jest.advanceTimersByTimeAsync(WELCOME_RETRY_DELAY_MS);
    expect(t.signEvent).not.toHaveBeenCalled();
    // The user sends in / opens the chat: now it's signed and delivered.
    await t.payloads.retry(GROUP);
    expect(t.signEvent).toHaveBeenCalledTimes(1);
    expect(t.publish).toHaveBeenCalledWith([INBOX], wrap);
    expect(await t.payloads.inviteStatus(GROUP)).toEqual(new Map());
    stop();
  });

  it('remote signers: a re-check that still finds nothing keeps the reason and backs off', async () => {
    const t = setup([]);
    await t.deliver(keyPackage()).catch(() => undefined);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + NO_RELAYS_RETRY_MS);
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const stop = t.payloads.scheduleRetries(false);
    await jest.advanceTimersByTimeAsync(WELCOME_RETRY_DELAY_MS);
    expect(t.network.getUserInboxRelays).toHaveBeenCalledTimes(2);
    expect((await t.stored())?.reason).toBe('noRelays');
    expect(t.signEvent).not.toHaveBeenCalled();
    stop();
  });
});
