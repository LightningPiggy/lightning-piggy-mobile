// Invitations to people with nowhere a Welcome can go (#1402), end to end
// with real MLS: nothing is created when nobody is reachable, and an
// unreachable member of an existing chat is invited once they publish relays.
import type { MarmotClient, NostrNetworkInterface } from '@internet-privacy/marmot-ts';

import { makeRelay, makeSession, RELAY, unwrapWelcomes } from './marmotSessionTestKit';
import { MarmotWelcomePayloads, NO_RELAYS_RETRY_MS } from './marmotWelcomePayloads';
import { MarmotInviteesUnreachableError } from './marmotWelcomeRelays';

// Lightning Piggy key packages always carry a `relays` hint; these people's
// are treated as if they had none.
const mockNoHints = new Set<string>();
jest.mock('@internet-privacy/marmot-ts', () => {
  const actual = jest.requireActual('@internet-privacy/marmot-ts');
  return {
    ...actual,
    getKeyPackageRelays: (e: { pubkey: string }) =>
      mockNoHints.has(e.pubkey) ? undefined : actual.getKeyPackageRelays(e),
  };
});

/** A network whose inbox lookup finds nothing for `unreachable` people. */
function withInboxes(relay: ReturnType<typeof makeRelay>, unreachable: Set<string>) {
  return {
    ...relay.network,
    getUserInboxRelays: async (pubkey: string) => (unreachable.has(pubkey) ? [] : [RELAY]),
  } as unknown as NostrNetworkInterface;
}

afterEach(() => {
  jest.restoreAllMocks();
  mockNoHints.clear();
});

test('creates nothing — no group, no Welcome, no signer prompt — when nobody can be reached', async () => {
  const relay = makeRelay();
  const bob = makeSession(relay);
  const unreachable = new Set([bob.pubkey]);
  mockNoHints.add(bob.pubkey);
  const alice = makeSession(relay, undefined, 'nsec', { network: withInboxes(relay, unreachable) });
  await alice.session.start();
  await bob.session.start();
  await bob.session.ensureKeyPackage();
  const sign = jest.spyOn(alice.signer, 'signEvent');

  await expect(alice.session.getOrCreateDm(bob.pubkey)).rejects.toBeInstanceOf(
    MarmotInviteesUnreachableError,
  );
  await expect(alice.session.createGroup('group', [bob.pubkey])).rejects.toBeInstanceOf(
    MarmotInviteesUnreachableError,
  );
  expect(alice.session.listGroups()).toHaveLength(0);
  expect(unwrapWelcomes(relay, bob)).toHaveLength(0);
  expect(sign).not.toHaveBeenCalled();
  alice.session.stop();
  bob.session.stop();
});

test("an unreachable member of an existing chat is shown as waiting, and invited once they're reachable", async () => {
  const relay = makeRelay();
  const bob = makeSession(relay);
  const carol = makeSession(relay);
  const unreachable = new Set([carol.pubkey]);
  mockNoHints.add(carol.pubkey);
  const alice = makeSession(relay, undefined, 'nsec', { network: withInboxes(relay, unreachable) });
  for (const s of [alice, bob, carol]) await s.session.start();
  await bob.session.ensureKeyPackage();
  await carol.session.ensureKeyPackage();
  const group = await alice.session.createGroup('group', [bob.pubkey]);

  // Invited alone, nothing is committed: she can't be reached yet.
  await expect(alice.session.addMembers(group.id, [carol.pubkey])).rejects.toBeInstanceOf(
    MarmotInviteesUnreachableError,
  );

  // Invited together with someone reachable, she joins the roster but waits.
  const dave = makeSession(relay);
  await dave.session.start();
  await dave.session.ensureKeyPackage();
  const added = await alice.session.addMembers(group.id, [carol.pubkey, dave.pubkey]);
  expect(added).toEqual({
    undelivered: [carol.pubkey],
    waitingForRelays: [carol.pubkey],
    needsSigner: [],
  });
  expect(await alice.session.pendingInvites(group.id)).toEqual(
    new Map([[carol.pubkey, 'waitingForRelays']]),
  );
  expect(unwrapWelcomes(relay, carol)).toHaveLength(0);
  expect(unwrapWelcomes(relay, dave)).toHaveLength(1);

  // She publishes an inbox; past the backoff, the next send in the chat delivers it.
  unreachable.delete(carol.pubkey);
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + NO_RELAYS_RETRY_MS);
  alice.session.retryInvites(group.id);
  for (let i = 0; i < 200 && unwrapWelcomes(relay, carol).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(unwrapWelcomes(relay, carol)).toHaveLength(1);
  expect(await alice.session.pendingInvites(group.id)).toEqual(new Map());
  for (const s of [alice, bob, carol, dave]) s.session.stop();
});

test.each([
  ['nsec', true],
  ['amber', false],
] as const)('%s: background invitation retries sign = %s', async (signerType, sign) => {
  const schedule = jest.spyOn(MarmotWelcomePayloads.prototype, 'scheduleRetries');
  const relay = makeRelay();
  const who = makeSession(relay, undefined, signerType);
  await who.session.start();
  expect(schedule).toHaveBeenCalledWith(sign);
  who.session.stop();
});

test('a remote signer is only asked from a send, never from opening the chat', () => {
  const relay = makeRelay();
  const amber = makeSession(relay, undefined, 'amber');
  const payloads = (amber.session as unknown as { welcomePayloads: { retry: () => void } })
    .welcomePayloads;
  const retry = jest.spyOn(payloads, 'retry').mockResolvedValue(undefined as never);
  amber.session.retryInvites('marmot:abcd', 'open');
  expect(retry).not.toHaveBeenCalled();
  amber.session.retryInvites('marmot:abcd', 'send');
  expect(retry).toHaveBeenCalledWith('abcd');
});

test('an inbox lookup that could not tell keeps the new chat, its invitation queued unsigned (#1402)', async () => {
  const relay = makeRelay();
  const bob = makeSession(relay);
  let lookupDown = true;
  const network = {
    ...relay.network,
    getUserInboxRelays: async (pubkey: string) => {
      if (lookupDown && pubkey === bob.pubkey) throw new Error('No relay answered');
      return [RELAY];
    },
  } as unknown as NostrNetworkInterface;
  const alice = makeSession(relay, undefined, 'nsec', { network });
  await alice.session.start();
  await bob.session.start();
  await bob.session.ensureKeyPackage();

  // Unknown doesn't block the Add; once committed, nothing is undone.
  const group = await alice.session.createGroup('group', [bob.pubkey]);
  expect(group).toMatchObject({ undelivered: [bob.pubkey], waitingForRelays: [] });
  expect(alice.session.listGroups()).toHaveLength(1);
  expect(await alice.session.pendingInvites(group.id)).toEqual(new Map([[bob.pubkey, 'pending']]));
  expect(unwrapWelcomes(relay, bob)).toHaveLength(0);

  // The lookup works again: a send in the chat (past the backoff) delivers it.
  lookupDown = false;
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + NO_RELAYS_RETRY_MS);
  alice.session.retryInvites(group.id);
  for (let i = 0; i < 200 && unwrapWelcomes(relay, bob).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(unwrapWelcomes(relay, bob)).toHaveLength(1);
  expect(await alice.session.pendingInvites(group.id)).toEqual(new Map());
  alice.session.stop();
  bob.session.stop();
});

test("leaving a chat drops its signed invitations too, so they aren't republished for 14 days", async () => {
  const relay = makeRelay();
  const publish = relay.network.publish;
  relay.network.publish = async (relays, event) =>
    event.kind === 1059
      ? Object.fromEntries(relays.map((r) => [r, { from: r, ok: false, message: 'no' }]))
      : publish(relays, event);
  const alice = makeSession(relay);
  const bob = makeSession(relay);
  await alice.session.start();
  await bob.session.start();
  await bob.session.ensureKeyPackage();
  const group = await alice.session.createGroup('group', [bob.pubkey]);
  const outbox = (alice.session as unknown as { outbox: { pending: () => Promise<unknown[]> } })
    .outbox;
  expect(await outbox.pending()).toHaveLength(1);
  await alice.session.leave(group.id);
  for (let i = 0; i < 100 && (await outbox.pending()).length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await outbox.pending()).toHaveLength(0);
  alice.session.stop();
  bob.session.stop();
});

test('a chat dropped while its first Welcome publish is pending is neither resent nor re-queued', async () => {
  const relay = makeRelay();
  const publish = relay.network.publish;
  let wraps = 0;
  let whilePending: (() => Promise<void>) | null = null;
  relay.network.publish = async (relays, event) => {
    if (event.kind !== 1059) return publish(relays, event);
    wraps++;
    const hook = whilePending;
    whilePending = null;
    await hook?.();
    return Object.fromEntries(relays.map((r) => [r, { from: r, ok: false, message: 'no' }]));
  };
  const alice = makeSession(relay);
  const bob = makeSession(relay);
  await alice.session.start();
  await bob.session.start();
  await bob.session.ensureKeyPackage();
  const internals = alice.session as unknown as {
    client: MarmotClient;
    welcomePayloads: { drop(id: string, opts: { outbox: boolean }): Promise<void> };
    outbox: { pending(): Promise<unknown[]> };
  };
  // The chat is left / destroyed while its Welcome's publish is in flight;
  // that publish then fails and lands in the invite's captured failures.
  whilePending = () =>
    internals.welcomePayloads.drop(internals.client.groups.loaded[0].idStr, { outbox: true });
  await alice.session.createGroup('group', [bob.pubkey]);
  expect(wraps).toBe(1); // no resend
  expect(await internals.outbox.pending()).toEqual([]); // nothing re-queued
  alice.session.stop();
  bob.session.stop();
});

test("an Add refused while another member's commit lands is a real failure, not 'not delivered yet'", async () => {
  const relay = makeRelay();
  const alice = makeSession(relay);
  const bob = makeSession(relay);
  const carol = makeSession(relay);
  for (const s of [alice, bob, carol]) await s.session.start();
  await bob.session.ensureKeyPackage();
  await carol.session.ensureKeyPackage();
  const group = await alice.session.createGroup('group', [bob.pubkey], {
    adminPubkeys: [alice.pubkey, bob.pubkey],
  });
  await bob.session.acceptWelcome(unwrapWelcomes(relay, bob)[0]);
  // Our Add is refused (marmot-ts rolls it back) while Bob's rename commit is
  // processed: the epoch moves on, but Carol never became a member.
  jest
    .spyOn(alice.session as unknown as { inviteAll: () => Promise<never> }, 'inviteAll')
    .mockImplementationOnce(async () => {
      await bob.session.rename(group.id, 'renamed');
      for (let i = 0; i < 200 && alice.session.getGroup(group.id)?.name !== 'renamed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(alice.session.getGroup(group.id)?.name).toBe('renamed');
      throw new Error('commit refused');
    });
  await expect(alice.session.addMembers(group.id, [carol.pubkey])).rejects.toThrow(
    'commit refused',
  );
  expect(alice.session.getGroup(group.id)?.memberPubkeys).not.toContain(carol.pubkey);
  expect(await alice.session.pendingInvites(group.id)).toEqual(new Map());
  for (const s of [alice, bob, carol]) s.session.stop();
});
