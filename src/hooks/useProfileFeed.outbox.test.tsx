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

it("pages older posts from the union of the viewer's and the author's relays", async () => {
  jest.mocked(fetchAuthorFeedPage).mockResolvedValue({ events: [], complete: true });
  const { result } = renderHook(() => useProfileFeed(alice, 0));
  act(() => {
    main.onEvent(note('mine', 2));
    main.onEose?.();
    outbox.onRelays?.(['wss://alice.example/']);
  });
  await act(async () => {
    await result.current.loadMore();
  });
  expect(jest.mocked(fetchAuthorFeedPage).mock.calls[0][0]).toMatchObject({
    authorPubkey: alice,
    relays: ['wss://mine.example/', 'wss://alice.example/'],
    until: 2,
  });
});

it('closes both subscriptions on blur / unmount', () => {
  const { unmount } = renderHook(() => useProfileFeed(alice, 0));
  unmount();
  expect(closeMain).toHaveBeenCalled();
  expect(closeOutbox).toHaveBeenCalled();
});
