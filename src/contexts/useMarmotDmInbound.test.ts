import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mayNotifyFrom, useMarmotDmInbound } from './useMarmotDmInbound';
import { __resetRepliedPartnersForTests } from '../services/dmRepliedPartners';
import {
  __resetNotificationAudiences,
  publishNotificationAudience,
} from '../services/notificationAudience';
import {
  applyMarmotEdits,
  deleteMarmotMessages,
  getConversationMessages,
  upsertDmMessages,
  type DmMessageRow,
} from '../services/dmDb';
import { getLocalDb } from '../services/localDb';
import {
  fireMessageNotification,
  retractMarmotMessageNotifications,
} from '../services/notificationService';
import { rowsToInboxEntries } from '../services/dmInbox';
import type { MarmotMessageEvent } from '../services/marmotSession';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { notifyDmMessage } from './nostrEventBus';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
let mockOnMessage: (event: MarmotMessageEvent) => void;
jest.mock('../services/marmotSession', () => ({
  MARMOT_CHAT_KIND: 9,
  subscribeMarmotSession: (cb: (session: unknown) => void) => {
    cb({
      pubkey: 'alice',
      subscribe: (handlers: { onMessage: typeof mockOnMessage }) => {
        mockOnMessage = handlers.onMessage;
        return () => {};
      },
    });
    return () => {};
  },
}));
jest.mock('../services/dmDb', () => ({
  applyMarmotEdits: jest.fn().mockResolvedValue([]),
  deleteMarmotMessages: jest.fn().mockResolvedValue([]),
  deleteMarmotRowsOfKinds: jest.fn().mockResolvedValue(undefined),
  getConversationMessages: jest.fn(),
  upsertDmMessages: jest.fn().mockResolvedValue(undefined),
  selectRepliedConversations: jest.fn(async () => mockReplied),
  subscribeDmStorage: jest.fn(() => () => {}),
  REPLY_WIRE_KINDS: [14, 15],
}));
let mockReplied: string[] = [];
jest.mock('../services/notificationService', () => ({
  retractMarmotMessageNotifications: jest.fn().mockResolvedValue(0),
  fireMessageNotification: jest.fn(),
}));
// Real tombstone store (SQL) on Node's SQLite; dm_messages itself is mocked above.
jest.mock('@op-engineering/op-sqlite', () =>
  require('../services/testUtils/nodeSqliteOpSqlite').nodeSqliteOpSqlite(),
);
jest.mock('../services/localDbKey', () => ({
  getOrCreateLocalDbKey: jest.fn(() => Promise.resolve('k')),
  clearLocalDbKey: jest.fn(() => Promise.resolve()),
}));
jest.mock('./nostrEventBus', () => ({ notifyDmMessage: jest.fn() }));
const id = 'a'.repeat(64);
const latest: DmMessageRow = {
  owner: 'alice',
  eventId: id,
  conversation: 'bob',
  sender: 'alice',
  content: 'latest',
  fromMe: true,
  wireKind: 14,
  createdAt: 2,
  protocol: 'marmot',
};
const deletion = {
  group: {
    id: 'g',
    name: 'Group',
    description: '',
    relays: [],
    createdAt: 1,
    isDm: true,
    memberPubkeys: ['bob'],
    adminPubkeys: [],
  },
  rumor: { id: 'delete', kind: 5, pubkey: 'bob', tags: [['e', id]], content: '', created_at: 3 },
} as MarmotMessageEvent;
beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await (await getLocalDb()).execute('DELETE FROM marmot_deletions;');
});
afterEach(() => jest.useRealTimers());

it('leaves the inbox alone when a delete removed nothing (unauthorized, or a replay)', async () => {
  (getConversationMessages as jest.Mock).mockResolvedValue([latest]);
  const unrelated = { ...rowsToInboxEntries([latest])[0], partnerPubkey: 'carol' };
  let inbox = [...rowsToInboxEntries([latest]), unrelated];
  const before = inbox;
  const setter = (update: React.SetStateAction<DmInboxEntry[]>) => {
    inbox = typeof update === 'function' ? update(inbox) : update;
  };
  renderHook(() => useMarmotDmInbound('alice', setter));
  await act(async () => {
    mockOnMessage(deletion);
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(deleteMarmotMessages).toHaveBeenCalledWith('alice', 'bob', [id], 'bob');
  // Perf: no follow-up read, no state update, no thread reload.
  expect(getConversationMessages).not.toHaveBeenCalled();
  expect(inbox).toBe(before);
  expect(notifyDmMessage).not.toHaveBeenCalled();
});

it('uses actual deleted IDs and reconciles the newest remaining row', async () => {
  (deleteMarmotMessages as jest.Mock).mockResolvedValueOnce([id]);
  (getConversationMessages as jest.Mock).mockResolvedValue([
    { ...latest, eventId: 'old', content: 'fallback', createdAt: 1 },
  ]);
  let inbox = rowsToInboxEntries([latest]);
  renderHook(() =>
    useMarmotDmInbound('alice', (update) => {
      inbox = typeof update === 'function' ? update(inbox) : update;
    }),
  );
  await act(async () => {
    mockOnMessage(deletion);
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(inbox.map((e) => e.text)).toEqual(['fallback']);
});

it('does not publish old-account previews after cleanup while deletion is awaiting storage', async () => {
  (deleteMarmotMessages as jest.Mock).mockResolvedValueOnce([id]);
  let release!: (rows: DmMessageRow[]) => void;
  (getConversationMessages as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const setter = jest.fn();
  const { unmount } = renderHook(() => useMarmotDmInbound('alice', setter));
  await act(async () => {
    mockOnMessage(deletion);
    await jest.advanceTimersByTimeAsync(150);
  });
  unmount();
  await act(async () => {
    release([latest]);
    await Promise.resolve();
  });
  expect(setter).not.toHaveBeenCalled();
  expect(notifyDmMessage).not.toHaveBeenCalled();
});

const chat = (msgId: string, sender: string, created_at = 3) =>
  ({
    ...deletion,
    rumor: { id: msgId, kind: 9, pubkey: sender, tags: [], content: 'hi', created_at },
  }) as MarmotMessageEvent;

it('still applies removals when the batch upsert fails', async () => {
  (upsertDmMessages as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  renderHook(() => useMarmotDmInbound('alice', jest.fn()));
  await act(async () => {
    mockOnMessage(chat('b'.repeat(64), 'bob'));
    mockOnMessage(deletion);
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(upsertDmMessages).toHaveBeenCalled();
  expect(deleteMarmotMessages).toHaveBeenCalledWith('alice', 'bob', [id], 'bob');
});

it('blocks a replayed message after remount with one tombstone query per flush', async () => {
  const { unmount } = renderHook(() => useMarmotDmInbound('alice', jest.fn()));
  await act(async () => {
    mockOnMessage(deletion);
    await jest.advanceTimersByTimeAsync(150);
  });
  unmount();
  renderHook(() => useMarmotDmInbound('alice', jest.fn()));
  const db = await getLocalDb();
  const spy = jest.spyOn(db, 'execute');
  await act(async () => {
    mockOnMessage(chat(id, 'bob'));
    for (let i = 0; i < 20; i++) mockOnMessage(chat(i.toString(16).padStart(64, '0'), 'bob'));
    await jest.advanceTimersByTimeAsync(150);
  });
  const lookups = spy.mock.calls.filter(([sql]) => String(sql).includes('FROM marmot_deletions'));
  expect(lookups).toHaveLength(1);
  const stored = (upsertDmMessages as jest.Mock).mock.calls.flatMap(([rows]) => rows);
  expect(stored).toHaveLength(20);
  expect(stored.some((r: DmMessageRow) => r.eventId === id)).toBe(false);
  spy.mockRestore();
});

it('queries the tray for live deletions at once, and replayed ones in one later sweep', async () => {
  const now = Math.floor(Date.now() / 1000);
  renderHook(() => useMarmotDmInbound('alice', jest.fn()));
  const tray = () =>
    (retractMarmotMessageNotifications as jest.Mock).mock.calls.filter(([, o]) => o.tray);
  await act(async () => {
    for (let i = 0; i < 30; i++) {
      const target = i.toString(16).padStart(64, '0');
      mockOnMessage({
        ...deletion,
        rumor: { ...deletion.rumor, id: `old${i}`, tags: [['e', target]], created_at: 1 },
      });
    }
    mockOnMessage({ ...deletion, rumor: { ...deletion.rumor, created_at: now } });
    await jest.advanceTimersByTimeAsync(150);
  });
  // Every deletion cancels in-flight notifications (in memory)…
  expect(retractMarmotMessageNotifications).toHaveBeenCalledTimes(31 + tray().length);
  // …but only the live one has hit the tray so far.
  expect(tray()).toHaveLength(1);
  expect(tray()[0][0]).toEqual([{ owner: 'alice', groupId: 'g', messageId: id, sender: 'bob' }]);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(3000);
  });
  expect(tray()).toHaveLength(2);
  expect(tray()[1][0]).toHaveLength(30);
});

const editOf = (target: string, content: string, created_at: number, editId: string) =>
  ({
    ...deletion,
    rumor: { id: editId, kind: 1009, pubkey: 'bob', tags: [['e', target]], content, created_at },
  }) as MarmotMessageEvent;

it('lets a deletion win over an edit and its message in the same batch', async () => {
  renderHook(() => useMarmotDmInbound('alice', jest.fn()));
  await act(async () => {
    mockOnMessage(chat(id, 'bob'));
    mockOnMessage(editOf(id, 'edited', 4, 'e'.repeat(64)));
    mockOnMessage(deletion);
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(upsertDmMessages).not.toHaveBeenCalled();
  expect(applyMarmotEdits).not.toHaveBeenCalled();
});

it('overlays an edit that arrives before its message (same batch)', async () => {
  renderHook(() => useMarmotDmInbound('alice', jest.fn()));
  await act(async () => {
    mockOnMessage(editOf(id, 'edited', 4, 'e'.repeat(64)));
    mockOnMessage(chat(id, 'bob'));
    await jest.advanceTimersByTimeAsync(150);
  });
  const [rows] = (upsertDmMessages as jest.Mock).mock.calls[0];
  expect(rows).toEqual([
    expect.objectContaining({
      eventId: id,
      content: 'edited',
      editedAt: 4,
      editId: 'e'.repeat(64),
    }),
  ]);
});

it('settles same-second edits on the higher edit id, whatever the arrival order', async () => {
  renderHook(() => useMarmotDmInbound('alice', jest.fn()));
  await act(async () => {
    mockOnMessage(editOf(id, 'v3', 4, '2'.repeat(64)));
    mockOnMessage(editOf(id, 'v2', 4, '1'.repeat(64)));
    mockOnMessage(chat(id, 'bob'));
    await jest.advanceTimersByTimeAsync(150);
  });
  expect((upsertDmMessages as jest.Mock).mock.calls[0][0][0].content).toBe('v3');
  expect(
    (applyMarmotEdits as jest.Mock).mock.calls[0][1].map((e: { content: string }) => e.content),
  ).toEqual(['v3']);
});

it('applies a burst of edits with one inbox update and one thread reload per peer', async () => {
  const targets = ['1', '2', '3'].map((c) => c.repeat(64));
  (applyMarmotEdits as jest.Mock).mockImplementationOnce(async (_owner, edits) =>
    edits.map((edit: { target: string }) => ({ edit, conversation: 'bob' })),
  );
  const setter = jest.fn();
  renderHook(() => useMarmotDmInbound('alice', setter));
  await act(async () => {
    targets.forEach((t, i) => mockOnMessage(editOf(t, `v${i}`, 4, `${i}`.repeat(64))));
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(applyMarmotEdits).toHaveBeenCalledTimes(1);
  expect((applyMarmotEdits as jest.Mock).mock.calls[0][1]).toHaveLength(3);
  expect(setter).toHaveBeenCalledTimes(1);
  expect(notifyDmMessage).toHaveBeenCalledTimes(1);
});

describe('mayNotifyFrom (WoT phantoms)', () => {
  const PEER = 'b'.repeat(64);
  it('alerts for a followed peer', () => {
    expect(mayNotifyFrom(PEER, new Set([PEER]), false)).toBe(true);
    expect(mayNotifyFrom(PEER.toUpperCase(), new Set([PEER]), false)).toBe(true);
    expect(mayNotifyFrom(PEER, new Set(['c'.repeat(64)]), false)).toBe(false);
  });

  it('with no follows known and an unchosen tier: a stranger stays silent, a replied partner alerts (#1764)', () => {
    const unchosen = { tier: 'friends' as const, fof: null };
    for (const follows of [new Set<string>(), undefined]) {
      expect(mayNotifyFrom(PEER, follows, false, unchosen)).toBe(false);
      expect(mayNotifyFrom(PEER, follows, false, null)).toBe(false);
      expect(mayNotifyFrom(PEER, follows, true, unchosen)).toBe(true);
    }
  });

  it('widens to the chosen Web of Trust tier: friends of friends, or All', () => {
    const follows = new Set(['c'.repeat(64)]);
    expect(mayNotifyFrom(PEER, follows, false, { tier: 'friends', fof: null })).toBe(false);
    expect(mayNotifyFrom(PEER, follows, false, { tier: 'fof', fof: new Set([PEER]) })).toBe(true);
    expect(mayNotifyFrom(PEER, follows, false, { tier: 'fof', fof: null })).toBe(false);
    expect(mayNotifyFrom(PEER, follows, false, { tier: 'all', fof: null })).toBe(true);
    expect(mayNotifyFrom(PEER, new Set(), false, { tier: 'all', fof: null })).toBe(true);
  });
});

describe('our own Marmot messages never alert (any device)', () => {
  const chat = (pubkey: string, rumorId: string) =>
    ({
      group: deletion.group,
      rumor: {
        id: rumorId,
        kind: 9,
        pubkey,
        tags: [],
        content: 'hello',
        created_at: Math.floor(Date.now() / 1000),
      },
    }) as MarmotMessageEvent;

  it.each([
    ['the echo of a send from this device', 'alice'],
    // Another leaf of our account (e.g. White Noise on the phone) signs with
    // the same pubkey, whatever its casing on the wire.
    ['a message sent from another of our devices', 'ALICE'],
  ])('%s: shown as ours in the thread, no alert or history row', async (_label, author) => {
    renderHook(() => useMarmotDmInbound('alice', jest.fn()));
    await act(async () => {
      mockOnMessage(chat(author, 'b'.repeat(64)));
      await jest.advanceTimersByTimeAsync(150);
    });
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({ eventId: 'b'.repeat(64), fromMe: true, sender: 'alice' }),
    ]);
    expect(fireMessageNotification).not.toHaveBeenCalled();
  });

  it("still alerts for the peer's message (control)", async () => {
    renderHook(() => useMarmotDmInbound('alice', jest.fn(), new Set(['bob'])));
    await act(async () => {
      mockOnMessage(chat('bob', 'c'.repeat(64)));
      await jest.advanceTimersByTimeAsync(150);
      // The alert waits for who we've replied to (an async, once-per-account load).
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(fireMessageNotification).toHaveBeenCalledTimes(1);
  });

  describe('follow list still loading at cold start', () => {
    beforeEach(() => {
      __resetRepliedPartnersForTests();
      __resetNotificationAudiences();
      mockReplied = [];
    });
    // The alert first waits for who we've replied to (an async load).
    const settle = async (ms: number) => {
      await jest.advanceTimersByTimeAsync(ms);
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    it("holds a friend's alert until the follows are known, instead of dropping it", async () => {
      const setter = jest.fn(); // stable: a new one would re-arm the hook
      const { rerender } = renderHook(
        ({ follows, hydrated }: { follows: Set<string>; hydrated: boolean }) =>
          useMarmotDmInbound('alice', setter, follows, hydrated),
        { initialProps: { follows: new Set<string>(), hydrated: false } },
      );
      await act(async () => {
        mockOnMessage(chat('bob', 'd'.repeat(64)));
        await settle(150);
      });
      expect(fireMessageNotification).not.toHaveBeenCalled();
      await act(async () => {
        rerender({ follows: new Set(['bob']), hydrated: true });
        await settle(0);
      });
      expect(fireMessageNotification).toHaveBeenCalledTimes(1);
    });

    it('a stranger still stays silent once the wait runs out', async () => {
      renderHook(() => useMarmotDmInbound('alice', jest.fn(), new Set(), false));
      await act(async () => {
        mockOnMessage(chat('bob', '2'.repeat(64)));
        await settle(150);
        await settle(10_000);
      });
      expect(fireMessageNotification).not.toHaveBeenCalled();
    });

    it('decides with what it has after 10 s, and drops held alerts on unmount', async () => {
      const { unmount } = renderHook(() =>
        useMarmotDmInbound('alice', jest.fn(), new Set(['bob']), false),
      );
      await act(async () => {
        mockOnMessage(chat('bob', 'e'.repeat(64)));
        await settle(150);
      });
      expect(fireMessageNotification).not.toHaveBeenCalled();
      await act(async () => {
        await settle(10_000);
      });
      expect(fireMessageNotification).toHaveBeenCalledTimes(1);
      await act(async () => {
        mockOnMessage(chat('bob', '1'.repeat(64)));
        await settle(150);
      });
      // Its own act: the cleanup must have run before the wait elapses.
      await act(async () => unmount());
      await act(async () => {
        await settle(10_000);
      });
      expect(fireMessageNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('no follows known yet, unchosen tier (#1764)', () => {
    beforeEach(() => {
      __resetRepliedPartnersForTests();
      __resetNotificationAudiences();
      mockReplied = [];
    });
    afterAll(() => {
      __resetRepliedPartnersForTests();
      mockReplied = [];
    });

    it('a stranger in an existing 1:1 stays silent', async () => {
      renderHook(() => useMarmotDmInbound('alice', jest.fn(), new Set()));
      await act(async () => {
        mockOnMessage(chat('bob', 'd'.repeat(64)));
        await jest.advanceTimersByTimeAsync(150);
        // The alert waits for who we've replied to (an async, once-per-account load).
        await jest.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(upsertDmMessages).toHaveBeenCalled(); // still stored
      expect(fireMessageNotification).not.toHaveBeenCalled();
    });

    it('a partner we have replied to alerts', async () => {
      mockReplied = ['bob'];
      renderHook(() => useMarmotDmInbound('alice', jest.fn(), new Set()));
      await act(async () => {
        mockOnMessage(chat('bob', 'e'.repeat(64)));
        await jest.advanceTimersByTimeAsync(150);
        // The alert waits for who we've replied to (an async, once-per-account load).
        await jest.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(fireMessageNotification).toHaveBeenCalledTimes(1);
    });

    it('an explicitly chosen All lets anyone alert', async () => {
      publishNotificationAudience('alice', { tier: 'all', fof: null });
      renderHook(() => useMarmotDmInbound('alice', jest.fn(), new Set()));
      await act(async () => {
        mockOnMessage(chat('bob', 'f'.repeat(64)));
        await jest.advanceTimersByTimeAsync(150);
        // The alert waits for who we've replied to (an async, once-per-account load).
        await jest.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(fireMessageNotification).toHaveBeenCalledTimes(1);
    });
  });
});
