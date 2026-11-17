import type { ListViewToken as ViewToken } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useChatReadPosition } from './useChatReadPosition';
import {
  CHAT_READ_POSITIONS_KEY_BASE,
  __resetReadPositionsForTests,
  flushReadPositions,
  getReadMarker,
} from '../services/chatReadPositions';
import type { UnreadEntry } from '../utils/chatUnread';

let mockFocused = true;
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused }));

const OWNER = 'f'.repeat(64);
const KEY = 'group:g1';
const e = (id: string, createdAt: number, fromMe = false, mentionsMe = false): UnreadEntry => ({
  id,
  createdAt,
  fromMe,
  mentionsMe,
});
const entries = [
  e('a', 10),
  e('b', 20),
  e('c', 30, false, true),
  e('d', 40),
  e('e', 50, false, true),
];
const seen = (...ids: string[]) =>
  ({ viewableItems: ids.map((key) => ({ key, isViewable: true }) as ViewToken), changed: [] }) as {
    viewableItems: ViewToken[];
  };

// Report on-screen rows through the hook's first viewability config.
const view = (hook: ReturnType<typeof useChatReadPosition>, info: { viewableItems: ViewToken[] }) =>
  hook.viewabilityConfigCallbackPairs[0].onViewableItemsChanged(info);

async function seed(markers: Record<string, { at: number; id?: string }>) {
  await AsyncStorage.setItem(
    `${CHAT_READ_POSITIONS_KEY_BASE}_${OWNER}`,
    JSON.stringify({ v: 1, baseline: 0, markers }),
  );
}

function setup(scrollToId = jest.fn(() => true), leaveEdge = jest.fn()) {
  const hook = renderHook(() =>
    useChatReadPosition({
      owner: OWNER,
      conversationKey: KEY,
      entries,
      loading: false,
      scrollToId,
      leaveEdge,
    }),
  );
  return { ...hook, scrollToId, leaveEdge };
}

afterEach(() => jest.useRealTimers());

beforeEach(async () => {
  mockFocused = true;
  (AppState as { currentState: string }).currentState = 'active';
  __resetReadPositionsForTests();
  await AsyncStorage.clear();
});

it('opens at the first unread: divider, jump, and counts', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  jest.useFakeTimers();
  const { result, scrollToId, leaveEdge } = setup();
  await waitFor(() => expect(result.current.dividerId).toBe('c'));
  expect(result.current.unread).toBe(3);
  expect(result.current.pendingMentions).toEqual(['c', 'e']);
  expect(leaveEdge).toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(60));
  expect(scrollToId).toHaveBeenCalledWith('c', false);
  jest.useRealTimers();
});

it('advances the position as rows are seen, and the mention queue with it', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  jest.useFakeTimers();
  const { result } = setup();
  await waitFor(() => expect(result.current.dividerId).toBe('c'));
  // Still landing: rows passed on the way (not the target) don't count.
  act(() => view(result.current, seen('e')));
  expect(result.current.unread).toBe(3);
  // The target is on screen: the jump has landed, and what's visible counts.
  act(() => view(result.current, seen('c', 'd')));
  expect(result.current.unread).toBe(1);
  expect(result.current.pendingMentions).toEqual(['e']);
  // Written to the store only once the late-arrival window has closed.
  expect(getReadMarker(OWNER, KEY)).toEqual({ at: 20, id: 'b' });
  act(() => jest.advanceTimersByTime(4000));
  expect(getReadMarker(OWNER, KEY)).toEqual({ at: 40, id: 'd' });
  // The divider stays where it was for this visit.
  expect(result.current.dividerId).toBe('c');
  jest.useRealTimers();
  await act(async () => {
    await flushReadPositions(OWNER);
  });
});

it('jumps to the oldest pending mention', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  const { result, scrollToId } = setup();
  await waitFor(() => expect(result.current.pendingMentions).toEqual(['c', 'e']));
  act(() => result.current.jumpToNextMention());
  expect(scrollToId).toHaveBeenLastCalledWith('c', true);
});

it('opens at the bottom with no divider when everything is read', async () => {
  await seed({ [KEY]: { at: 50, id: 'e' } });
  const { result, scrollToId } = setup();
  await waitFor(() => expect(getReadMarker(OWNER, KEY)).not.toBeNull());
  await waitFor(() => expect(result.current.unread).toBe(0));
  expect(result.current.dividerId).toBeNull();
  expect(scrollToId).not.toHaveBeenCalled();
});

it('does not mark rows read while the screen is not focused', async () => {
  await seed({ [KEY]: { at: 50, id: 'e' } });
  mockFocused = false;
  const { result } = setup();
  await waitFor(() => expect(getReadMarker(OWNER, KEY)).not.toBeNull());
  act(() => view(result.current, seen('a')));
  expect(getReadMarker(OWNER, KEY)).toEqual({ at: 50, id: 'e' });
});

it('does not mark rows read while the app is in the background', async () => {
  await seed({ [KEY]: { at: 10, id: 'a' } });
  (AppState as { currentState: string }).currentState = 'background';
  const { result } = setup();
  await waitFor(() => expect(result.current.dividerId).toBe('b'));
  await new Promise((r) => setTimeout(r, 600));
  act(() => view(result.current, seen('e')));
  expect(getReadMarker(OWNER, KEY)).toEqual({ at: 10, id: 'a' });
});

it('places the divider on messages that land just after opening', async () => {
  await seed({ [KEY]: { at: 50, id: 'e' } });
  const scrollToId = jest.fn(() => true);
  const props = { entries };
  const { result, rerender } = renderHook(
    ({ entries: list }: { entries: UnreadEntry[] }) =>
      useChatReadPosition({
        owner: OWNER,
        conversationKey: KEY,
        entries: list,
        loading: false,
        scrollToId,
        leaveEdge: jest.fn(),
      }),
    { initialProps: props },
  );
  await waitFor(() => expect(getReadMarker(OWNER, KEY)).not.toBeNull());
  await waitFor(() => expect(result.current.unread).toBe(0));
  // Seen while the late-arrival window is open: not counted yet.
  act(() => view(result.current, seen('e')));
  rerender({ entries: [...entries, e('f', 60), e('g', 70)] });
  await waitFor(() => expect(result.current.dividerId).toBe('f'));
  expect(result.current.unread).toBe(2);
  await waitFor(() => expect(scrollToId).toHaveBeenCalledWith('f', false));
});

it('counts rows anyway if the jump target never reports visible', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  jest.useFakeTimers();
  const { result } = setup();
  await waitFor(() => expect(result.current.dividerId).toBe('c'));
  act(() => view(result.current, seen('d')));
  expect(result.current.unread).toBe(3);
  act(() => jest.advanceTimersByTime(2500));
  expect(result.current.unread).toBe(1);
  jest.useRealTimers();
});

it('moves the divider back when an older unread lands just after the jump', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  const scrollToId = jest.fn(() => true);
  const { result, rerender } = renderHook(
    ({ list }: { list: UnreadEntry[] }) =>
      useChatReadPosition({
        owner: OWNER,
        conversationKey: KEY,
        entries: list,
        loading: false,
        scrollToId,
        leaveEdge: jest.fn(),
      }),
    { initialProps: { list: entries } },
  );
  await waitFor(() => expect(result.current.dividerId).toBe('c'));
  act(() => view(result.current, seen('c', 'd')));
  expect(result.current.unread).toBe(1);
  const late = [e('a', 10), e('b', 20), e('late', 25), ...entries.slice(2)];
  rerender({ list: late });
  await waitFor(() => expect(result.current.dividerId).toBe('late'));
  expect(result.current.unread).toBe(4);
  await waitFor(() => expect(scrollToId).toHaveBeenCalledWith('late', false));
});

it.each(['dm:peer', KEY])(
  'reconciles older backfill after completing the unread section in %s',
  async (conversationKey) => {
    await seed({ [conversationKey]: { at: 20, id: 'b' } });
    jest.useFakeTimers();
    const scrollToId = jest.fn(() => true);
    const { result, rerender, unmount } = renderHook(
      ({ list }: { list: UnreadEntry[] }) =>
        useChatReadPosition({
          owner: OWNER,
          conversationKey,
          entries: list,
          loading: false,
          scrollToId,
          leaveEdge: jest.fn(),
        }),
      { initialProps: { list: entries } },
    );
    await waitFor(() => expect(result.current.dividerId).toBe('c'));
    act(() => view(result.current, seen('c', 'd', 'e')));
    expect(result.current.unread).toBe(0);
    expect(result.current.dividerId).toBeNull();

    act(() => jest.advanceTimersByTime(1000));
    rerender({ list: [...entries.slice(0, 2), e('late', 25, false, true), ...entries.slice(2)] });
    expect(result.current.dividerId).toBe('late');
    expect(result.current.unread).toBe(4);
    expect(result.current.pendingMentions).toEqual(['late', 'c', 'e']);
    act(() => jest.advanceTimersByTime(60));
    expect(scrollToId).toHaveBeenLastCalledWith('late', false);
    // Passing newer rows during the jump cannot consume the unseen backfill.
    act(() => view(result.current, seen('e')));
    expect(result.current.unread).toBe(4);
    // The list leaves those rows while the jump lands.
    act(() => view(result.current, seen()));
    act(() => jest.advanceTimersByTime(2940));
    expect(getReadMarker(OWNER, conversationKey)).toEqual({ at: 20, id: 'b' });

    act(() => view(result.current, seen('late', 'c', 'd', 'e')));
    expect(result.current.unread).toBe(0);
    expect(result.current.dividerId).toBeNull();
    expect(getReadMarker(OWNER, conversationKey)).toEqual({ at: 50, id: 'e' });
    unmount();
  },
);

it('retires the divider after reading everything and does not restore it for new arrivals', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  jest.useFakeTimers();
  const { result, rerender, unmount } = renderHook(
    ({ list }: { list: UnreadEntry[] }) =>
      useChatReadPosition({
        owner: OWNER,
        conversationKey: KEY,
        entries: list,
        loading: false,
        scrollToId: jest.fn(() => true),
        leaveEdge: jest.fn(),
      }),
    { initialProps: { list: entries } },
  );
  await waitFor(() => expect(result.current.dividerId).toBe('c'));
  act(() => view(result.current, seen('c', 'd')));
  rerender({ list: [...entries, e('own', 55, true)] });
  expect(result.current.unread).toBe(1);
  expect(result.current.dividerId).toBe('c');
  act(() => view(result.current, seen('e')));
  expect(result.current.unread).toBe(0);
  expect(result.current.dividerId).toBeNull();
  // Still in the late-arrival window: completion must not reset the marker.
  rerender({ list: [...entries, e('f', 60)] });
  expect(result.current.unread).toBe(1);
  expect(result.current.dividerId).toBeNull();
  act(() => view(result.current, seen('f')));
  expect(result.current.unread).toBe(0);
  unmount();
  await act(async () => {
    await flushReadPositions(OWNER);
  });
  expect(getReadMarker(OWNER, KEY)).toEqual({ at: 60, id: 'f' });
  const reopened = setup();
  await waitFor(() => expect(reopened.result.current.unread).toBe(0));
  expect(reopened.result.current.dividerId).toBeNull();
});

it('keeps an explicit message target ahead of the unread jump after its route param clears', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  jest.useFakeTimers();
  const scrollToId = jest.fn(() => true);
  const { result, rerender } = renderHook(
    ({ target, rows }: { target?: string; rows: UnreadEntry[] }) =>
      useChatReadPosition({
        owner: OWNER,
        conversationKey: KEY,
        entries: rows,
        loading: false,
        scrollToId,
        leaveEdge: jest.fn(),
        initialTarget: target,
      }),
    { initialProps: { target: 'a', rows: entries } },
  );
  await waitFor(() => expect(result.current.dividerId).toBe('c'));
  rerender({
    target: undefined,
    rows: [entries[0], entries[1], e('late', 25), ...entries.slice(2)],
  });
  await waitFor(() => expect(result.current.dividerId).toBe('late'));
  act(() => jest.advanceTimersByTime(100));
  expect(scrollToId).not.toHaveBeenCalled();
  act(() => result.current.jumpToNextMention());
  expect(scrollToId).toHaveBeenCalledWith('c', true);
});

it('cancels a queued unread jump when a warm notification tap targets the open screen', async () => {
  await seed({ [KEY]: { at: 20, id: 'b' } });
  jest.useFakeTimers();
  const scrollToId = jest.fn(() => true);
  const { result, rerender } = renderHook(
    ({ target }: { target?: string }) =>
      useChatReadPosition({
        owner: OWNER,
        conversationKey: KEY,
        entries,
        loading: false,
        scrollToId,
        leaveEdge: jest.fn(),
        initialTarget: target,
      }),
    { initialProps: { target: undefined as string | undefined } },
  );
  await waitFor(() => expect(result.current.dividerId).toBe('c'));
  rerender({ target: 'a' });
  act(() => jest.advanceTimersByTime(100));
  expect(scrollToId).not.toHaveBeenCalled();
});
