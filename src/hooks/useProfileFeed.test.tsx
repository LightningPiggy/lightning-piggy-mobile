import { act, renderHook } from '@testing-library/react-native';
import { useProfileFeed } from './useProfileFeed';
import { fetchAuthorFeedPage, subscribeAuthorFeed } from '../services/authorFeedService';

jest.mock('../services/authorFeedService', () => ({
  AUTHOR_FEED_PAGE_SIZE: 30,
  subscribeAuthorFeed: jest.fn(),
  fetchAuthorFeedPage: jest.fn(),
}));
const mockRelays = [{ url: 'wss://example.com', read: true, write: true }];
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => ({ relays: mockRelays }) }));
let mockFocused = true;
jest.mock('@react-navigation/native', () => {
  const R = jest.requireActual('react');
  return {
    // Runs the focus callback while "focused", and its cleanup on blur.
    useFocusEffect: (cb: () => void | (() => void)) =>
      R.useEffect(() => (mockFocused ? cb() : undefined), [cb, mockFocused]),
  };
});

const PK = 'a'.repeat(64);
const subscribe = subscribeAuthorFeed as jest.Mock;
const fetchPage = fetchAuthorFeedPage as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  mockFocused = true;
  subscribe.mockReset();
  fetchPage.mockReset();
  subscribe.mockImplementation(({ onEvent, onEose }) => {
    onEvent({ id: 'e1', pubkey: PK, kind: 1, created_at: 100, content: '', tags: [] });
    onEose();
    return jest.fn();
  });
});
afterEach(() => jest.useRealTimers());

it('aborts a page request on blur and stays idle until the next focus', async () => {
  let settle!: (v: unknown) => void;
  fetchPage.mockImplementation(() => new Promise((r) => (settle = r)));
  const h = renderHook(() => useProfileFeed(PK, 0));
  await act(async () => {
    jest.advanceTimersByTime(200); // coalesced flush
  });
  expect(h.result.current.events).toHaveLength(1);

  act(() => {
    void h.result.current.loadMore();
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  const { signal } = fetchPage.mock.calls[0][0];

  // Blur mid-request: the request is aborted…
  mockFocused = false;
  h.rerender({});
  expect(signal.aborted).toBe(true);
  // …and once it settles (clearing `loadingMore`), nothing re-arms it.
  await act(async () => settle({ events: [], complete: true }));
  await act(async () => {
    await h.result.current.loadMore();
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(h.result.current.reachedEnd).toBe(false);

  // A new focus session may page again.
  fetchPage.mockResolvedValue({ events: [], complete: false });
  mockFocused = true;
  h.rerender({});
  await act(async () => {
    await h.result.current.loadMore();
  });
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

it('keeps paging retryable after an incomplete empty page', async () => {
  fetchPage.mockResolvedValue({ events: [], complete: false });
  const h = renderHook(() => useProfileFeed(PK, 0));
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {
    await h.result.current.loadMore();
  });
  expect(h.result.current.reachedEnd).toBe(false);
  fetchPage.mockResolvedValue({ events: [], complete: true });
  await act(async () => {
    await h.result.current.loadMore();
  });
  expect(h.result.current.reachedEnd).toBe(true);
});

it('hides non-note comments but still pages past them (#1337)', async () => {
  const note = '7'.repeat(64);
  subscribe.mockImplementation(({ onEvent, onEose }) => {
    onEvent({ id: 'e1', pubkey: PK, kind: 1, created_at: 100, content: '', tags: [] });
    onEvent({
      id: 'c1',
      pubkey: PK,
      kind: 1111,
      created_at: 90,
      content: 'reply',
      tags: [
        ['E', note],
        ['K', '1'],
      ],
    });
    onEvent({
      id: 'p1',
      pubkey: PK,
      kind: 1111,
      created_at: 80,
      content: 'nice socks',
      tags: [
        ['A', `30402:${PK}:socks`],
        ['K', '30402'],
      ],
    });
    onEose();
    return jest.fn();
  });
  fetchPage.mockResolvedValue({ events: [], complete: false });
  const h = renderHook(() => useProfileFeed(PK, 0));
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  expect(h.result.current.events.map((e) => e.id)).toEqual(['e1', 'c1']);
  // Paging eligibility counts hidden events too.
  expect(h.result.current.fetchedCount).toBe(3);
  await act(async () => {
    await h.result.current.loadMore();
  });
  // The hidden product comment is the oldest fetched event: the cursor.
  expect(fetchPage.mock.calls[0][0].until).toBe(80);
});

it('shows "no posts" rather than unavailable when one relay answered and another stays silent', async () => {
  subscribe.mockImplementation(({ onAnswered }) => {
    onAnswered(); // one relay: real EOSE, nothing stored; the other never replies
    return jest.fn();
  });
  const h = renderHook(() => useProfileFeed(PK, 0));
  expect(h.result.current.loading).toBe(true);
  await act(async () => {
    jest.advanceTimersByTime(6000); // the grace period ends
  });
  expect(h.result.current.loading).toBe(false);
  expect(h.result.current.unavailable).toBe(false);
  expect(h.result.current.events).toHaveLength(0);
});

it('is unavailable when no relay answered within the grace period', async () => {
  subscribe.mockImplementation(() => jest.fn());
  const h = renderHook(() => useProfileFeed(PK, 0));
  await act(async () => {
    jest.advanceTimersByTime(6000);
  });
  expect(h.result.current.unavailable).toBe(true);
});
