import { act, renderHook } from '@testing-library/react-native';
import { useLiveLocationThread, type ThreadLiveMarker } from './useConversationLiveLocation';
import {
  LIVE_UPDATE_FLUSH_MS,
  clearLiveUpdates,
  ingestLiveUpdate,
} from '../services/liveLocationUpdateStore';
import type { LiveLocationMarker } from '../services/liveLocationService';

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('../contexts/LiveLocationContext', () => ({
  useLiveLocation: () => ({ sessionsByRecipient: new Map(), remainingMsForSession: () => null }),
}));
jest.mock('./useLiveUpdates', () => ({
  ...jest.requireActual('./useLiveUpdates'),
  useLiveUpdateRelaySubscriptions: jest.fn(),
}));

const PEER = 'b'.repeat(64);
const start = (startedAt: number): ThreadLiveMarker => ({
  fromMe: false,
  sender: PEER,
  createdAt: Math.floor(startedAt / 1000),
  marker: {
    phase: 'start',
    sessionId: 's1',
    startedAt,
    durationMs: 15 * 60_000,
    location: { lat: 1, lon: 1, accuracyMeters: null },
    v2: true,
  } as LiveLocationMarker,
});
const coordlessEnd: ThreadLiveMarker = {
  fromMe: false,
  sender: PEER,
  createdAt: 2,
  marker: { phase: 'end', sessionId: 's1', startedAt: 0, durationMs: 0, location: null, v2: true },
};

let renders = 0;
function render(markers: ThreadLiveMarker[]) {
  renders = 0;
  return renderHook(
    ({ m }: { m: ThreadLiveMarker[] }) => {
      renders++;
      return useLiveLocationThread({
        markers: m,
        threadKey: PEER,
        marmot: true,
        isLoggedIn: true,
        myPubkey: 'a'.repeat(64),
        signerType: 'nsec',
        relays: [],
      });
    },
    { initialProps: { m: markers } },
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  clearLiveUpdates();
});
afterEach(() => jest.useRealTimers());

const update = (lat: number) =>
  act(() => {
    ingestLiveUpdate(PEER, {
      lat,
      lon: 2,
      accuracy: null,
      heading: null,
      ts: Date.now(),
      sessionId: 's1',
    });
    jest.advanceTimersByTime(LIVE_UPDATE_FLUSH_MS);
  });

it('keeps the last received fix after the share expires', () => {
  const markers = [start(Date.now())];
  const { result } = render(markers);
  update(51.5);
  expect(result.current.liveLocationLatest.s1?.location.lat).toBe(51.5);
  // 20 min later the 15 min share has expired (and stops being subscribed).
  act(() => jest.advanceTimersByTime(20 * 60_000));
  expect(result.current.liveLocationBubbleStatus.s1).toBe('ended');
  expect(result.current.liveLocationLatest.s1?.location.lat).toBe(51.5);
});

it('keeps the last received fix when the end marker carries no coordinates', () => {
  const markers = [start(Date.now())];
  const { result, rerender } = render(markers);
  update(51.6);
  rerender({ m: [...markers, coordlessEnd] });
  expect(result.current.liveLocationBubbleStatus.s1).toBe('ended');
  expect(result.current.liveLocationLatest.s1?.location.lat).toBe(51.6);
});

// #1792: the 1 Hz tick re-renders the whole thread; it must only run while a
// share is actually live, not just because a bubble exists in the history.
const rendersOver = (ms: number) => {
  const before = renders;
  // One act per second — a single act would batch every tick into one render.
  for (let s = 0; s < ms / 1000; s++) act(() => jest.advanceTimersByTime(1000));
  return renders - before;
};

describe('1 Hz tick (#1792)', () => {
  it('does not tick on a thread whose only share has expired', () => {
    render([start(Date.now() - 20 * 60_000)]);
    expect(rendersOver(10_000)).toBe(0);
  });

  it('does not tick on a thread whose only share has ended', () => {
    render([start(Date.now()), coordlessEnd]);
    expect(rendersOver(10_000)).toBe(0);
  });

  it('ticks once a second while a share is running', () => {
    render([start(Date.now())]);
    expect(rendersOver(10_000)).toBe(10);
  });

  it('stops by itself once the last running share expires', () => {
    const { result } = render([start(Date.now() - 15 * 60_000 + 3_000)]);
    // Ticks up to (and including) the second the share crosses its expiry…
    expect(rendersOver(5_000)).toBe(3);
    expect(result.current.liveLocationBubbleStatus.s1).toBe('ended');
    // …then goes quiet with no further event.
    expect(rendersOver(10_000)).toBe(0);
  });

  it('restarts when a new share begins', () => {
    const expired = start(Date.now() - 20 * 60_000);
    const { rerender } = render([expired]);
    expect(rendersOver(5_000)).toBe(0);
    const fresh = start(Date.now());
    rerender({ m: [expired, { ...fresh, marker: { ...fresh.marker, sessionId: 's2' } }] });
    expect(rendersOver(10_000)).toBe(10);
  });
});
