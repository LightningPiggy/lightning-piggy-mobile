import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import type { Event } from 'nostr-tools/pure';
import {
  PERSIST_IDLE_MS,
  PERSIST_MAX_WAIT_MS,
  PERSIST_PENDING_RECORDS,
  __resetVerifiedEventCache,
  hydrateVerifiedEventCache,
  verifyEventCached,
} from './nostrVerifyCache';

// Persistence runs in the background, off the relay EOSE path (#1758), and
// must still happen: after a quiet period, within a max wait during a long
// ingest, at a pending-record threshold, and when the app leaves the foreground.
jest.mock('./nostrCrypto', () => ({
  nostrGetEventHash: (event: Event) => event.id,
  nostrVerifyEvent: jest.fn(() => true),
}));

const event = (n: number) =>
  ({
    id: (n % 256).toString(16).padStart(2, '0') + n.toString(16).padStart(62, '0'),
    sig: 'a'.repeat(128),
  }) as Event;
// The AsyncStorage jest mock is already a jest.fn: clear it, never restore it.
const setItem = jest.mocked(AsyncStorage.setItem);
// The cache registers its AppState listener lazily, on its first write.
const addListener = jest.spyOn(AppState, 'addEventListener');
const appStateChange = (state: AppStateStatus) => {
  const listener = addListener.mock.calls[0]?.[1] as (state: AppStateStatus) => void;
  listener(state);
};

let n = 0;
beforeEach(async () => {
  await AsyncStorage.clear();
  __resetVerifiedEventCache();
  // Hydration's paced yields are real timers: settle it before faking them.
  await hydrateVerifiedEventCache();
  jest.useFakeTimers();
  setItem.mockClear();
});
afterEach(() => {
  __resetVerifiedEventCache();
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('writes once verification has been quiet for PERSIST_IDLE_MS', async () => {
  expect(verifyEventCached(event(++n))).toBe(true);
  await jest.advanceTimersByTimeAsync(PERSIST_IDLE_MS - 10);
  expect(setItem).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(20);
  expect(setItem).toHaveBeenCalledTimes(1);
});

it('writes within PERSIST_MAX_WAIT_MS even while new records keep arriving', async () => {
  const every = PERSIST_IDLE_MS / 2;
  let elapsed = 0;
  while (!setItem.mock.calls.length && elapsed < 3 * PERSIST_MAX_WAIT_MS) {
    verifyEventCached(event(++n));
    await jest.advanceTimersByTimeAsync(every);
    elapsed += every;
  }
  expect(setItem).toHaveBeenCalled();
  expect(elapsed).toBeGreaterThanOrEqual(PERSIST_MAX_WAIT_MS);
  expect(elapsed).toBeLessThanOrEqual(PERSIST_MAX_WAIT_MS + every);
});

it('writes promptly once PERSIST_PENDING_RECORDS records are waiting', async () => {
  for (let i = 0; i < PERSIST_PENDING_RECORDS; i++) verifyEventCached(event(++n));
  await jest.advanceTimersByTimeAsync(50);
  expect(setItem.mock.calls.length).toBeGreaterThan(0);
});

it('writes immediately when the app leaves the foreground, not on resume', async () => {
  verifyEventCached(event(++n));
  appStateChange('active');
  await jest.advanceTimersByTimeAsync(0);
  expect(setItem).not.toHaveBeenCalled();
  appStateChange('background');
  await jest.advanceTimersByTimeAsync(0);
  expect(setItem).toHaveBeenCalledTimes(1);
  // Nothing left to write when the idle timer fires.
  await jest.advanceTimersByTimeAsync(PERSIST_MAX_WAIT_MS);
  expect(setItem).toHaveBeenCalledTimes(1);
});

it('persisted trust survives a restart', async () => {
  const known = event(++n);
  verifyEventCached(known);
  await jest.advanceTimersByTimeAsync(PERSIST_IDLE_MS + 10);
  __resetVerifiedEventCache();
  const hydrated = hydrateVerifiedEventCache();
  await jest.advanceTimersByTimeAsync(100);
  await hydrated;
  const { nostrVerifyEvent } = jest.requireMock('./nostrCrypto');
  jest.mocked(nostrVerifyEvent).mockClear();
  expect(verifyEventCached(known)).toBe(true);
  expect(nostrVerifyEvent).not.toHaveBeenCalled();
});
