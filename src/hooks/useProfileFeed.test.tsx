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

it('a done signal with no real answer (failed / timed-out relays) stays unavailable', async () => {
  subscribe.mockImplementation(({ onEose }) => {
    setTimeout(onEose, 7000); // after the grace period, no relay ever answered
    return jest.fn();
  });
  const h = renderHook(() => useProfileFeed(PK, 0));
  await act(async () => {
    jest.advanceTimersByTime(7000);
  });
  expect(h.result.current.loading).toBe(false);
  expect(h.result.current.unavailable).toBe(true);
});

it('recovers from unavailable on a late answer, a late post, or a retry', async () => {
  let handlers!: {
    onEvent: (e: unknown) => void;
    onAnswered: () => void;
    onUnavailable: () => void;
  };
  subscribe.mockImplementation((input) => {
    handlers = input;
    return jest.fn();
  });
  const h = renderHook(({ nonce }: { nonce: number }) => useProfileFeed(PK, nonce), {
    initialProps: { nonce: 0 },
  });
  act(() => handlers.onUnavailable());
  expect(h.result.current.unavailable).toBe(true);
  act(() => handlers.onAnswered()); // a slow relay answers after all
  expect(h.result.current.unavailable).toBe(false);

  act(() => handlers.onUnavailable());
  act(() =>
    handlers.onEvent({ id: 'late', pubkey: PK, kind: 1, created_at: 1, content: '', tags: [] }),
  );
  expect(h.result.current.unavailable).toBe(false);

  act(() => handlers.onUnavailable());
  h.rerender({ nonce: 1 }); // pull to refresh
  expect(h.result.current.unavailable).toBe(false);
  expect(h.result.current.loading).toBe(true);
  expect(subscribe).toHaveBeenCalledTimes(2);
});

it('does not flash the spinner when refocusing a profile that already answered', async () => {
  subscribe.mockImplementation(({ onAnswered, onEose }) => {
    onAnswered(); // a real answer: this profile has no posts
    onEose();
    return jest.fn();
  });
  const h = renderHook(() => useProfileFeed(PK, 0));
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  expect(h.result.current.loading).toBe(false);
  subscribe.mockImplementation(() => jest.fn()); // the refocus attempt hasn't answered yet
  mockFocused = false;
  h.rerender({});
  mockFocused = true;
  h.rerender({});
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(h.result.current.loading).toBe(false); // still "No posts yet", no spinner
});

it('shows the spinner again after an answered profile later fails to load', async () => {
  subscribe.mockImplementation(({ onAnswered, onEose }) => {
    onAnswered();
    onEose();
    return jest.fn();
  });
  const h = renderHook(() => useProfileFeed(PK, 0));
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  // The next attempt never answers: after the grace period it's unavailable...
  subscribe.mockImplementation(() => jest.fn());
  mockFocused = false;
  h.rerender({});
  mockFocused = true;
  h.rerender({});
  await act(async () => {
    jest.advanceTimersByTime(6000);
  });
  expect(h.result.current.unavailable).toBe(true);
  // ...and the attempt after that shows the spinner, not the stale state.
  mockFocused = false;
  h.rerender({});
  mockFocused = true;
  h.rerender({});
  expect(h.result.current.loading).toBe(true);
  expect(h.result.current.unavailable).toBe(false);
});
