import { marmotReactionSource } from './marmotReactions';
import { setMarmotSession, type MarmotRumor, type MarmotSession } from './marmotSession';
import { MarmotGroupNotReadyError } from './marmotSendGate';
import { marmotSendError } from './marmotSend';
import { ReactionPublishError, type PendingReactionPublish } from '../utils/reactions';
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

  it('keeps a timed-out reaction pending, then confirms it once a relay holds it', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    const isStored = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    unacknowledged(session, { timedOut: true, isStored });
    setMarmotSession(session as unknown as MarmotSession);
    const outcome = await publishInGroup();
    expect(outcome).toEqual({ id: expect.any(String), confirmed: expect.any(Promise) });
    let confirmed: boolean | undefined;
    void (outcome as PendingReactionPublish).confirmed.then((c) => (confirmed = c));
    await jest.advanceTimersByTimeAsync(3_000);
    expect(confirmed).toBeUndefined();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(confirmed).toBe(true);
    expect(session.forgetRumor).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('gives up on a timed-out reaction no relay ever shows, and forgets it locally', async () => {
    jest.useFakeTimers();
    const session = fakeSession();
    unacknowledged(session, { timedOut: true, isStored: jest.fn().mockResolvedValue(false) });
    setMarmotSession(session as unknown as MarmotSession);
    const outcome = (await publishInGroup()) as PendingReactionPublish;
    const settled = outcome.confirmed;
    await jest.advanceTimersByTimeAsync(43_000);
    await expect(settled).resolves.toBe(false);
    expect(session.forgetRumor).toHaveBeenCalledWith('g-group', outcome.id);
    jest.useRealTimers();
  });

  it('fails at once (null) when every relay refused it, forgetting the local copy', async () => {
    const session = fakeSession();
    unacknowledged(session, { timedOut: false, isStored: jest.fn() });
    setMarmotSession(session as unknown as MarmotSession);
    await expect(publishInGroup()).resolves.toBeNull();
    expect(session.forgetRumor).toHaveBeenCalledWith('g-group', expect.any(String));
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
