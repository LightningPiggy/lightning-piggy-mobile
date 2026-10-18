import { act, renderHook } from '@testing-library/react-native';
import { useCallback, useState, type SetStateAction } from 'react';
import { loadInboxEntries } from '../services/dmInbox';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { useDmInboxDeletions } from './useDmInboxDeletions';

type Listener = (owner: string, ids: readonly string[]) => void;
const mockListeners = new Set<Listener>();
jest.mock('../services/dmDb', () => ({
  subscribeDmDeletions: (l: Listener) => {
    mockListeners.add(l);
    return () => mockListeners.delete(l);
  },
}));
jest.mock('../services/dmInbox', () => ({ loadInboxEntries: jest.fn() }));

const entry = (id: string, partnerPubkey: string, createdAt: number): DmInboxEntry => ({
  id,
  partnerPubkey,
  fromMe: false,
  createdAt,
  text: id,
  wireKind: 14,
});

const emit = async (owner: string, ids: string[]) => {
  await act(async () => {
    for (const l of mockListeners) l(owner, ids);
  });
};

// Mirrors useDmInbox's owner-scoped setter: writes for another owner drop.
function useHarness(active: string, initial: DmInboxEntry[]) {
  const [inbox, setInbox] = useState(initial);
  const setterFor = useCallback(
    (owner: string | null) => (action: SetStateAction<DmInboxEntry[]>) => {
      if (owner === active) setInbox(action);
    },
    [active],
  );
  useDmInboxDeletions(setterFor);
  return inbox;
}

beforeEach(() => {
  jest.mocked(loadInboxEntries).mockReset();
});

describe('useDmInboxDeletions', () => {
  it('drops deleted rows and restores the thread from the store', async () => {
    const older = entry('older', 'group', 50);
    jest.mocked(loadInboxEntries).mockResolvedValue([older, entry('dm', 'bob', 90)]);
    const { result } = renderHook(() =>
      useHarness('me', [entry('ticket', 'group', 100), entry('dm', 'bob', 90)]),
    );
    await emit('me', ['ticket']);
    expect(loadInboxEntries).toHaveBeenCalledWith('me');
    expect(result.current.map((e) => e.id)).toEqual(['dm', 'older']);
  });

  it('leaves the inbox untouched when no shown row was deleted', async () => {
    const initial = [entry('dm', 'bob', 90)];
    jest.mocked(loadInboxEntries).mockResolvedValue([entry('dm', 'bob', 90)]);
    const { result } = renderHook(() => useHarness('me', initial));
    await emit('me', ['other']);
    expect(result.current).toBe(initial);
  });

  it("ignores another account's deletions", async () => {
    const initial = [entry('ticket', 'group', 100)];
    jest.mocked(loadInboxEntries).mockResolvedValue([]);
    const { result } = renderHook(() => useHarness('me', initial));
    await emit('them', ['ticket']);
    expect(result.current).toBe(initial);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useHarness('me', []));
    expect(mockListeners.size).toBe(1);
    unmount();
    expect(mockListeners.size).toBe(0);
  });

  it('reads finishing out of order never bring back a deleted row', async () => {
    let finishA!: (rows: DmInboxEntry[]) => void;
    let finishB!: (rows: DmInboxEntry[]) => void;
    jest
      .mocked(loadInboxEntries)
      .mockImplementationOnce(() => new Promise((r) => (finishA = r)))
      .mockImplementationOnce(() => new Promise((r) => (finishB = r)));
    const { result } = renderHook(() =>
      useHarness('me', [entry('a', 'group', 100), entry('b', 'bob', 90), entry('c', 'cat', 80)]),
    );
    await emit('me', ['a']); // A's read starts: the store still has B
    await emit('me', ['b']);
    await act(async () => finishB([entry('c', 'cat', 80)])); // newer read first
    expect(result.current.map((e) => e.id)).toEqual(['c']);
    await act(async () => finishA([entry('b', 'bob', 90), entry('c', 'cat', 80)])); // stale
    expect(result.current.map((e) => e.id)).toEqual(['c']);
  });
});
