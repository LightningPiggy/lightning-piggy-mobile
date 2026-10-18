import { MarmotClient } from '@internet-privacy/marmot-ts';
import { MarmotPendingInvitations } from './marmotPendingInvitations';
import {
  makeInstall,
  makeSigner,
  makeRelay,
  makeSession,
  unwrapWelcomes,
  waitFor,
} from './marmotSessionTestKit';

it('previews a real pending Welcome without consuming its key, then acceptance joins exactly once', async () => {
  const relay = makeRelay();
  const alice = makeSession(relay),
    bob = makeSession(relay);
  try {
    await Promise.all([alice.session.start(), bob.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    const created = await alice.session.createGroup('Family', [bob.pubkey]);
    const [welcome] = unwrapWelcomes(relay, bob);
    const invitations = new MarmotPendingInvitations(bob.backend, () => {});
    const join = jest.spyOn(MarmotClient.prototype, 'joinGroupFromWelcome');
    try {
      await invitations.receive('malformed-wrap', {
        ...welcome,
        id: 'malformed',
        content: 'garbage',
      });
      // Even an accepted (approved) malformed Welcome is skipped, never joined.
      const malformed = JSON.parse(
        (await bob.backend.get('welcomeInvitations', 'malformed-wrap'))!,
      );
      await bob.backend.set(
        'welcomeInvitations',
        'malformed-wrap',
        JSON.stringify({ ...malformed, status: 'approved' }),
      );
      await invitations.receive('real-wrap', welcome);
      await invitations.resume(bob.session, () => true);
      expect(JSON.parse((await bob.backend.get('welcomeInvitations', 'malformed-wrap'))!)).toEqual({
        id: 'malformed-wrap',
        status: 'skipped',
      });
      expect((await invitations.list())[0].groupName).toBe('Family');
      expect(bob.session.listGroups()).toEqual([]);
      expect(await bob.backend.keys('pendingWelcomes')).toEqual([]);
      expect(join).not.toHaveBeenCalled();
      const joined = await invitations.accept('real-wrap', bob.session, () => true);
      expect(joined?.id).toBe(created.id);
      expect(join).toHaveBeenCalledTimes(1);
      await invitations.receive('real-wrap', welcome);
      await invitations.resume(bob.session, () => true);
      expect(join).toHaveBeenCalledTimes(1);
    } finally {
      join.mockRestore();
    }
  } finally {
    alice.session.stop();
    bob.session.stop();
  }
}, 60_000);

it('exposes only this install’s Welcome from a real multi-device invitation', async () => {
  const relay = makeRelay();
  const alice = makeSession(relay);
  const identity = makeSigner();
  const phone = makeInstall(relay, identity);
  const tablet = makeInstall(relay, identity);
  try {
    await Promise.all([alice, phone, tablet].map((p) => p.session.start()));
    await waitFor(
      () =>
        relay.events.filter((e) => e.kind === 30443 && e.pubkey === identity.pubkey).length === 2,
    );
    const created = await alice.session.createGroup('Family', [identity.pubkey]);
    const welcomes = unwrapWelcomes(relay, identity);
    expect(welcomes).toHaveLength(2);
    const notify = jest.fn();
    const invitations = new MarmotPendingInvitations(phone.backend, jest.fn(), notify);
    for (const [index, welcome] of welcomes.entries())
      await invitations.receive(`wrap-${index}`, welcome, true);
    expect(await invitations.list()).toEqual([]);
    await invitations.resume(phone.session, () => true);
    const rows = await invitations.list();
    expect(rows).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(rows[0].groupId).toBe(created.id.replace('marmot:', ''));
    expect(await invitations.accept(rows[0].id, phone.session, () => true)).toMatchObject({
      id: created.id,
    });
    expect(await invitations.list()).toEqual([]);
  } finally {
    for (const p of [alice, phone, tablet]) p.session.stop();
  }
}, 60_000);
