import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { syncBackgroundDmWatchFromPreference } from './backgroundDmService';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { perAccountKey } from './perAccountStorage';
import {
  APP_RELAY_PREFS_KEY,
  enabledAppRelays,
  forgetAppRelayPrefs,
  isAppRelayEnabled,
  loadAppRelayPrefs,
  setAppRelayEnabled,
  subscribeAppRelayPrefs,
  type AppRelayGroup,
} from './appRelayPrefs';

jest.mock('./backgroundDmService', () => ({
  syncBackgroundDmWatchFromPreference: jest.fn().mockResolvedValue(undefined),
}));

const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);
const relays = ['wss://one.example', 'wss://two.example'];
beforeEach(async () => {
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(alice);
  await forgetAppRelayPrefs(bob);
  await AsyncStorage.clear();
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.mocked(syncBackgroundDmWatchFromPreference).mockClear();
});
afterEach(() => jest.restoreAllMocks());

it.each<AppRelayGroup>(['default', 'indexers', 'geocache', 'marmot', 'market'])(
  'persists and filters %s independently per account',
  async (group) => {
    await loadAppRelayPrefs(alice);
    expect(enabledAppRelays(group, relays, alice)).toEqual(relays);
    await setAppRelayEnabled(alice, group, relays[0] + '/', false);
    expect(enabledAppRelays(group, relays, alice)).toEqual([relays[1]]);
    expect(isAppRelayEnabled(alice, group, relays[0])).toBe(false);
    expect(
      JSON.parse((await AsyncStorage.getItem(perAccountKey(APP_RELAY_PREFS_KEY, alice)))!)[group],
    ).toEqual([relays[0]]);
    await forgetAppRelayPrefs(alice);
    await loadAppRelayPrefs(alice);
    await loadAppRelayPrefs(bob);
    expect(enabledAppRelays(group, relays, alice)).toEqual([relays[1]]);
    expect(enabledAppRelays(group, relays, bob)).toEqual(relays);
    setCurrentUserPubkey(alice);
    expect(enabledAppRelays(group, relays)).toEqual([relays[1]]);
    await setAppRelayEnabled(alice, group, relays[0], true);
    expect(enabledAppRelays(group, relays)).toEqual(relays);
  },
);
it('keeps unknown account defaults closed until hydration, and handles malformed storage', async () => {
  expect(enabledAppRelays('default', relays, alice)).toEqual([]);
  await AsyncStorage.setItem(perAccountKey(APP_RELAY_PREFS_KEY, alice), '{broken');
  await loadAppRelayPrefs(alice);
  expect(enabledAppRelays('default', relays, alice)).toEqual(relays);
});
it('serializes rapid toggles and notifies only after persistence', async () => {
  await loadAppRelayPrefs(alice);
  const listener = jest.fn();
  const off = subscribeAppRelayPrefs(listener);
  await Promise.all([
    setAppRelayEnabled(alice, 'market', relays[0], false),
    setAppRelayEnabled(alice, 'market', relays[0], true),
  ]);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(enabledAppRelays('market', relays, alice)).toEqual(relays);
  off();
});
it('keeps lockdown authoritative even with every preference off', async () => {
  const test = [...TEST_ACCOUNT_PUBKEYS][0];
  for (const group of ['default', 'indexers', 'geocache', 'marmot', 'market'] as const) {
    for (const url of relays) await setAppRelayEnabled(test, group, url, false);
    expect(enabledAppRelays(group, relays, test)).toEqual([TEST_RELAY_URL]);
    expect(enabledAppRelays(group, [], test)).toEqual([TEST_RELAY_URL]);
  }
  await forgetAppRelayPrefs(test);
});
it('allows an empty group without restoring fallback relays', async () => {
  for (const url of relays) await setAppRelayEnabled(alice, 'market', url, false);
  expect(enabledAppRelays('market', relays, alice)).toEqual([]);
});

it('uses one preference set for different pubkey casing', async () => {
  await setAppRelayEnabled(alice.toUpperCase(), 'default', relays[0], false);
  expect(enabledAppRelays('default', relays, alice)).toEqual([relays[1]]);
  expect(enabledAppRelays('default', relays, alice.toUpperCase())).toEqual([relays[1]]);
});

it('preserves the list identity when no filtering is needed', async () => {
  expect(enabledAppRelays('default', relays, null)).toBe(relays);
  await loadAppRelayPrefs(alice);
  expect(enabledAppRelays('default', relays, alice)).toBe(relays);
});

it('syncs the background watch with persisted default preferences on disable and enable', async () => {
  setCurrentUserPubkey(alice);
  const observed: string[][] = [];
  const persisted: string[][] = [];
  jest.mocked(syncBackgroundDmWatchFromPreference).mockImplementation(async () => {
    observed.push([...enabledAppRelays('default', relays, alice)]);
    const stored = JSON.parse(
      (await AsyncStorage.getItem(perAccountKey(APP_RELAY_PREFS_KEY, alice)))!,
    );
    persisted.push(stored.default);
  });
  await setAppRelayEnabled(alice.toUpperCase(), 'default', relays[0], false);
  await setAppRelayEnabled(alice, 'default', relays[0], true);
  expect(observed).toEqual([[relays[1]], relays]);
  expect(persisted).toEqual([[relays[0]], []]);
  jest.mocked(syncBackgroundDmWatchFromPreference).mockResolvedValue(undefined);
});

it('does not sync for other groups, inactive accounts, or iOS', async () => {
  setCurrentUserPubkey(alice);
  for (const group of ['indexers', 'geocache', 'marmot', 'market'] as const) {
    await setAppRelayEnabled(alice, group, relays[0], false);
  }
  await setAppRelayEnabled(bob, 'default', relays[0], false);
  jest.replaceProperty(Platform, 'OS', 'ios');
  await setAppRelayEnabled(alice, 'default', relays[0], false);
  expect(syncBackgroundDmWatchFromPreference).not.toHaveBeenCalled();
});

it('does not sync or change the live plan when persistence fails', async () => {
  setCurrentUserPubkey(alice);
  await loadAppRelayPrefs(alice);
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage failed'));
  await expect(setAppRelayEnabled(alice, 'default', relays[0], false)).rejects.toThrow(
    'storage failed',
  );
  expect(enabledAppRelays('default', relays, alice)).toEqual(relays);
  expect(syncBackgroundDmWatchFromPreference).not.toHaveBeenCalled();
});

it('retries failed hydration from ordinary reads, coalesces retries, and keeps disabled relays closed', async () => {
  await AsyncStorage.setItem(
    perAccountKey(APP_RELAY_PREFS_KEY, alice),
    JSON.stringify({ default: [relays[0]] }),
  );
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  const read = jest
    .spyOn(AsyncStorage, 'getItem')
    .mockClear()
    .mockRejectedValueOnce(new Error('offline'));
  await expect(loadAppRelayPrefs(alice)).rejects.toThrow('offline');
  expect(enabledAppRelays('default', relays, alice)).toEqual([]);
  expect(read).toHaveBeenCalledTimes(1);
  now.mockReturnValue(2000);
  let resolveRead!: (raw: string | null) => void;
  read.mockImplementationOnce(() => new Promise((resolve) => (resolveRead = resolve)));
  const listener = jest.fn();
  const unsubscribe = subscribeAppRelayPrefs(listener);
  expect(enabledAppRelays('default', relays, alice.toUpperCase())).toEqual([]);
  expect(enabledAppRelays('default', relays, alice)).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
  resolveRead(JSON.stringify({ default: [relays[0]] }));
  await loadAppRelayPrefs(alice);
  expect(enabledAppRelays('default', relays, alice)).toEqual([relays[1]]);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});

it('backs off repeated storage failures and forgetting an account cancels read-triggered retries', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  const read = jest
    .spyOn(AsyncStorage, 'getItem')
    .mockClear()
    .mockRejectedValue(new Error('offline'));
  await expect(loadAppRelayPrefs(alice)).rejects.toThrow('offline');
  now.mockReturnValue(2000);
  expect(enabledAppRelays('default', relays, alice)).toEqual([]);
  await expect(loadAppRelayPrefs(alice)).rejects.toThrow('offline');
  expect(enabledAppRelays('default', relays, alice)).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
  await forgetAppRelayPrefs(alice);
  now.mockReturnValue(4000);
  expect(enabledAppRelays('default', relays, alice)).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
});
