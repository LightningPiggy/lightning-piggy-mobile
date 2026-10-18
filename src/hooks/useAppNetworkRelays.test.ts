import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppNetworkRelays } from './useAppNetworkRelays';
import {
  forgetAppRelayPrefs,
  loadAppRelayPrefs,
  setAppRelayEnabled,
} from '../services/appRelayPrefs';
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';

const owner = 'a'.repeat(64);
const empty: [] = [];
beforeEach(async () => {
  await forgetAppRelayPrefs(owner);
  await AsyncStorage.clear();
  await loadAppRelayPrefs(owner);
  setCurrentUserPubkey(owner);
});
afterEach(() => setCurrentUserPubkey(null));
it('keeps default relays available to public consumers while signed out', () => {
  setCurrentUserPubkey(null);
  const { result } = renderHook(() => useAppNetworkRelays(null, empty, empty));
  expect(result.current.map((r) => r.url)).toEqual(DEFAULT_RELAYS);
});
it('rebuilds the foreground relay set when a default is switched off and restored', async () => {
  const { result } = renderHook(() => useAppNetworkRelays(owner, empty, empty));
  expect(result.current.map((r) => r.url)).toContain(DEFAULT_RELAYS[0]);
  await act(async () => {
    await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], false);
  });
  expect(result.current.map((r) => r.url)).not.toContain(DEFAULT_RELAYS[0]);
  await act(async () => {
    await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], true);
  });
  expect(result.current.map((r) => r.url)).toContain(DEFAULT_RELAYS[0]);
});
it.each(['indexers', 'geocache', 'marmot', 'market'] as const)(
  'invalidates downstream plans for a %s preference change',
  async (group) => {
    const { result } = renderHook(() => useAppNetworkRelays(owner, empty, empty));
    const before = result.current;
    await act(async () => {
      await setAppRelayEnabled(owner, group, 'wss://app.example', false);
    });
    expect(result.current).not.toBe(before);
  },
);
