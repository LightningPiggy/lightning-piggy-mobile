import {
  createConversationLiveRefresh,
  LIVE_REFRESH_COALESCE_MS,
  LIVE_REFRESH_GAP_MS,
} from './conversationLiveRefresh';

describe('createConversationLiveRefresh', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = (trackGaps = true) => {
    const readStore = jest.fn();
    const fetchRelay = jest.fn();
    const live = createConversationLiveRefresh({
      readStore,
      fetchRelay,
      trackGaps,
      now: () => Date.now(),
    });
    return { live, readStore, fetchRelay };
  };

  it('answers a live message with a store read, not a relay fetch', () => {
    const { live, readStore, fetchRelay } = setup();
    live.onLiveMessage();
    live.onStoreCommit();
    jest.advanceTimersByTime(LIVE_REFRESH_GAP_MS * 2);
    expect(readStore).toHaveBeenCalledTimes(1);
    expect(fetchRelay).not.toHaveBeenCalled();
  });

  it('coalesces a burst of live messages and commits into one store read', () => {
    const { live, readStore } = setup();
    for (let i = 0; i < 5; i++) {
      live.onLiveMessage();
      live.onStoreCommit();
    }
    jest.advanceTimersByTime(LIVE_REFRESH_COALESCE_MS);
    expect(readStore).toHaveBeenCalledTimes(1);
    expect(live.counts()).toEqual({
      liveMessages: 5,
      storeCommits: 5,
      storeReads: 1,
      gapFetches: 0,
    });
  });

  it('does not treat a commit that landed just before the announcement as a gap', () => {
    const { live, fetchRelay } = setup();
    live.onStoreCommit();
    jest.advanceTimersByTime(50);
    live.onLiveMessage();
    jest.advanceTimersByTime(LIVE_REFRESH_GAP_MS * 2);
    expect(fetchRelay).not.toHaveBeenCalled();
  });

  it('fetches from the relays once when a live message never reaches the store', () => {
    const { live, readStore, fetchRelay } = setup();
    live.onLiveMessage();
    live.onLiveMessage();
    jest.advanceTimersByTime(LIVE_REFRESH_GAP_MS - 1);
    expect(fetchRelay).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fetchRelay).toHaveBeenCalledTimes(1);
    expect(readStore).toHaveBeenCalledTimes(1);
    expect(live.counts().gapFetches).toBe(1);
  });

  it('never falls back to the relays when gaps are not tracked', () => {
    const { live, readStore, fetchRelay } = setup(false);
    live.onLiveMessage();
    jest.advanceTimersByTime(LIVE_REFRESH_GAP_MS * 2);
    expect(readStore).toHaveBeenCalledTimes(1);
    expect(fetchRelay).not.toHaveBeenCalled();
  });

  it('does nothing after dispose', () => {
    const { live, readStore, fetchRelay } = setup();
    live.onLiveMessage();
    live.dispose();
    live.onStoreCommit();
    jest.advanceTimersByTime(LIVE_REFRESH_GAP_MS * 2);
    expect(readStore).not.toHaveBeenCalled();
    expect(fetchRelay).not.toHaveBeenCalled();
  });
});
