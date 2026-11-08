import { act, renderHook } from '@testing-library/react-native';
import { useProfileFeed } from './useProfileFeed';
import {
  fetchAuthorFeedPage,
  subscribeAuthorFeed,
  subscribeAuthorOutboxFeed,
  type AuthorFeedEvent,
} from '../services/authorFeedService';

// The profile feed is the union of the viewer's relays and the author's own
// write relays (#1390); the author relays never hold up the first posts.
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({
    relays: [
      { url: 'wss://mine.example/', read: true, write: true },
      { url: 'wss://write-only.example/', read: false, write: true },
    ],
  }),
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('../services/authorFeedService', () => ({
  AUTHOR_FEED_PAGE_SIZE: 30,
  fetchAuthorFeedPage: jest.fn(),
  subscribeAuthorFeed: jest.fn(),
  subscribeAuthorOutboxFeed: jest.fn(),
}));

const alice = 'a'.repeat(64);
const note = (id: string, created_at: number): AuthorFeedEvent => ({
  id,
  pubkey: alice,
  kind: 1,
  created_at,
  content: id,
  tags: [],
});

type MainInput = Parameters<typeof subscribeAuthorFeed>[0];
type OutboxInput = Parameters<typeof subscribeAuthorOutboxFeed>[0];
let main: MainInput;
let outbox: OutboxInput;
const closeMain = jest.fn();
const closeOutbox = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.mocked(subscribeAuthorFeed).mockImplementation((input) => {
    main = input;
    return closeMain;
  });
  jest.mocked(subscribeAuthorOutboxFeed).mockImplementation((input) => {
    outbox = input;
    return closeOutbox;
  });
});

it("subscribes the viewer's read relays first, then the author's relays in the background", () => {
  renderHook(() => useProfileFeed(alice, 0));
  expect(main.relays).toEqual(['wss://mine.example/']);
  expect(outbox.currentRelays).toEqual(['wss://mine.example/']);
  const mainOrder = jest.mocked(subscribeAuthorFeed).mock.invocationCallOrder[0];
  const outboxOrder = jest.mocked(subscribeAuthorOutboxFeed).mock.invocationCallOrder[0];
  expect(mainOrder).toBeLessThan(outboxOrder);
});

it("shows the viewer's relay results at once, without waiting for the author's relays", () => {
  const { result } = renderHook(() => useProfileFeed(alice, 0));
  act(() => {
    main.onEvent(note('mine', 2));
    main.onEose?.();
  });
  // The author-relay lookup hasn't answered at all, yet the post is shown.
  expect(result.current.events.map((e) => e.id)).toEqual(['mine']);
  expect(result.current.loading).toBe(false);
});

it("merges the author's relay results into the same feed, coalesced and deduped", () => {
  const { result } = renderHook(() => useProfileFeed(alice, 0));
  act(() => {
    main.onEvent(note('mine', 2));
    main.onEose?.();
  });
  act(() => {
    outbox.onRelays?.(['wss://alice.example/']);
    outbox.onEvent(note('theirs', 3));
    outbox.onEvent(note('mine', 2));
  });
  // Not committed per event: one coalesced flush.
  expect(result.current.events.map((e) => e.id)).toEqual(['mine']);
  act(() => {
    jest.advanceTimersByTime(200);
  });
  expect(result.current.events.map((e) => e.id)).toEqual(['theirs', 'mine']);
});

const pageCalls = () =>
  jest
    .mocked(fetchAuthorFeedPage)
    .mock.calls.map(([input]) => ({ relays: input.relays, until: input.until }));

it('pages each relay set from its own cursor, so no posts are skipped (#1)', async () => {
  jest.mocked(fetchAuthorFeedPage).mockResolvedValue({ events: [], complete: false });
  const { result } = renderHook(() => useProfileFeed(alice, 0));
  act(() => {
    // The viewer's relays only have an old post; the author's have 971–1000.
    main.onEvent(note('old', 100));
    main.onEose?.();
    outbox.onRelays?.(['wss://alice.example/']);
    outbox.onEvent(note('n1000', 1000));
    outbox.onEvent(note('n971', 971));
  });
  await act(async () => {
    await result.current.loadMore();
  });
  expect(pageCalls()).toEqual(
    expect.arrayContaining([
      { relays: ['wss://mine.example/'], until: 100 },
      // Not `until: 100`, which would skip 101–970 for good.
      { relays: ['wss://alice.example/'], until: 971 },
    ]),
  );
  expect(pageCalls()).toHaveLength(2);
});

it('one set reaching its end leaves the other paging; the end is only when both are done', async () => {
  const page = jest.mocked(fetchAuthorFeedPage);
  page.mockImplementation(async ({ relays }) =>
    relays[0] === 'wss://mine.example/'
      ? { events: [], complete: true }
      : { events: [note('n900', 900)], complete: true },
  );
  const { result } = renderHook(() => useProfileFeed(alice, 0));
  act(() => {
    main.onEvent(note('old', 100));
    outbox.onRelays?.(['wss://alice.example/']);
    outbox.onEvent(note('n971', 971));
  });
  await act(async () => {
    await result.current.loadMore();
  });
  expect(result.current.reachedEnd).toBe(false);
  page.mockClear();
  page.mockResolvedValue({ events: [], complete: true });
  await act(async () => {
    await result.current.loadMore();
  });
  // Only the author's set is still paged, from its advanced cursor.
  expect(pageCalls()).toEqual([{ relays: ['wss://alice.example/'], until: 900 }]);
  expect(result.current.reachedEnd).toBe(true);
});

it("late-found author relays re-open paging after the viewer's relays ended (#2)", async () => {
  const page = jest.mocked(fetchAuthorFeedPage);
  page.mockResolvedValue({ events: [], complete: true });
  const { result } = renderHook(() => useProfileFeed(alice, 0));
  act(() => {
    main.onEvent(note('old', 100));
    main.onEose?.();
  });
  await act(async () => {
    await result.current.loadMore();
  });
  expect(result.current.reachedEnd).toBe(true);
  // The author's relays turn up afterwards, with posts.
  act(() => {
    outbox.onRelays?.(['wss://alice.example/']);
    outbox.onEvent(note('n500', 500));
  });
  expect(result.current.reachedEnd).toBe(false);
  page.mockClear();
  page.mockResolvedValue({ events: [], complete: false });
  await act(async () => {
    await result.current.loadMore();
  });
  expect(pageCalls()).toEqual([{ relays: ['wss://alice.example/'], until: 500 }]);
});

it('closes both subscriptions on blur / unmount', () => {
  const { unmount } = renderHook(() => useProfileFeed(alice, 0));
  unmount();
  expect(closeMain).toHaveBeenCalled();
  expect(closeOutbox).toHaveBeenCalled();
});

it('keeps a full page stuck on the cursor second when stepping past it (#3)', async () => {
  const page = jest.mocked(fetchAuthorFeedPage);
  // A full page, all from the cursor's second, none seen yet.
  const sameSecond = Array.from({ length: 30 }, (_, i) => note(`s${i}`, 100));
  page.mockResolvedValueOnce({ events: sameSecond, complete: true });
  page.mockResolvedValueOnce({ events: [note('older', 50)], complete: false });
  const { result } = renderHook(() => useProfileFeed(alice, 0));
  act(() => {
    main.onEvent(note('seen', 100));
    main.onEose?.();
  });
  await act(async () => {
    await result.current.loadMore();
  });
  expect(pageCalls()).toEqual([
    { relays: ['wss://mine.example/'], until: 100 },
    { relays: ['wss://mine.example/'], until: 99 },
  ]);
  const ids = new Set(result.current.events.map((e) => e.id));
  for (let i = 0; i < 30; i++) expect(ids.has(`s${i}`)).toBe(true);
  expect(ids.has('older')).toBe(true);
  expect(result.current.reachedEnd).toBe(false);
});
