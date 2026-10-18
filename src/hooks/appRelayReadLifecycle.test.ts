import { act, renderHook } from '@testing-library/react-native';
import { useMapAuthorCaches } from './useMapAuthorCaches';
import { useCacheDetailHydration } from './useCacheDetailHydration';
import { useMentionProfile } from './useMentionProfile';
import { useEmbeddedEvent } from './useEmbeddedEvent';
import { fetchCache, fetchCachesByAuthor } from '../services/nostrPlacesPublisher';
import { resolveEmbed } from '../services/nostrEmbedCache';
import { subscribeMentionProfile } from '../services/nostrMentionProfiles';
import {
  forgetAppRelayPrefs,
  loadAppRelayPrefs,
  setAppRelayEnabled,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { GC_RELAYS } from '../services/geocacheRelays';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';

const owner = 'a'.repeat(64);
const mockRelays = [{ url: 'wss://personal.example', read: true, write: true }];
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ relays: mockRelays }),
  useNostrContacts: () => ({ contacts: [] }),
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(callback, [callback]);
  },
}));
jest.mock('../services/nostrPlacesPublisher', () => ({
  fetchCache: jest.fn(async () => null),
  fetchCachesByAuthor: jest.fn(async () => []),
}));
jest.mock('../services/nostrPlacesStorage', () => ({ loadCachedCaches: async () => [] }));
jest.mock('../services/nostrMentionProfiles', () => ({
  peekMentionProfile: () => null,
  subscribeMentionProfile: jest.fn(() => jest.fn()),
}));
jest.mock('../services/nostrEmbedCache', () => ({
  peekEmbed: () => undefined,
  resolveEmbed: jest.fn(async () => ({ event: null })),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  await forgetAppRelayPrefs(owner);
  setCurrentUserPubkey(owner);
});
afterEach(() => setCurrentUserPubkey(null));

it('retries author/detail reads and cosmetic subscriptions despite identical personal relay URLs', async () => {
  const enqueue = jest.fn();
  const flush = jest.fn();
  const setCache = jest.fn();
  const setLoading = jest.fn();
  const setError = jest.fn();
  const { unmount } = renderHook(() => {
    useMapAuthorCaches({ pubkey: owner, relays: mockRelays, enqueue, flush });
    useCacheDetailHydration(`37516:${owner}:cache`, null, setCache, setLoading, setError);
    useMentionProfile(owner);
    useEmbeddedEvent({ raw: 'nostr:note', type: 'event', id: '1'.repeat(64), relays: [] });
  });
  await act(async () => {});
  expect(fetchCache).toHaveBeenCalledTimes(1);
  expect(fetchCachesByAuthor).toHaveBeenCalledTimes(1);
  const oldEmbedSignal = jest.mocked(resolveEmbed).mock.calls[0][2]!;
  const closeMention = jest.mocked(subscribeMentionProfile).mock.results[0].value;
  await act(async () => loadAppRelayPrefs(owner));
  expect(fetchCache).toHaveBeenCalledTimes(2);
  expect(fetchCachesByAuthor).toHaveBeenCalledTimes(2);
  expect(oldEmbedSignal.aborted).toBe(true);
  expect(closeMention).toHaveBeenCalled();
  await act(async () => setAppRelayEnabled(owner, 'geocache', GC_RELAYS[0], false));
  expect(fetchCache).toHaveBeenCalledTimes(3);
  expect(fetchCachesByAuthor).toHaveBeenCalledTimes(3);
  expect(jest.mocked(subscribeMentionProfile).mock.calls.at(-1)![3]).toEqual(
    expect.arrayContaining(RELAY_LIST_INDEXERS),
  );
  await act(async () => setAppRelayEnabled(owner, 'indexers', RELAY_LIST_INDEXERS[0], false));
  const fallbackRelays = jest.mocked(subscribeMentionProfile).mock.calls.at(-1)![3];
  expect(fallbackRelays).not.toContain(RELAY_LIST_INDEXERS[0]);
  expect(fallbackRelays).toContain('wss://personal.example');
  unmount();
});
