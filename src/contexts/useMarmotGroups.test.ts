import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMarmotGroups } from './useMarmotGroups';
import { appendGroupMessage, loadGroupMessages } from '../services/groupMessagesStorageService';
import { getLocalDb } from '../services/localDb';
import type { MarmotMessageEvent } from '../services/marmotSession';
import { fireMessageNotification } from '../services/notificationService';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
let mockOnMessage: (event: MarmotMessageEvent) => void;
jest.mock('../services/marmotSession', () => ({
  MARMOT_CHAT_KIND: 9,
  subscribeMarmotSession: (cb: (session: unknown) => void) => {
    cb({
      pubkey: 'a'.repeat(64),
      listGroups: () => [],
      subscribe: (handlers: { onMessage: typeof mockOnMessage }) => {
        mockOnMessage = handlers.onMessage;
        return () => {};
      },
    });
    return () => {};
  },
}));
jest.mock('../services/marmotSend', () => ({ requireMarmotSession: jest.fn() }));
jest.mock('../services/notificationService', () => ({
  retractMarmotMessageNotifications: jest.fn().mockResolvedValue(0),
  fireMessageNotification: jest.fn(),
}));
// Real tombstone store (SQL) on Node's SQLite.
jest.mock('@op-engineering/op-sqlite', () =>
  require('../services/testUtils/nodeSqliteOpSqlite').nodeSqliteOpSqlite(),
);
jest.mock('../services/localDbKey', () => ({
  getOrCreateLocalDbKey: jest.fn(() => Promise.resolve('k')),
  clearLocalDbKey: jest.fn(() => Promise.resolve()),
}));
const id = 'a'.repeat(64);
const group = {
  id: 'g',
  name: 'Group',
  description: '',
  relays: [],
  createdAt: 1,
  isDm: false,
  memberPubkeys: ['a'.repeat(64), 'bob'],
  adminPubkeys: [],
};
const remove = (target: string, sender = 'a'.repeat(64)) =>
  ({
    group,
    rumor: {
      id: 'delete',
      kind: 5,
      pubkey: sender,
      tags: [['e', target]],
      content: '',
      created_at: 1,
    },
  }) as MarmotMessageEvent;

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  await (await getLocalDb()).execute('DELETE FROM marmot_deletions;');
});
afterEach(() => jest.useRealTimers());
it('applies a deletion after 2001 unrelated targets evict it before flush, then blocks replay after remount', async () => {
  await appendGroupMessage('a'.repeat(64), 'g', {
    id,
    senderPubkey: 'a'.repeat(64),
    text: 'deleted plaintext',
    createdAt: 1,
  });
  const { unmount } = renderHook(() => useMarmotGroups('a'.repeat(64)));
  await act(async () => {
    mockOnMessage(remove(id));
    mockOnMessage(remove(id, 'bob'));
    for (let i = 0; i < 2001; i++) mockOnMessage(remove(i.toString(16).padStart(64, '0'), 'bob'));
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(await loadGroupMessages('a'.repeat(64), 'g')).toEqual([]);
  unmount();
  renderHook(() => useMarmotGroups('a'.repeat(64)));
  await act(async () => {
    mockOnMessage({
      group,
      rumor: {
        id,
        pubkey: 'a'.repeat(64),
        kind: 9,
        content: 'deleted plaintext',
        tags: [],
        created_at: 1,
      },
    } as MarmotMessageEvent);
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(await loadGroupMessages('a'.repeat(64), 'g')).toEqual([]);
});

const message = (msgId: string, sender: string, text: string) =>
  ({
    group,
    rumor: { id: msgId, pubkey: sender, kind: 9, content: text, tags: [], created_at: 1 },
  }) as MarmotMessageEvent;

it('drops a message whose delete lands in the same batch, and keeps the rest', async () => {
  renderHook(() => useMarmotGroups('a'.repeat(64)));
  await act(async () => {
    mockOnMessage(message(id, 'bob', 'deleted'));
    mockOnMessage(message('b'.repeat(64), 'bob', 'kept'));
    mockOnMessage(remove(id, 'bob'));
    await jest.advanceTimersByTimeAsync(150);
  });
  expect((await loadGroupMessages('a'.repeat(64), 'g')).map((m) => m.text)).toEqual(['kept']);
});

it("ignores a member's delete of someone else's message, and a non-admin's kind 4891", async () => {
  await appendGroupMessage('a'.repeat(64), 'g', {
    id,
    senderPubkey: 'a'.repeat(64),
    text: 'mine',
    createdAt: 1,
  });
  renderHook(() => useMarmotGroups('a'.repeat(64)));
  const adminRemove = {
    group,
    rumor: {
      id: 'admin-remove',
      kind: 4891,
      pubkey: 'bob',
      tags: [['e', id]],
      content: '{"v":1,"action":"remove"}',
      created_at: 1,
    },
  } as MarmotMessageEvent;
  await act(async () => {
    mockOnMessage(remove(id, 'bob'));
    mockOnMessage(adminRemove);
    await jest.advanceTimersByTimeAsync(150);
  });
  expect((await loadGroupMessages('a'.repeat(64), 'g')).map((m) => m.text)).toEqual(['mine']);
  // With admin rights, the same 4891 removes it.
  const promoted = { ...group, adminPubkeys: ['bob'] };
  await act(async () => {
    mockOnMessage({ ...adminRemove, group: promoted });
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(await loadGroupMessages('a'.repeat(64), 'g')).toEqual([]);
});

const editOf = (target: string, content: string, created_at: number, editId: string, by = 'bob') =>
  ({
    group,
    rumor: { id: editId, pubkey: by, kind: 1009, content, tags: [['e', target]], created_at },
  }) as MarmotMessageEvent;

it('overlays an edit that arrives before its message, and ignores a forged one', async () => {
  renderHook(() => useMarmotGroups('a'.repeat(64)));
  await act(async () => {
    mockOnMessage(editOf(id, 'forged', 9, 'f'.repeat(64), 'mallory'));
    mockOnMessage(editOf(id, 'edited', 2, 'e'.repeat(64)));
    mockOnMessage(message(id, 'bob', 'original'));
    await jest.advanceTimersByTimeAsync(150);
  });
  expect(await loadGroupMessages('a'.repeat(64), 'g')).toEqual([
    expect.objectContaining({ id, text: 'edited', editedAt: 2, editId: 'e'.repeat(64) }),
  ]);
});

it('applies an edit to a stored message, but never after its delete in the same batch', async () => {
  renderHook(() => useMarmotGroups('a'.repeat(64)));
  await act(async () => {
    mockOnMessage(message(id, 'bob', 'original'));
    mockOnMessage(message('b'.repeat(64), 'bob', 'other'));
    await jest.advanceTimersByTimeAsync(150);
  });
  await act(async () => {
    mockOnMessage(editOf('b'.repeat(64), 'other v2', 2, '2'.repeat(64)));
    mockOnMessage(editOf(id, 'edited', 2, 'e'.repeat(64)));
    mockOnMessage(remove(id, 'bob'));
    await jest.advanceTimersByTimeAsync(150);
  });
  expect((await loadGroupMessages('a'.repeat(64), 'g')).map((m) => m.text)).toEqual(['other v2']);
});

describe('our own Marmot group messages never alert (any device)', () => {
  const ME = 'a'.repeat(64);
  const chat = (pubkey: string, rumorId: string) =>
    ({
      group,
      rumor: {
        id: rumorId,
        kind: 9,
        pubkey,
        tags: [],
        content: 'hello group',
        created_at: Math.floor(Date.now() / 1000),
      },
    }) as MarmotMessageEvent;

  it.each([
    ['the echo of a send from this device', ME],
    ['a message sent from another of our devices', ME.toUpperCase()],
  ])('%s: kept in the thread as ours, no alert or history row', async (_label, author) => {
    (fireMessageNotification as jest.Mock).mockClear();
    const { unmount } = renderHook(() => useMarmotGroups(ME));
    await act(async () => {
      mockOnMessage(chat(author, 'e'.repeat(64)));
      await jest.advanceTimersByTimeAsync(500);
    });
    const stored = await loadGroupMessages(ME, 'g');
    expect(stored.find((m) => m.id === 'e'.repeat(64))?.senderPubkey).toBe(ME);
    expect(fireMessageNotification).not.toHaveBeenCalled();
    unmount();
  });

  it("still alerts for another member's message (control)", async () => {
    (fireMessageNotification as jest.Mock).mockClear();
    const { unmount } = renderHook(() => useMarmotGroups(ME));
    await act(async () => {
      mockOnMessage(chat('bob', 'f'.repeat(64)));
      await jest.advanceTimersByTimeAsync(500);
    });
    expect(fireMessageNotification).toHaveBeenCalledTimes(1);
    unmount();
  });
});

it('writes a burst of group messages to history once, not once per message (#1786)', async () => {
  const setItem = AsyncStorage.setItem as jest.Mock;
  setItem.mockClear();
  renderHook(() => useMarmotGroups('a'.repeat(64)));
  await act(async () => {
    for (let i = 0; i < 200; i++)
      mockOnMessage(message((i + 1).toString(16).padStart(64, '0'), 'bob', `m${i}`));
    await jest.advanceTimersByTimeAsync(150);
  });
  const historyWrites = setItem.mock.calls.filter(([k]) => k.startsWith('group_history_'));
  expect(historyWrites).toHaveLength(1);
  expect(await loadGroupMessages('a'.repeat(64), 'g')).toHaveLength(200);
});
