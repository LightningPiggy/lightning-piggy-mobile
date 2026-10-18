/**
 * Unit tests for the two blocking reaction bugs fixed in #205:
 *
 *  1. Removal-before-publish race — un-reacting before `publishReaction`
 *     resolves must retract the REAL kind-7 id (not the `local-react-*`
 *     placeholder, which is a no-op on relays and would resurface the
 *     reaction on next load).
 *  2. Received kind-5 deletions — a peer retracting their reaction must be
 *     reflected locally: the load path fetches kind-5s for the reactions it
 *     learned about and drops the corresponding pill.
 *
 * The hook takes every Nostr dependency as a prop, so no context/network
 * mocking is needed — we hand it jest.fn() fakes and drive the toggles.
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useConversationReactions } from './useConversationReactions';
import type { ConversationMessageInput, Item } from '../utils/conversationItems';
import { isOptimisticReactionId } from '../utils/reactions';
import { Toast } from '../components/BrandedToast';

import {
  cacheConversationReactions,
  clearConversationReactions,
  readConversationReactions,
  reactionCacheGeneration,
} from '../utils/conversationReactionCache';
import { useReactionBackend } from './useReactionBackend';
import { marmotReactionSource } from '../services/marmotReactions';
import { setMarmotSession, type MarmotSession } from '../services/marmotSession';
import { fetchReactions, fetchReactionDeletions } from '../services/nostrReactions';
import { pool } from '../services/nostrService';

jest.mock('../services/nostrService', () => ({
  pool: { ensureRelay: jest.fn() },
  trackRelays: jest.fn(),
}));
beforeEach(() => {
  clearConversationReactions();
  jest.clearAllMocks();
});
afterEach(() => setMarmotSession(null));

// NIP-17 threads read wrapped reactions from the DM store (#1321).
const mockReactionRows = jest.fn(async (_owner: string, _peer: string) => [] as unknown[]);
jest.mock('../services/dmDb', () => ({
  ...jest.requireActual('../services/dmDb'),
  getConversationReactionRows: (owner: string, peer: string) => mockReactionRows(owner, peer),
  subscribeDmStorage: () => () => {},
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void) =>
    jest.requireActual<typeof import('react')>('react').useEffect(effect, [effect]),
}));

jest.mock('../components/BrandedToast', () => ({
  Toast: { show: jest.fn() },
}));

jest.mock('../components/BrandedAlert', () => ({
  __esModule: true,
  Alert: { alert: jest.fn() },
}));

// The hook localizes its failure alert via `useTranslation()`; stub it with a
// passthrough so tests stay context-free (return the key, interpolating params).
jest.mock('../contexts/LocaleContext', () =>
  (() => {
    const context = {
      __esModule: true,
      useTranslation: () => (key: string) => key,
    };
    return {
      ...context,
      useLocale: () => ({ t: context.useTranslation(), locale: 'en', formatLocale: 'en' }),
    };
  })(),
);

const MY_PK = '0'.repeat(64);
const PEER_PK = 'b'.repeat(64);
const TARGET = '1'.repeat(64);

// A minimal sent-message Item carrying the reaction target id.
const sentItem = {
  kind: 'message',
  rumorId: TARGET,
  fromMe: true,
  wireKind: 14,
} as unknown as Item;

function makeParams(overrides: Partial<Parameters<typeof useConversationReactions>[0]> = {}) {
  return {
    messages: [] as ConversationMessageInput[],
    myPubkey: MY_PK,
    peerPubkey: PEER_PK,
    fetchReactionsForMessages: jest.fn().mockResolvedValue([]),
    publishReaction: jest.fn().mockResolvedValue('real-id'),
    deleteReaction: jest.fn().mockResolvedValue(true),
    fetchReactionDeletions: jest.fn().mockResolvedValue([]),
    onZapMessage: jest.fn(),
    ...overrides,
  };
}

describe('useConversationReactions — removal before publish resolves', () => {
  it('retracts the REAL kind-7 id (not the local placeholder) when un-reacted mid-publish', async () => {
    let resolvePublish!: (v: string | null) => void;
    const publishReaction = jest
      .fn()
      .mockImplementation(() => new Promise<string | null>((res) => (resolvePublish = res)));
    const deleteReaction = jest.fn().mockResolvedValue(true);

    const { result } = renderHook(() =>
      useConversationReactions(makeParams({ publishReaction, deleteReaction })),
    );

    // Tap to add — the optimistic pill appears while the publish is in flight.
    act(() => {
      result.current.buildOnToggleReaction(sentItem)!('👍', null);
    });
    await waitFor(() =>
      expect(result.current.reactionsByTarget.get(TARGET)?.myReactions['👍']).toBeDefined(),
    );
    const optimisticId = result.current.reactionsByTarget.get(TARGET)!.myReactions['👍'];
    expect(isOptimisticReactionId(optimisticId)).toBe(true);

    // Tap again to remove BEFORE the publish resolves. The pill disappears and
    // NO delete is issued yet (the real id isn't known — a delete of the
    // placeholder would be a no-op on relays).
    act(() => {
      result.current.buildOnToggleReaction(sentItem)!('👍', optimisticId);
    });
    expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined();
    expect(deleteReaction).not.toHaveBeenCalled();

    // The publish finally acks with the real id → the hook must retract THAT.
    await act(async () => {
      resolvePublish('real-id');
    });
    await waitFor(() => expect(deleteReaction).toHaveBeenCalledWith('real-id'));
    // And the placeholder was never (uselessly) deleted.
    expect(deleteReaction).not.toHaveBeenCalledWith(optimisticId);
    // Pill stays gone.
    expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined();
  });
});

describe('useConversationReactions — received kind-5 deletion', () => {
  it("drops a peer's pill when a matching kind-5 retraction is fetched on load", async () => {
    const messages: ConversationMessageInput[] = [
      { id: 'dm-1', fromMe: false, text: 'hi', createdAt: 100, rumorId: TARGET },
    ];
    const fetchReactionsForMessages = jest.fn().mockResolvedValue([
      {
        id: 'peer-r1',
        pubkey: PEER_PK,
        kind: 7,
        content: '❤️',
        created_at: 100,
        tags: [
          ['e', TARGET],
          ['p', MY_PK],
        ],
      },
    ]);
    const fetchReactionDeletions = jest
      .fn()
      .mockResolvedValue([
        { id: 'del1', pubkey: PEER_PK, created_at: 101, tags: [['e', 'peer-r1']] },
      ]);

    const { result } = renderHook(() =>
      useConversationReactions(
        makeParams({ messages, fetchReactionsForMessages, fetchReactionDeletions }),
      ),
    );

    // The deletion fetch is keyed on the reaction id we just learned about.
    await waitFor(() => expect(fetchReactionDeletions).toHaveBeenCalledWith(['peer-r1']));
    // After applying the retraction, the ❤️ pill is gone.
    await waitFor(() => expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined());
  });

  it("keeps the pill when a kind-5's author is not the reaction author (NIP-09)", async () => {
    const messages: ConversationMessageInput[] = [
      { id: 'dm-1', fromMe: false, text: 'hi', createdAt: 100, rumorId: TARGET },
    ];
    const fetchReactionsForMessages = jest.fn().mockResolvedValue([
      {
        id: 'peer-r1',
        pubkey: PEER_PK,
        kind: 7,
        content: '❤️',
        created_at: 100,
        tags: [
          ['e', TARGET],
          ['p', MY_PK],
        ],
      },
    ]);
    // A third party (not PEER_PK) tries to retract PEER_PK's reaction.
    const fetchReactionDeletions = jest
      .fn()
      .mockResolvedValue([
        { id: 'del1', pubkey: 'c'.repeat(64), created_at: 101, tags: [['e', 'peer-r1']] },
      ]);

    const { result } = renderHook(() =>
      useConversationReactions(
        makeParams({ messages, fetchReactionsForMessages, fetchReactionDeletions }),
      ),
    );

    await waitFor(() =>
      expect(result.current.reactionsByTarget.get(TARGET)?.byEmoji['❤️']).toEqual([PEER_PK]),
    );
    await waitFor(() => expect(fetchReactionDeletions).toHaveBeenCalled());
    // Pill survives — the forged deletion was ignored.
    expect(result.current.reactionsByTarget.get(TARGET)?.byEmoji['❤️']).toEqual([PEER_PK]);
  });
});

describe('useConversationReactions — copy text', () => {
  const press = (item: Item) => {
    const { result } = renderHook(() => useConversationReactions(makeParams()));
    act(() => result.current.buildOnLongPress(item)?.());
    return result.current.actionsForMessage;
  };

  it('offers plain chat text for copying', () => {
    const item = { ...sentItem, text: 'meet at the oak tree' } as unknown as Item;
    expect(press(item)?.copyText).toBe('meet at the oak tree');
  });

  it('never offers an encrypted file (its text embeds the key) or a structured payload', () => {
    const photo = {
      ...sentItem,
      wireKind: 15,
      text: 'https://blossom.example/abc#lpe=1&alg=aes-gcm&k=secret&n=nonce&m=image%2Fjpeg',
    } as unknown as Item;
    const legacyPhoto = { ...photo, wireKind: 14 } as unknown as Item;
    const poll = { ...sentItem, wireKind: 1068, text: '{"question":"?"}' } as unknown as Item;
    expect(press(photo)?.copyText).toBeUndefined();
    expect(press(legacyPhoto)?.copyText).toBeUndefined();
    expect(press(poll)?.copyText).toBeUndefined();
  });
});

describe('useConversationReactions — live (Marmot) reactions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const live = () => {
    let emit: (
      e: Parameters<
        Parameters<NonNullable<ReturnType<typeof makeParams>['subscribeLiveReactions']>>[0]
      >[0],
    ) => void = () => undefined;
    const subscribeLiveReactions = jest.fn((onEvent: typeof emit) => {
      emit = onEvent;
      return () => undefined;
    });
    return { subscribeLiveReactions, emit: (e: Parameters<typeof emit>[0]) => emit(e) };
  };
  const reaction = {
    id: 'r1',
    pubkey: PEER_PK,
    kind: 7,
    content: '🐷',
    created_at: 1,
    tags: [['e', TARGET]],
  };
  const retraction = {
    id: 'd1',
    pubkey: PEER_PK,
    kind: 5,
    content: '',
    created_at: 2,
    tags: [['e', 'r1']],
  };

  it('shows a reaction that arrives live', () => {
    const feed = live();
    const { result } = renderHook(() =>
      useConversationReactions(makeParams({ subscribeLiveReactions: feed.subscribeLiveReactions })),
    );
    act(() => feed.emit(reaction));
    expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined();
    act(() => jest.advanceTimersByTime(100));
    expect(result.current.reactionsByTarget.get(TARGET)).toBeDefined();
  });

  it('keeps a reaction hidden when its retraction arrived first', () => {
    const feed = live();
    const { result } = renderHook(() =>
      useConversationReactions(makeParams({ subscribeLiveReactions: feed.subscribeLiveReactions })),
    );
    act(() => feed.emit(retraction));
    act(() => feed.emit(reaction));
    act(() => jest.advanceTimersByTime(100));
    expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined();
  });

  it('ignores a retraction by someone other than the reactor', () => {
    const feed = live();
    const { result } = renderHook(() =>
      useConversationReactions(makeParams({ subscribeLiveReactions: feed.subscribeLiveReactions })),
    );
    act(() => feed.emit({ ...retraction, pubkey: MY_PK }));
    act(() => feed.emit(reaction));
    act(() => jest.advanceTimersByTime(100));
    expect(result.current.reactionsByTarget.get(TARGET)).toBeDefined();
  });
});

describe('useConversationReactions — duplicate own votes', () => {
  const event = (id: string, pubkey = MY_PK, content = '👍', target = TARGET) => ({
    id,
    pubkey,
    kind: 7,
    content,
    created_at: id === 'new' ? 2 : 1,
    tags: [['e', target]],
  });

  it.each([true, false])(
    'retracts all matching own IDs and reconciles failures (%s)',
    async (success) => {
      const own = [event('old'), event('new')];
      const other = [
        event('peer', PEER_PK),
        event('other-emoji', MY_PK, '❤️'),
        event('other-target', MY_PK, '👍', '2'.repeat(64)),
      ];
      const deleteReaction = jest.fn(async (id: string) => {
        if (id === 'old' || success) {
          return true;
        }
        return false;
      });
      // A reconciliation can still read stale successful deletions from history.
      const fetchReactionsForMessages = jest.fn(async () => [...own, ...other]);
      const params = makeParams({
        messages: [{ id: 'message', fromMe: true, text: 'hi', createdAt: 1, rumorId: TARGET }],
        fetchReactionsForMessages,
        deleteReaction,
      });
      const { result } = renderHook(() => useConversationReactions(params));
      await waitFor(() =>
        expect(result.current.reactionsByTarget.get(TARGET)?.myReactions['👍']).toBe('new'),
      );
      await act(async () => {
        result.current.buildOnToggleReaction(sentItem)!('👍', 'new');
      });
      expect(deleteReaction.mock.calls.map((c) => c[0]).sort()).toEqual(['new', 'old']);
      await waitFor(() =>
        expect(result.current.reactionsByTarget.get(TARGET)?.myReactions['👍']).toBe(
          success ? undefined : 'new',
        ),
      );
      expect(result.current.reactionsByTarget.get(TARGET)?.byEmoji['👍']).toContain(PEER_PK);
      expect(result.current.reactionsByTarget.get(TARGET)?.myReactions['❤️']).toBe('other-emoji');
      expect(result.current.reactionsByTarget.get('2'.repeat(64))?.myReactions['👍']).toBe(
        'other-target',
      );
    },
  );
});

describe('failed reaction deletions', () => {
  it.each([
    ['pill', false],
    ['sheet', false],
    ['pill', true],
    ['sheet', true],
  ])(
    'restores the failed deletion with no unhandled rejection (%s, throws: %s)',
    async (caller, throws) => {
      const events = ['old', 'new'].map((id, index) => ({
        id,
        pubkey: MY_PK,
        kind: 7,
        content: '👍',
        created_at: index + 1,
        tags: [['e', TARGET]],
      }));
      const fetchReactionsForMessages = jest
        .fn()
        .mockResolvedValueOnce(events)
        .mockRejectedValueOnce(new Error('relay read timed out'));
      const deleteReaction = jest.fn(async (id: string) => {
        if (id === 'old') return true;
        if (throws) throw new Error('relay publish failed');
        return false;
      });
      const params = makeParams({
        messages: [{ id: 'message', fromMe: true, text: 'hi', createdAt: 1, rumorId: TARGET }],
        fetchReactionsForMessages,
        deleteReaction,
      });
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { result } = renderHook(() => useConversationReactions(params));
        await waitFor(() =>
          expect(result.current.reactionsByTarget.get(TARGET)?.myReactions['👍']).toBe('new'),
        );
        if (caller === 'sheet') {
          act(() => result.current.buildOnLongPress(sentItem)!());
        }
        // Match both UI callers: deliberately discard the toggle promise.
        act(() => {
          if (caller === 'sheet') result.current.handleToggleReaction('👍', 'new');
          else result.current.buildOnToggleReaction(sentItem)!('👍', 'new');
        });
        expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined();
        await waitFor(() => expect(fetchReactionsForMessages).toHaveBeenCalledTimes(2));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(result.current.reactionsByTarget.get(TARGET)?.myReactions['👍']).toBe('new');
        expect(Toast.show).toHaveBeenCalledWith({
          type: 'error',
          text1: 'messageActionsSheet.reactionFailedTitle',
          text2: 'messageActionsSheet.reactionFailedBody',
        });
        expect(unhandled).not.toHaveBeenCalled();
        // Attempt both IDs even when one deletion fails.
        expect(deleteReaction.mock.calls.map(([id]) => id).sort()).toEqual(['new', 'old']);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    },
  );
});

it('restores a cancelled pending reaction when deleting its acknowledged ID rejects', async () => {
  let resolvePublish!: (id: string) => void;
  const publishReaction = jest.fn(
    () =>
      new Promise<string>((resolve) => {
        resolvePublish = resolve;
      }),
  );
  const deleteReaction = jest.fn().mockRejectedValue(new Error('relay publish failed'));
  const params = makeParams({ publishReaction, deleteReaction });
  const { result } = renderHook(() => useConversationReactions(params));
  act(() => result.current.buildOnToggleReaction(sentItem)!('👍', null));
  const optimisticId = result.current.reactionsByTarget.get(TARGET)!.myReactions['👍'];
  act(() => result.current.buildOnToggleReaction(sentItem)!('👍', optimisticId));
  expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined();
  await act(async () => {
    resolvePublish('real-id');
  });
  await waitFor(() =>
    expect(result.current.reactionsByTarget.get(TARGET)?.myReactions['👍']).toBe('real-id'),
  );
  expect(deleteReaction).toHaveBeenCalledWith('real-id');
  expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});

it('handles a rejected publish without leaving an optimistic reaction or rejecting the UI toggle', async () => {
  const params = makeParams({
    publishReaction: jest.fn().mockRejectedValue(new Error('signing failed')),
  });
  const { result } = renderHook(() => useConversationReactions(params));
  await act(async () => {
    result.current.buildOnToggleReaction(sentItem)!('👍', null);
  });
  expect(result.current.reactionsByTarget.get(TARGET)).toBeUndefined();
});

describe('cached reactions on initial message render', () => {
  it.each(['nip17', 'marmot', 'group'])(
    '%s reopens with reactions on its first commit',
    async (protocol) => {
      const event = {
        id: `cached-${protocol}`,
        pubkey: PEER_PK,
        kind: 7,
        content: '👍',
        created_at: 1,
        tags: [['e', TARGET]],
      };
      const queryHistory = jest.fn(async (_group: string, kinds: number[]) =>
        kinds.includes(7) ? [event] : [],
      );
      const dmGroupIdsWith = jest.fn(async () => ['dm-group']);
      setMarmotSession({
        pubkey: MY_PK,
        queryHistory,
        dmGroupIdsWith,
        subscribe: jest.fn(() => () => {}),
        stop: jest.fn(),
      } as unknown as MarmotSession);
      const subscribe = jest.fn((_filters, callbacks) => {
        queueMicrotask(() => {
          if (_filters[0].kinds.includes(7)) callbacks.onevent(event);
          callbacks.oneose();
        });
        return { close: jest.fn() };
      });
      (pool.ensureRelay as jest.Mock).mockResolvedValue({ subscribe });
      mockReactionRows.mockResolvedValue([
        {
          owner: MY_PK,
          eventId: 'wrap-cached',
          conversation: PEER_PK,
          createdAt: 1,
          sender: PEER_PK,
          content: JSON.stringify({ content: '👍', tags: [['e', TARGET]] }),
          fromMe: false,
          wireKind: 7,
          rumorId: event.id,
        },
      ]);
      const relay = {
        fetchReactionsForMessages: (ids: string[]) => fetchReactions(ids, ['wss://relay']),
        fetchReactionDeletions: (ids: string[]) => fetchReactionDeletions(ids, ['wss://relay']),
        publishReaction: jest.fn(),
        deleteReaction: jest.fn(),
      };
      const group = marmotReactionSource(MY_PK, PEER_PK, 'explicit-group');
      const sendRumor = jest.fn(async () => ({ success: true }));
      const params = makeParams({
        scopeKey: `first-frame:${protocol}`,
        messages: [{ id: TARGET, rumorId: TARGET, text: 'cached', createdAt: 1, fromMe: true }],
      });
      const useAdaptedReactions = () => {
        const backend = useReactionBackend(
          protocol === 'nip17' ? 'nip17' : 'marmot',
          MY_PK,
          PEER_PK,
          relay,
          sendRumor,
        );
        return useConversationReactions({
          ...params,
          ...(protocol === 'group'
            ? { ...group, subscribeLiveReactions: group.subscribe }
            : backend),
        });
      };
      const first = renderHook(useAdaptedReactions);
      await waitFor(() => expect(first.result.current.reactionsByTarget.get(TARGET)).toBeDefined());
      // Allow deletion reconciliation to settle before leaving the conversation.
      await waitFor(() => {
        // The live subscription's baseline, the reactions, then their
        // retractions: all from the store.
        if (protocol === 'nip17') expect(mockReactionRows).toHaveBeenCalledTimes(3);
        else
          expect(queryHistory).toHaveBeenCalledWith(
            protocol === 'group' ? 'explicit-group' : 'dm-group',
            [5],
          );
      });
      if (protocol === 'group') expect(dmGroupIdsWith).not.toHaveBeenCalled();
      else if (protocol === 'marmot') expect(dmGroupIdsWith).toHaveBeenCalledWith(PEER_PK);
      first.unmount();
      const commits: boolean[] = [];
      queryHistory.mockImplementation(() => new Promise(() => {}));
      mockReactionRows.mockImplementation(() => new Promise(() => {}));
      (pool.ensureRelay as jest.Mock).mockImplementation(() => new Promise(() => {}));
      const second = renderHook(() => {
        const value = useAdaptedReactions();
        commits.push(value.reactionsByTarget.has(TARGET));
        return value;
      });
      expect(commits[0]).toBe(true);
      expect(second.result.current.reactionsByTarget.get(TARGET)?.byEmoji['👍']).toEqual([PEER_PK]);
      second.unmount();
    },
  );
});

it('hides the previous scope during render and ignores a late fetch from it', async () => {
  let resolveOld!: (
    events: Awaited<ReturnType<ReturnType<typeof makeParams>['fetchReactionsForMessages']>>,
  ) => void;
  const old = makeParams({
    scopeKey: 'old-thread',
    messages: [{ id: TARGET, rumorId: TARGET, text: 'old', createdAt: 1, fromMe: true }],
    fetchReactionsForMessages: jest.fn(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    ),
  });
  const next = makeParams({ scopeKey: 'next-thread' });
  const { result, rerender, unmount } = renderHook(
    (params: Parameters<typeof useConversationReactions>[0]) => useConversationReactions(params),
    {
      initialProps: old,
    },
  );
  rerender(next);
  await act(async () =>
    resolveOld([
      { id: 'late', pubkey: PEER_PK, kind: 7, content: '👍', created_at: 1, tags: [['e', TARGET]] },
    ]),
  );
  expect(result.current.reactionsByTarget.size).toBe(0);
  unmount();
});

const cachedEvent = {
  id: 'cached-deleted',
  pubkey: PEER_PK,
  kind: 7,
  content: '👍',
  created_at: 1,
  tags: [['e', TARGET]],
};
const cachedMessages = [{ id: TARGET, rumorId: TARGET, text: 'hi', createdAt: 1, fromMe: true }];
function seedReaction(scopeKey: string) {
  cacheConversationReactions(
    `${MY_PK}:${scopeKey}`,
    {
      records: [
        {
          id: cachedEvent.id,
          reactorPubkey: PEER_PK,
          targetEventId: TARGET,
          emoji: '👍',
          createdAt: 1,
        },
        {
          id: 'unfetched',
          reactorPubkey: PEER_PK,
          targetEventId: 'other-target',
          emoji: '❤️',
          createdAt: 1,
        },
      ],
      retractions: new Map(),
    },
    reactionCacheGeneration(),
  );
}

it('queries cached IDs on an authoritative empty read and prunes only author-verified deletions', async () => {
  seedReaction('deleted-closed');
  const fetchReactionDeletions = jest
    .fn()
    .mockResolvedValue([
      { id: 'delete', pubkey: PEER_PK, created_at: 2, tags: [['e', cachedEvent.id]] },
    ]);
  const params = makeParams({
    scopeKey: 'deleted-closed',
    messages: cachedMessages,
    fetchReactionDeletions,
  });
  const { result } = renderHook(() => useConversationReactions(params));
  await waitFor(() => expect(fetchReactionDeletions).toHaveBeenCalledWith([cachedEvent.id]));
  await waitFor(() => expect(result.current.reactionsByTarget.has(TARGET)).toBe(false));
  expect(result.current.reactionsByTarget.has('other-target')).toBe(true);
});

it.each(['failure', 'timeout'])(
  'retains cached reactions when a fresh read ends in %s',
  async (reason) => {
    seedReaction(reason);
    const params = makeParams({
      scopeKey: reason,
      messages: cachedMessages,
      fetchReactionsForMessages: jest.fn().mockRejectedValue(new Error(reason)),
    });
    const { result } = renderHook(() => useConversationReactions(params));
    await act(async () => {});
    expect(result.current.reactionsByTarget.has(TARGET)).toBe(true);
    expect(params.fetchReactionDeletions).not.toHaveBeenCalled();
  },
);

it('rejects late deletion and publish writers after account caches are cleared', async () => {
  seedReaction('late-writers');
  let resolveDeletion!: (
    events: Awaited<
      ReturnType<Parameters<typeof useConversationReactions>[0]['fetchReactionDeletions']>
    >,
  ) => void;
  let resolvePublish!: (id: string) => void;
  const params = makeParams({
    scopeKey: 'late-writers',
    messages: cachedMessages,
    fetchReactionDeletions: jest.fn(
      () =>
        new Promise((resolve) => {
          resolveDeletion = resolve;
        }),
    ),
    publishReaction: jest.fn(
      () =>
        new Promise((resolve) => {
          resolvePublish = resolve;
        }),
    ),
  });
  const { result } = renderHook(() => useConversationReactions(params));
  await waitFor(() => expect(params.fetchReactionDeletions).toHaveBeenCalled());
  act(() => result.current.buildOnToggleReaction(sentItem)!('❤️', null));
  clearConversationReactions();
  await act(async () => {
    resolveDeletion([
      { id: 'delete', pubkey: PEER_PK, created_at: 2, tags: [['e', cachedEvent.id]] },
    ]);
    resolvePublish('late-publish');
  });
  expect(readConversationReactions(`${MY_PK}:late-writers`).records).toEqual([]);
  expect(readConversationReactions(`${MY_PK}:late-writers`).retractions.size).toBe(0);
});

it('does not prune a cached reaction when the deletion read fails', async () => {
  seedReaction('deletion-failure');
  const params = makeParams({
    scopeKey: 'deletion-failure',
    messages: cachedMessages,
    fetchReactionDeletions: jest.fn().mockRejectedValue(new Error('timed out')),
  });
  const { result } = renderHook(() => useConversationReactions(params));
  await act(async () => {});
  expect(params.fetchReactionDeletions).toHaveBeenCalledWith([cachedEvent.id]);
  expect(result.current.reactionsByTarget.has(TARGET)).toBe(true);
});

it('rejects a late history result after teardown even before the old screen unmounts', async () => {
  let resolveHistory!: (events: (typeof cachedEvent)[]) => void;
  const params = makeParams({
    scopeKey: 'late-history',
    messages: cachedMessages,
    fetchReactionsForMessages: jest.fn(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
    ),
  });
  const { result } = renderHook(() => useConversationReactions(params));
  clearConversationReactions();
  await act(async () => resolveHistory([cachedEvent]));
  expect(result.current.reactionsByTarget.size).toBe(0);
  expect(readConversationReactions(`${MY_PK}:late-history`).records).toEqual([]);
});
