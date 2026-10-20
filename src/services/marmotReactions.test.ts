import { marmotReactionSource } from './marmotReactions';
import { setMarmotSession, type MarmotRumor, type MarmotSession } from './marmotSession';
import { MarmotGroupNotReadyError } from './marmotSendGate';
import { marmotSendError } from './marmotSend';
import {
  ReactionPublishError,
  type PendingReactionPublish,
  type ReactionSettlement,
} from '../utils/reactions';
import type { MarmotSendReceipt } from './marmotSendReceipt';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const rumor = (id: string, kind: number, tags: string[][] = [], content = ''): MarmotRumor => ({
  id,
  pubkey: PEER,
  created_at: 1,
  kind,
  tags,
  content,
});

// Two DMs with the same peer: g-new (newest) and g-old (they reinstalled).
const history: Record<string, MarmotRumor[]> = {
  'g-new': [
    rumor('m-new', 9, [], 'hi again'),
    rumor('r-new', 7, [['e', 'm-new']], '👍'),
    rumor('r-unrelated', 7, [['e', 'm-other']], '😂'),
  ],
  'g-old': [rumor('m-old', 9, [], 'hi'), rumor('r-old', 7, [['e', 'm-old']], '🐷')],
};

function fakeSession() {
  const listeners: ((e: unknown) => void)[] = [];
  const session = {
    pubkey: ME,
    stop: jest.fn(),
    dmGroupIdsWith: jest.fn(async () => ['g-new', 'g-old']),
    queryHistory: jest.fn(async (id: string, kinds?: number[]) =>
      (history[id] ?? []).filter((r) => !kinds || kinds.includes(r.kind)),
    ),
    sendRumor: jest.fn(
      async (
        _groupId: string,
        _rumor: MarmotRumor,
        _opts?: { onSent?: (receipt: MarmotSendReceipt) => void },
      ): Promise<Record<string, boolean>> => ({ 'wss://r': true }),
    ),
    forgetRumor: jest.fn(async () => undefined),
    subscribe: jest.fn((l: { onMessage: (e: unknown) => void }) => {
      listeners.push(l.onMessage);
      return () => undefined;
    }),
    emit: (e: unknown) => listeners.forEach((l) => l(e)),
  };
  return session;
}

afterEach(() => setMarmotSession(null));

describe('marmotReactionSource', () => {
  it('reads reactions to the given messages across every DM with the peer, and only those', async () => {
    setMarmotSession(fakeSession() as unknown as MarmotSession);
    const source = marmotReactionSource(ME, PEER);
    const found = await source.fetchReactionsForMessages(['m-new', 'm-old']);
    expect(found.map((r) => r.id).sort()).toEqual(['r-new', 'r-old']);
  });

  it('sends a reaction into the group holding the message (an older DM included)', async () => {
    const session = fakeSession();
    setMarmotSession(session as unknown as MarmotSession);
    const id = await marmotReactionSource(ME, PEER).publishReaction({
      emoji: '🐷',
      targetEventId: 'm-old',
    });
    expect(id).toEqual(expect.any(String));
    const [groupId, sent] = session.sendRumor.mock.calls[0] as unknown as [string, MarmotRumor];
    expect(groupId).toBe('g-old');
    expect(sent).toMatchObject({ kind: 7, content: '🐷', tags: [['e', 'm-old']] });
  });

  it('sends a group reaction into that group, shaped the way White Noise reads it', async () => {
    const session = fakeSession();
    setMarmotSession(session as unknown as MarmotSession);
    await marmotReactionSource(ME, '', 'g-group').publishReaction({
      emoji: '❤️',
      targetEventId: 'm-wn',
    });
    const [groupId, sent] = session.sendRumor.mock.calls[0] as unknown as [string, MarmotRumor];
    expect(groupId).toBe('g-group');
    expect(sent).toMatchObject({ kind: 7, content: '❤️', tags: [['e', 'm-wn']], pubkey: ME });
  });

  it("fails a group reaction with the send's real reason, not a silent null", async () => {
    const session = fakeSession();
    session.sendRumor.mockRejectedValueOnce(new MarmotGroupNotReadyError());
    setMarmotSession(session as unknown as MarmotSession);
    const publish = marmotReactionSource(ME, '', 'g-group').publishReaction({
      emoji: '👍',
      targetEventId: 'm-wn',
    });
    await expect(publish).rejects.toBeInstanceOf(ReactionPublishError);
    await expect(publish).rejects.toThrow(marmotSendError(new MarmotGroupNotReadyError()));
  });

  // The relay answered after the publish window: reported not-accepted, yet stored (#1656).
  const unacknowledged = (session: ReturnType<typeof fakeSession>, receipt: MarmotSendReceipt) =>
    session.sendRumor.mockImplementationOnce(async (_g, _r, opts) => {
      opts?.onSent?.(receipt);
      return { 'wss://r': false };
    });
  const publishInGroup = () =>
    marmotReactionSource(ME, '', 'g-group').publishReaction({ emoji: '👍', targetEventId: 'm' });

  it('keeps a timed-out reaction pending, then settles it as sent once a relay holds it', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    const lookup = jest.fn().mockResolvedValueOnce('absent').mockResolvedValue('found');
    unacknowledged(session, { indeterminate: true, lookup });
    setMarmotSession(session as unknown as MarmotSession);
    const outcome = await publishInGroup();
    expect(outcome).toEqual({ id: expect.any(String), settled: expect.any(Promise) });
    let settled: ReactionSettlement | undefined;
    void (outcome as PendingReactionPublish).settled.then((value) => (settled = value));
    await jest.advanceTimersByTimeAsync(3_000);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe('sent');
    expect(session.forgetRumor).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('calls a timed-out reaction lost only once a completed lookup still misses it', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    unacknowledged(session, { indeterminate: true, lookup: jest.fn().mockResolvedValue('absent') });
    setMarmotSession(session as unknown as MarmotSession);
    const outcome = (await publishInGroup()) as PendingReactionPublish;
    const settled = outcome.settled;
    await jest.advanceTimersByTimeAsync(43_000);
    await expect(settled).resolves.toBe('lost');
    expect(session.forgetRumor).toHaveBeenCalledWith('g-group', outcome.id);
    jest.useRealTimers();
  });

  it('keeps a timed-out reaction when the lookups could not reach a relay', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    // Seen absent early (the late publish hadn't landed yet), then offline.
    const lookup = jest.fn().mockResolvedValueOnce('absent').mockResolvedValue('unknown');
    unacknowledged(session, { indeterminate: true, lookup });
    setMarmotSession(session as unknown as MarmotSession);
    const settled = ((await publishInGroup()) as PendingReactionPublish).settled;
    await jest.advanceTimersByTimeAsync(43_000);
    await expect(settled).resolves.toBe('unknown');
    expect(session.forgetRumor).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('settles at once as lost when every relay refused it, forgetting the local copy', async () => {
    const session = fakeSession();
    const lookup = jest.fn();
    unacknowledged(session, { indeterminate: false, lookup });
    setMarmotSession(session as unknown as MarmotSession);
    const outcome = (await publishInGroup()) as PendingReactionPublish;
    await expect(outcome.settled).resolves.toBe('lost');
    expect(lookup).not.toHaveBeenCalled();
    expect(session.forgetRumor).toHaveBeenCalledWith('g-group', outcome.id);
  });

  it('reports an inconclusive retraction as failed (retryable) and drops it locally', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    unacknowledged(session, {
      indeterminate: true,
      lookup: jest.fn().mockResolvedValue('unknown'),
    });
    setMarmotSession(session as unknown as MarmotSession);
    const deleted = marmotReactionSource(ME, '', 'g-group').deleteReaction('r');
    await jest.advanceTimersByTimeAsync(43_000);
    await expect(deleted).resolves.toBe(false);
    expect(session.forgetRumor).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("hides an unconfirmed retraction from a chat reopened while it's checked", async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    history['g-group'] = [];
    // marmot-ts saves the send into the history before publishing.
    session.sendRumor.mockImplementationOnce(async (groupId, rumor, opts) => {
      history[groupId].push(rumor);
      opts?.onSent?.({ indeterminate: true, lookup: jest.fn().mockResolvedValue('unknown') });
      return { 'wss://r': false };
    });
    setMarmotSession(session as unknown as MarmotSession);
    const deleted = marmotReactionSource(ME, '', 'g-group').deleteReaction('r-mine');
    await jest.advanceTimersByTimeAsync(0);
    const reopened = marmotReactionSource(ME, '', 'g-group');
    await expect(reopened.fetchReactionDeletions(['r-mine'])).resolves.toEqual([]);
    await jest.advanceTimersByTimeAsync(43_000);
    await expect(deleted).resolves.toBe(false);
    expect(session.forgetRumor).toHaveBeenCalled();
    delete history['g-group'];
    jest.useRealTimers();
  });

  it('tells a chat reopened mid-confirmation once a retraction is confirmed', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    unacknowledged(session, { indeterminate: true, lookup: jest.fn().mockResolvedValue('found') });
    setMarmotSession(session as unknown as MarmotSession);
    const deleted = marmotReactionSource(ME, '', 'g-group').deleteReaction('r-mine');
    // Reopened before it was confirmed: its history read skips the kind-5...
    const onEvent = jest.fn();
    const unsubscribe = marmotReactionSource(ME, '', 'g-group').subscribe(onEvent);
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(deleted).resolves.toBe(true);
    // ...so the confirmed retraction reaches it live instead.
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 5, tags: [['e', 'r-mine']] }),
    );
    unsubscribe();
    jest.useRealTimers();
  });

  it('gives each attempt its own id, so an older pending loss only touches itself', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-20T12:00:00.100Z') });
    const session = fakeSession();
    // First attempt: unacknowledged, and never found.
    unacknowledged(session, { indeterminate: true, lookup: jest.fn().mockResolvedValue('absent') });
    setMarmotSession(session as unknown as MarmotSession);
    const older = (await publishInGroup()) as PendingReactionPublish;
    // Same second, same emoji and target: acknowledged this time.
    jest.setSystemTime(new Date('2026-10-20T12:00:00.900Z'));
    const newer = await publishInGroup();
    expect(newer).toEqual(expect.any(String));
    expect(newer).not.toBe(older.id);
    // The older attempt's loss forgets only its own event.
    await jest.advanceTimersByTimeAsync(43_000);
    await expect(older.settled).resolves.toBe('lost');
    expect(session.forgetRumor).toHaveBeenCalledWith('g-group', older.id);
    expect(session.forgetRumor).not.toHaveBeenCalledWith('g-group', newer);
    jest.useRealTimers();
  });

  it.each([
    ['confirmed', 'found', 1],
    ['never confirmed', 'unknown', 0],
  ] as const)(
    'gates a retraction replayed by a replacement session until %s',
    async (_label, lookupResult, deliveries) => {
      jest.useFakeTimers();
      const first = fakeSession();
      let saved: MarmotRumor | undefined;
      first.sendRumor.mockImplementationOnce(async (_g, rumor, opts) => {
        saved = rumor;
        opts?.onSent?.({ indeterminate: true, lookup: jest.fn().mockResolvedValue(lookupResult) });
        return { 'wss://r': false };
      });
      setMarmotSession(first as unknown as MarmotSession);
      const onEvent = jest.fn();
      const unsubscribe = marmotReactionSource(ME, '', 'g-group').subscribe(onEvent);
      const deleted = marmotReactionSource(ME, '', 'g-group').deleteReaction('r-mine');
      await jest.advanceTimersByTimeAsync(0);
      // Account switched away and back: the new session replays its history.
      const second = fakeSession();
      setMarmotSession(second as unknown as MarmotSession);
      second.emit({ group: { id: 'g-group', isDm: false }, rumor: saved });
      expect(onEvent).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(43_000);
      await deleted;
      expect(onEvent).toHaveBeenCalledTimes(deliveries);
      unsubscribe();
      jest.useRealTimers();
    },
  );

  it('confirms a timed-out retraction instead of reporting it failed', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    unacknowledged(session, { indeterminate: true, lookup: jest.fn().mockResolvedValue('found') });
    setMarmotSession(session as unknown as MarmotSession);
    const deleted = marmotReactionSource(ME, '', 'g-group').deleteReaction('r');
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(deleted).resolves.toBe(true);
    jest.useRealTimers();
  });

  it('keeps live reactions flowing across a session restart', () => {
    const onEvent = jest.fn();
    const unsubscribe = marmotReactionSource(ME, PEER).subscribe(onEvent);
    // Thread opened before Marmot started: attaches once the session appears.
    const first = fakeSession();
    setMarmotSession(first as unknown as MarmotSession);
    const dm = { isDm: true, memberPubkeys: [PEER] };
    first.emit({ group: dm, rumor: rumor('r1', 7, [['e', 'm-new']], '👍') });
    const second = fakeSession();
    setMarmotSession(second as unknown as MarmotSession);
    second.emit({ group: dm, rumor: rumor('r2', 5, [['e', 'r1']]) });
    // Chat text and other people's chats are ignored.
    second.emit({ group: dm, rumor: rumor('m3', 9, [], 'hello') });
    second.emit({ group: { isDm: true, memberPubkeys: ['c'.repeat(64)] }, rumor: rumor('r3', 7) });
    expect(onEvent.mock.calls.map((c) => (c[0] as MarmotRumor).id)).toEqual(['r1', 'r2']);
    unsubscribe();
  });
});

it('scopes group history, sends kind 7 and kind 5 into that group, and filters the live stream', async () => {
  const session = fakeSession();
  setMarmotSession(session as unknown as MarmotSession);
  const source = marmotReactionSource(ME, PEER, 'g-old');
  expect((await source.fetchReactionsForMessages(['m-new', 'm-old'])).map((r) => r.id)).toEqual([
    'r-old',
  ]);
  await source.publishReaction({ emoji: '❤️', targetEventId: 'm-old' });
  await source.deleteReaction('r-old');
  expect(session.sendRumor.mock.calls).toEqual([
    [
      'g-old',
      expect.objectContaining({ kind: 7, content: '❤️', tags: [['e', 'm-old']] }),
      expect.anything(),
    ],
    [
      'g-old',
      expect.objectContaining({ kind: 5, content: '', tags: [['e', 'r-old']] }),
      expect.anything(),
    ],
  ]);
  const onEvent = jest.fn();
  const unsubscribe = source.subscribe(onEvent);
  session.emit({ group: { id: 'g-old', isDm: false }, rumor: rumor('r1', 7) });
  session.emit({ group: { id: 'g-new', isDm: false }, rumor: rumor('r2', 7) });
  expect(onEvent).toHaveBeenCalledTimes(1);
  unsubscribe();
});

it.each(['publish', 'delete'])(
  'sends %s directly to an explicit group without reading history',
  async (action) => {
    const session = fakeSession();
    session.queryHistory.mockRejectedValue(new Error('history must not be read'));
    setMarmotSession(session as unknown as MarmotSession);
    const source = marmotReactionSource(ME, PEER, 'g-old');
    const result =
      action === 'publish'
        ? await source.publishReaction({ emoji: '👍', targetEventId: 'm-old' })
        : await source.deleteReaction('r-old');
    expect(result).toBeTruthy();
    expect(session.queryHistory).not.toHaveBeenCalled();
    expect(session.dmGroupIdsWith).not.toHaveBeenCalled();
    expect(session.sendRumor).toHaveBeenCalledWith(
      'g-old',
      expect.objectContaining({ kind: action === 'publish' ? 7 : 5 }),
      expect.anything(),
    );
  },
);

it('retracts a reaction in its older DM group', async () => {
  const session = fakeSession();
  setMarmotSession(session as unknown as MarmotSession);
  expect(await marmotReactionSource(ME, PEER).deleteReaction('r-old')).toBe(true);
  expect(session.sendRumor).toHaveBeenCalledWith(
    'g-old',
    expect.objectContaining({ kind: 5, tags: [['e', 'r-old']] }),
    expect.anything(),
  );
});
