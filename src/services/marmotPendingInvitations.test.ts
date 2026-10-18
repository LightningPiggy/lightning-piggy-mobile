import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { MarmotPendingInvitations } from './marmotPendingInvitations';
import type { MarmotRumor } from './marmotSession';
import { createMemoryMarmotBackend } from './marmotStore';
jest.mock('./localDb', () => ({ getLocalDb: jest.fn() }));
jest.mock('@internet-privacy/marmot-ts', () => ({
  getWelcome: (r: MarmotRumor) => {
    if (r.content === 'malformed') throw new Error('Failed to decode welcome message');
    return { secrets: [] };
  },
}));
jest.mock('../contexts/nostrDecryptPacing', () => ({
  createYieldScheduler: jest.fn(() => ({
    maybeYield: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn(),
  })),
}));

const rumor: MarmotRumor = {
  id: 'rumor',
  pubkey: 'b'.repeat(64),
  kind: 444,
  content: 'secret welcome',
  tags: [],
  created_at: 1,
};
const group = {
  id: 'group',
  name: 'Family',
  memberPubkeys: [],
  adminPubkeys: [],
  createdAt: 1,
  isDm: false,
};
function setup() {
  const backend = createMemoryMarmotBackend();
  const changed = jest.fn();
  const invitations = new MarmotPendingInvitations(backend, changed);
  const session = {
    getGroup: jest.fn().mockReturnValue(undefined),
    acceptWelcome: jest.fn().mockResolvedValue(group),
    previewWelcome: jest
      .fn()
      .mockResolvedValue({ forThisDevice: true, groupId: 'mls-group', group: { name: 'Family' } }),
  };
  return { backend, invitations, session };
}

it('persists a stranger as pending across restart and previews without joining or consuming a key', async () => {
  const { backend, invitations, session } = setup();
  expect(await invitations.receive('wrap', rumor)).toBe(true);
  await invitations.resume(session, () => true);
  expect(session.acceptWelcome).not.toHaveBeenCalled();
  expect(await new MarmotPendingInvitations(backend, jest.fn()).list()).toEqual([
    expect.objectContaining({ id: 'wrap', rumor, groupName: 'Family', status: 'pending' }),
  ]);
  // Hydrated contacts or a later permissive backfill cannot grant consent.
  await invitations.receive('wrap', rumor);
  await invitations.resume(session, () => true);
  expect(session.acceptWelcome).not.toHaveBeenCalled();
});
it('waits for consent even from someone the user follows (as White Noise does)', async () => {
  const { invitations, session } = setup();
  expect(await invitations.receive('wrap', rumor)).toBe(true);
  await invitations.resume(session, () => true);
  expect(session.acceptWelcome).not.toHaveBeenCalled();
  expect(await invitations.list()).toEqual([
    expect.objectContaining({ id: 'wrap', status: 'pending' }),
  ]);
});
it('explicit acceptance joins and returns the group to open', async () => {
  const { invitations, session } = setup();
  await invitations.receive('wrap', rumor);
  expect(await invitations.accept('wrap', session, () => true)).toEqual(group);
  expect(session.acceptWelcome).toHaveBeenCalledTimes(1);
  expect(await invitations.list()).toEqual([]);
});
it('decline discards plaintext and dedupes even after a restart', async () => {
  const { backend, invitations, session } = setup();
  await invitations.receive('wrap', rumor);
  await invitations.decline('wrap');
  expect(await backend.get('welcomeInvitations', 'wrap')).toBe(
    JSON.stringify({ id: 'wrap', status: 'declined' }),
  );
  const restarted = new MarmotPendingInvitations(backend, jest.fn());
  expect(await restarted.receive('wrap', rumor)).toBe(false);
  await restarted.resume(session, () => true);
  expect(await restarted.list()).toEqual([]);
  expect(session.acceptWelcome).not.toHaveBeenCalled();
});
it('concurrent live/backfill delivery of one wrap processes it exactly once', async () => {
  const { invitations, session } = setup();
  const delivered = await Promise.all([
    invitations.receive('wrap', rumor),
    invitations.receive('wrap', rumor),
  ]);
  expect(delivered.filter(Boolean)).toHaveLength(1);
  await Promise.all([
    invitations.resume(session, () => true),
    invitations.resume(session, () => true),
  ]);
  expect(await invitations.list()).toHaveLength(1);
  await invitations.accept('wrap', session, () => true);
  expect(session.acceptWelcome).toHaveBeenCalledTimes(1);
});
it('durable acceptance retries after restart but never retries unapproved invitations', async () => {
  const { backend, invitations, session } = setup();
  session.acceptWelcome.mockResolvedValueOnce(null);
  await invitations.receive('approved', rumor);
  await invitations.receive('stranger', { ...rumor, id: 'other-rumor' });
  session.previewWelcome.mockImplementation(async (r) => ({
    forThisDevice: true,
    groupId: r.id,
    group: { name: 'Family' },
  }));
  await invitations.accept('approved', session, () => true);
  const restarted = new MarmotPendingInvitations(backend, jest.fn());
  await restarted.resume(session, () => true);
  expect(session.acceptWelcome).toHaveBeenCalledTimes(2);
  expect((await restarted.list()).map((i) => i.id)).toEqual(['stranger']);
});
it('does not accept into a different account session', async () => {
  const { invitations, session } = setup();
  await invitations.receive('wrap', rumor);
  expect(await invitations.accept('wrap', session, () => false)).toBeNull();
  expect(session.acceptWelcome).not.toHaveBeenCalled();
  expect(await invitations.list()).toHaveLength(0); // Unvalidated cold-start records stay hidden.
});

it('does not re-prompt a declined Welcome rewrapped under a different outer id', async () => {
  const { backend, invitations, session } = setup();
  await invitations.receive('first-wrap', rumor);
  await invitations.decline('first-wrap');
  const restarted = new MarmotPendingInvitations(backend, jest.fn());
  expect(await restarted.receive('new-wrap', rumor)).toBe(false);
  await restarted.resume(session, () => true);
  expect(await restarted.list()).toEqual([]);
  expect(session.acceptWelcome).not.toHaveBeenCalled();
});

it('suppresses distinct late Welcomes for a declined group after restart', async () => {
  const { backend, invitations, session } = setup();
  await invitations.receive('first-wrap', rumor, true);
  await invitations.resume(session, () => true);
  // This candidate arrives before decline but has not been previewed yet.
  await invitations.receive('unpreviewed-wrap', { ...rumor, id: 'unpreviewed' });
  await invitations.decline('first-wrap');
  const notify = jest.fn();
  const restarted = new MarmotPendingInvitations(backend, jest.fn(), notify);
  const late = { ...rumor, id: 'distinct-late-welcome', created_at: 2 };
  await backend.set('pendingWelcomes', late.id, JSON.stringify(late));
  await restarted.receive('late-wrap', late, true);
  await restarted.resume(session, () => true);
  expect(await restarted.list()).toEqual([]);
  expect(JSON.parse((await backend.get('welcomeInvitations', 'first-wrap'))!)).toEqual({
    id: 'first-wrap',
    status: 'declined',
    groupId: 'mls-group',
  });
  expect(notify).not.toHaveBeenCalled();
  expect(session.acceptWelcome).not.toHaveBeenCalled();
  expect(await backend.get('pendingWelcomes', late.id)).toBeNull();
  expect(await restarted.receive('rewrapped-late', late, true)).toBe(false);
  // Decline is specific to the group, not to the inviter.
  session.previewWelcome.mockResolvedValueOnce({
    forThisDevice: true,
    groupId: 'another-group',
    group: { name: 'Another family' },
  });
  await restarted.receive('another-wrap', { ...rumor, id: 'another' }, true);
  await restarted.resume(session, () => true);
  expect(await restarted.list()).toEqual([expect.objectContaining({ groupId: 'another-group' })]);
  expect(notify).toHaveBeenCalledTimes(1);
});

it('silently skips other-device Welcomes without exposing or notifying a row', async () => {
  const { backend, session } = setup();
  const notify = jest.fn();
  const invitations = new MarmotPendingInvitations(backend, jest.fn(), notify);
  session.previewWelcome.mockResolvedValueOnce({
    forThisDevice: false,
    groupId: undefined,
    group: null,
  });
  await invitations.receive('other-device', rumor, true);
  expect(await invitations.list()).toEqual([]);
  await invitations.resume(session, () => true);
  expect(await invitations.list()).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
  expect(session.acceptWelcome).not.toHaveBeenCalled();
});

it('shows one row per MLS group, accepts the newest Welcome, and clears every candidate', async () => {
  const { backend, invitations, session } = setup();
  await invitations.receive('older', rumor);
  const newer = { ...rumor, id: 'newer-rumor', created_at: 2 };
  await invitations.receive('newer', newer);
  await invitations.resume(session, () => true);
  expect(await invitations.list()).toEqual([
    expect.objectContaining({ id: 'newer', groupId: 'mls-group' }),
  ]);
  expect(await invitations.accept('older', session, () => true)).toEqual(group);
  expect(session.acceptWelcome).toHaveBeenCalledWith(newer);
  expect(await invitations.list()).toEqual([]);
  for (const id of ['older', 'newer'])
    expect(JSON.parse((await backend.get('welcomeInvitations', id))!)).toEqual({
      id,
      status: 'joined',
    });
});

it('falls back to the older Welcome after a permanent failure', async () => {
  const { backend, invitations, session } = setup();
  const newer = { ...rumor, id: 'newer-rumor', created_at: 2 };
  await invitations.receive('older', rumor);
  await invitations.receive('newer', newer);
  session.acceptWelcome.mockImplementationOnce(async () => {
    await backend.set('welcomes', newer.id, JSON.stringify({ result: 'failed' }));
    return null;
  });
  await invitations.resume(session, () => true);
  expect(await invitations.accept('newer', session, () => true)).toEqual(group);
  expect(session.acceptWelcome.mock.calls.map(([r]) => r.id)).toEqual([newer.id, rumor.id]);
  expect(await invitations.list()).toEqual([]);
});

it('exposes a dismissible error after all candidates fail permanently', async () => {
  const { backend, invitations, session } = setup();
  await invitations.receive('wrap', rumor);
  session.acceptWelcome.mockImplementation(async () => {
    await backend.set('welcomes', rumor.id, JSON.stringify({ result: 'failed' }));
    return null;
  });
  await invitations.resume(session, () => true);
  await invitations.accept('wrap', session, () => true);
  expect(await invitations.list()).toEqual([
    expect.objectContaining({ error: true, status: 'pending' }),
  ]);
  await invitations.accept('wrap', session, () => true);
  expect(session.acceptWelcome).toHaveBeenCalledTimes(1);
  await invitations.decline('wrap');
  expect(await invitations.list()).toEqual([]);
});

it('tombstones a malformed preview and still validates and accepts later invitations after restart', async () => {
  const { backend, invitations, session } = setup();
  const malformed = { ...rumor, id: 'malformed-rumor', content: 'malformed' };
  await invitations.receive('bad-wrap', malformed);
  await invitations.receive('valid-wrap', rumor);
  session.previewWelcome.mockImplementation(async (r) => {
    if (r.id === malformed.id) throw new Error('Failed to decode welcome message');
    return { forThisDevice: true, groupId: 'mls-group', group: { name: 'Family' } };
  });
  await invitations.resume(session, () => true);
  expect(JSON.parse((await backend.get('welcomeInvitations', 'bad-wrap'))!)).toEqual({
    id: 'bad-wrap',
    status: 'skipped',
  });
  expect(await invitations.list()).toEqual([expect.objectContaining({ id: 'valid-wrap' })]);
  const restarted = new MarmotPendingInvitations(backend, jest.fn());
  session.previewWelcome.mockClear();
  expect(await restarted.receive('rewrapped-bad', malformed)).toBe(false);
  expect(await restarted.accept('valid-wrap', session, () => true)).toEqual(group);
  expect(session.previewWelcome).not.toHaveBeenCalledWith(malformed);
  expect(session.acceptWelcome).toHaveBeenCalledWith(rumor);
});

/** The state an Accept leaves behind before the join finishes (durable, so a
 * restart retries it). Invitations no longer start approved. */
async function approve(
  backend: {
    get(ns: string, k: string): Promise<string | null>;
    set(ns: string, k: string, v: string): Promise<void>;
  },
  id: string,
) {
  const record = JSON.parse((await backend.get('welcomeInvitations', id))!);
  await backend.set('welcomeInvitations', id, JSON.stringify({ ...record, status: 'approved' }));
}

it('retains a transient preview failure without starving later invitations, then retries after restart', async () => {
  const { backend, invitations, session } = setup();
  const retryable = { ...rumor, id: 'retryable' };
  await invitations.receive('retry-wrap', retryable);
  await approve(backend, 'retry-wrap');
  await invitations.receive('valid-wrap', rumor);
  let unavailable = true;
  session.previewWelcome.mockImplementation(async (r) => {
    if (r.id === retryable.id && unavailable) throw new Error('key store unavailable');
    return { forThisDevice: true, groupId: r.id, group: { name: 'Family' } };
  });
  await invitations.resume(session, () => true);
  expect(JSON.parse((await backend.get('welcomeInvitations', 'retry-wrap'))!)).toMatchObject({
    status: 'approved',
    rumor: retryable,
  });
  expect(session.acceptWelcome).not.toHaveBeenCalled();
  expect(await invitations.accept('valid-wrap', session, () => true)).toEqual(group);
  unavailable = false;
  const restarted = new MarmotPendingInvitations(backend, jest.fn());
  await restarted.resume(session, () => true);
  expect(session.acceptWelcome).toHaveBeenCalledWith(retryable);
});

it.each(['preview', 'join'] as const)(
  'persists and deduplicates new deliveries while %s is blocked',
  async (stage) => {
    const { backend, invitations, session } = setup();
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    if (stage === 'preview')
      session.previewWelcome.mockImplementationOnce(async () => {
        entered();
        await blocked;
        return { forThisDevice: true, groupId: 'mls-group', group: { name: 'Family' } };
      });
    else
      session.acceptWelcome.mockImplementationOnce(async () => {
        entered();
        await blocked;
        return group;
      });
    await invitations.receive('first-wrap', rumor);
    await approve(backend, 'first-wrap');
    const processing = invitations.resume(session, () => true);
    await started;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const incoming = { ...rumor, id: 'next-rumor' };
      const persisted = Promise.all([
        invitations.receive('next-wrap', incoming),
        invitations.receive('duplicate-wrap', incoming),
      ]);
      expect(
        await Promise.race([
          persisted,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('ingestion blocked by MLS')), 1000);
          }),
        ]),
      ).toEqual([true, false]);
      expect(JSON.parse((await backend.get('welcomeInvitations', 'next-wrap'))!)).toMatchObject({
        status: 'pending',
        rumor: incoming,
      });
    } finally {
      clearTimeout(timeout);
      unblock();
      await processing;
    }
  },
);

it('paces every preview and reads records linearly while notifying once per group', async () => {
  const { backend, session } = setup();
  const notify = jest.fn();
  const invitations = new MarmotPendingInvitations(backend, jest.fn(), notify);
  for (let i = 0; i < 24; i++)
    await invitations.receive(`wrap-${i}`, { ...rumor, id: `rumor-${i}` }, true);
  const get = jest.spyOn(backend, 'get');
  const keys = jest.spyOn(backend, 'keys');
  const scheduler = jest.mocked(createYieldScheduler);
  scheduler.mockClear();
  await invitations.resume(session, () => true);
  expect(keys.mock.calls.filter(([ns]) => ns === 'welcomeInvitations')).toHaveLength(2);
  expect(get.mock.calls.filter(([ns]) => ns === 'welcomeInvitations')).toHaveLength(48);
  const pacing = scheduler.mock.results[0].value;
  expect(pacing.maybeYield).toHaveBeenCalledTimes(24);
  expect(pacing.dispose).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledTimes(1);
  const yields = pacing.maybeYield.mock.invocationCallOrder;
  const previews = session.previewWelcome.mock.invocationCallOrder;
  for (let i = 0; i < previews.length; i++) {
    expect(yields[i]).toBeLessThan(previews[i]);
    if (i > 0) expect(yields[i]).toBeGreaterThan(previews[i - 1]);
  }
});

it('paces between join fallback attempts and disposes after success', async () => {
  const { backend, invitations, session } = setup();
  const newer = { ...rumor, id: 'newer', created_at: 2 };
  await invitations.receive('older', rumor);
  await invitations.receive('newer', newer);
  session.acceptWelcome.mockImplementationOnce(async () => {
    await backend.set('welcomes', newer.id, JSON.stringify({ result: 'failed' }));
    return null;
  });
  const scheduler = jest.mocked(createYieldScheduler);
  scheduler.mockClear();
  expect(await invitations.accept('newer', session, () => true)).toEqual(group);
  const pacing = scheduler.mock.results[0].value;
  expect(pacing.maybeYield).toHaveBeenCalledTimes(4);
  expect(pacing.maybeYield.mock.invocationCallOrder[3]).toBeGreaterThan(
    session.acceptWelcome.mock.invocationCallOrder[0],
  );
  expect(pacing.maybeYield.mock.invocationCallOrder[3]).toBeLessThan(
    session.acceptWelcome.mock.invocationCallOrder[1],
  );
  expect(pacing.dispose).toHaveBeenCalledTimes(1);
});

it.each([10, 20, 40])(
  'joins %i distinct accepted groups with linear invitation reads, including retained tombstones',
  async (count) => {
    const { backend, invitations, session } = setup();
    const tombstones = 100;
    for (let i = 0; i < tombstones; i++)
      await backend.set(
        'welcomeInvitations',
        `old-${i}`,
        JSON.stringify({ id: `old-${i}`, status: 'declined' }),
      );
    for (let i = 0; i < count; i++) {
      await invitations.receive(`wrap-${i}`, { ...rumor, id: `rumor-${i}` });
      await approve(backend, `wrap-${i}`);
    }
    session.previewWelcome.mockImplementation(async (r) => ({
      forThisDevice: true,
      groupId: r.id,
      group: { name: 'Family' },
    }));
    const get = jest.spyOn(backend, 'get');
    const keys = jest.spyOn(backend, 'keys');
    await invitations.resume(session, () => true);
    expect(session.acceptWelcome).toHaveBeenCalledTimes(count);
    expect(keys.mock.calls.filter(([ns]) => ns === 'welcomeInvitations')).toHaveLength(2);
    expect(get.mock.calls.filter(([ns]) => ns === 'welcomeInvitations')).toHaveLength(
      2 * (count + tombstones),
    );
    // Every group is cleaned and plaintext removed, without rescanning history.
    for (let i = 0; i < count; i++) {
      expect(JSON.parse((await backend.get('welcomeInvitations', `wrap-${i}`))!)).toEqual({
        id: `wrap-${i}`,
        status: 'joined',
      });
      expect(await backend.get('pendingWelcomes', `rumor-${i}`)).toBeNull();
    }
    expect(await invitations.list()).toEqual([]);
  },
);

it.each(['failed-wrap', 'late-older-wrap'])(
  'exposes an older usable Welcome after permanent failure and accepts %s',
  async (acceptId) => {
    const { backend, invitations, session } = setup();
    const failed = { ...rumor, id: 'failed-newer', created_at: 2 };
    await invitations.receive('failed-wrap', failed);
    session.acceptWelcome.mockImplementationOnce(async () => {
      await backend.set('welcomes', failed.id, JSON.stringify({ result: 'failed' }));
      return null;
    });
    await invitations.accept('failed-wrap', session, () => true);
    expect(await invitations.list()).toEqual([
      expect.objectContaining({ id: 'failed-wrap', error: true }),
    ]);
    const restarted = new MarmotPendingInvitations(backend, jest.fn());
    await restarted.receive('late-older-wrap', rumor);
    await restarted.resume(session, () => true);
    const rows = await restarted.list();
    expect(rows).toEqual([
      expect.objectContaining({ id: 'late-older-wrap', groupId: 'mls-group' }),
    ]);
    expect(rows[0].error).toBeUndefined();
    // A tap captured before the snapshot refresh can still refer to the failed row.
    expect(await restarted.accept(acceptId, session, () => true)).toEqual(group);
    expect(session.acceptWelcome.mock.calls.map(([r]) => r.id)).toEqual([failed.id, rumor.id]);
    expect(await restarted.list()).toEqual([]);
  },
);

it('tombstones a distinct delayed Welcome after joining and restart', async () => {
  const { backend, invitations, session } = setup();
  await invitations.receive('first-wrap', rumor);
  expect(await invitations.accept('first-wrap', session, () => true)).toEqual(group);
  session.getGroup.mockImplementation((id) => (id === 'marmot:mls-group' ? group : undefined));
  session.acceptWelcome.mockClear();
  const notify = jest.fn();
  const restarted = new MarmotPendingInvitations(backend, jest.fn(), notify);
  const late = { ...rumor, id: 'late-distinct', created_at: 2 };
  await backend.set('pendingWelcomes', late.id, JSON.stringify(late));
  await restarted.receive('late-wrap', late, true);
  await restarted.resume(session, () => true);
  expect(await restarted.list()).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
  expect(session.acceptWelcome).not.toHaveBeenCalled();
  expect(session.getGroup).toHaveBeenCalledWith('marmot:mls-group');
  expect(JSON.parse((await backend.get('welcomeInvitations', 'late-wrap'))!)).toEqual({
    id: 'late-wrap',
    status: 'joined',
  });
  expect(await backend.get('pendingWelcomes', late.id)).toBeNull();
  expect(await restarted.receive('rewrapped-late', late, true)).toBe(false);
  await restarted.resume(session, () => true);
  expect(await restarted.list()).toEqual([]);
});
