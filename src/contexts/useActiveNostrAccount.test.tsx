import { enabledAppRelays, forgetAppRelayPrefs } from '../services/appRelayPrefs';
import { perAccountKey } from '../services/perAccountStorage';
import { APP_RELAY_PREFS_KEY } from '../services/appRelayPrefs';
import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buyerOrderTitleGeneration,
  loadBuyerOrderTitles,
  recordBuyerOrderTitles,
  retireBuyerOrderTitles,
} from '../services/buyerOrderTitles';
import { useActiveNostrAccount } from './useActiveNostrAccount';
import { useNip65Relays } from './useNip65Relays';
import { fetchRelayListEvent } from '../services/nostrService';
import { fetchLatestReplaceable } from '../services/nostrRelayLists';

jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: ['wss://disabled.example', 'wss://ok.example'],
  fetchRelayListEvent: jest.fn(),
}));
jest.mock('../services/nostrRelayLists', () => ({
  fetchLatestReplaceable: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/backgroundDmService', () => ({
  rearmBackgroundDmWatchForActiveIdentity: jest.fn().mockResolvedValue(undefined),
}));

let mockCurrentPubkey: string | null = null;
jest.mock('../services/nostrActiveAccount', () => ({
  setCurrentUserPubkey: jest.fn((pk: string | null) => (mockCurrentPubkey = pk)),
  getCurrentUserPubkey: () => mockCurrentPubkey,
}));
jest.mock('../services/walletStorageService', () => ({
  setActivePubkeyForWalletStorage: jest.fn(),
}));

const getItem = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;
beforeEach(() => jest.mocked(AsyncStorage.getItem).mockImplementation(getItem));

it('revives titles only for the activated account, retaining stale-checkout invalidation', async () => {
  await AsyncStorage.clear();
  const generation = buyerOrderTitleGeneration('buyer');
  retireBuyerOrderTitles('buyer');
  retireBuyerOrderTitles('other');
  const { result } = renderHook(() => useActiveNostrAccount());
  act(() => result.current[1](null));
  await recordBuyerOrderTitles('buyer', 'signed-out', { item: 'Private purchase' });
  expect(await loadBuyerOrderTitles('buyer')).toEqual({});
  act(() => result.current[1]('buyer'));
  await recordBuyerOrderTitles('buyer', 'stale', { item: 'Private purchase' }, generation);
  await recordBuyerOrderTitles('buyer', 'new', { item: 'New purchase' });
  await recordBuyerOrderTitles('other', 'other', { item: 'Other purchase' });
  expect(await loadBuyerOrderTitles('buyer')).toEqual({ new: { item: 'New purchase' } });
  expect(await loadBuyerOrderTitles('other')).toEqual({});
});

it('recovers active-account relay hydration without another read and cancels retries on switch', async () => {
  jest.useFakeTimers();
  const owner = 'retry-owner';
  const key = perAccountKey(APP_RELAY_PREFS_KEY, owner);
  await forgetAppRelayPrefs(owner);
  const read = jest.spyOn(AsyncStorage, 'getItem');
  read.mockRejectedValueOnce(new Error('storage unavailable'));
  const rediscover = jest.fn().mockResolvedValue([]);
  const { result, unmount } = renderHook(() => useActiveNostrAccount(rediscover));
  try {
    await act(async () => result.current[1](owner));
    expect(enabledAppRelays('default', ['wss://disabled.example'], owner)).toEqual([]);
    await AsyncStorage.setItem(key, JSON.stringify({ default: ['wss://disabled.example'] }));
    await act(async () => jest.advanceTimersByTimeAsync(3000));
    expect(
      enabledAppRelays('default', ['wss://disabled.example', 'wss://ok.example'], owner),
    ).toEqual(['wss://ok.example']);
    expect(read.mock.calls.filter(([storageKey]) => storageKey === key)).toHaveLength(2);
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(rediscover).toHaveBeenCalledWith(owner);
    await forgetAppRelayPrefs(owner);
    read.mockRejectedValueOnce(new Error('storage unavailable'));
    await act(async () => result.current[1](null));
    await act(async () => result.current[1](owner));
    await act(async () => result.current[1](null));
    const before = read.mock.calls.length;
    await act(async () => jest.advanceTimersByTimeAsync(6000));
    expect(read).toHaveBeenCalledTimes(before);
    expect(rediscover).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
    read.mockRestore();
    await forgetAppRelayPrefs(owner);
    jest.useRealTimers();
  }
});

it('rediscovers personal read/write relays after failed preference hydration recovers', async () => {
  jest.useFakeTimers();
  const owner = 'discovery-retry-owner';
  const key = perAccountKey(APP_RELAY_PREFS_KEY, owner);
  await AsyncStorage.clear();
  await forgetAppRelayPrefs(owner);
  await AsyncStorage.setItem(key, JSON.stringify({ default: ['wss://disabled.example'] }));
  const personal = [
    { url: 'wss://personal-read.example', read: true, write: false },
    { url: 'wss://personal-write.example', read: false, write: true },
  ];
  const fetchList = jest.mocked(fetchRelayListEvent);
  fetchList.mockImplementation(async (_pk, relays) =>
    relays.length ? { list: personal, createdAt: 100 } : null,
  );
  fetchList.mockClear();
  jest.mocked(fetchLatestReplaceable).mockClear();
  const read = jest.spyOn(AsyncStorage, 'getItem');
  read.mockRejectedValueOnce(new Error('storage unavailable'));
  const { result, unmount } = renderHook(() => {
    const relays = useNip65Relays();
    const [pubkey, setPubkey] = useActiveNostrAccount(relays.loadRelays);
    return { ...relays, pubkey, setPubkey };
  });
  try {
    await act(async () => result.current.setPubkey(owner));
    await act(async () => {
      await result.current.loadRelays(owner);
    });
    expect(fetchList).toHaveBeenLastCalledWith(owner, []);
    expect(result.current.nip65Relays).toEqual([]);

    await act(async () => jest.advanceTimersByTimeAsync(3000));

    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(fetchList).toHaveBeenLastCalledWith(owner, ['wss://ok.example']);
    expect(result.current.nip65Relays).toEqual(personal);
    expect(jest.mocked(fetchLatestReplaceable).mock.calls.at(-1)?.[2]).toContain(
      'wss://personal-write.example',
    );
    expect(jest.mocked(fetchLatestReplaceable).mock.calls.at(-1)?.[2]).not.toContain(
      'wss://disabled.example',
    );
  } finally {
    unmount();
    read.mockRestore();
    await forgetAppRelayPrefs(owner);
    jest.useRealTimers();
  }
});

it('does not rediscover relays when hydration completes after the account leaves', async () => {
  const owner = 'stale-hydration-owner';
  await forgetAppRelayPrefs(owner);
  let finish!: (raw: string | null) => void;
  const read = jest
    .spyOn(AsyncStorage, 'getItem')
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const rediscover = jest.fn().mockResolvedValue([]);
  const { result, unmount } = renderHook(() => useActiveNostrAccount(rediscover));
  try {
    await act(async () => result.current[1](owner));
    await act(async () => result.current[1](null));
    await act(async () => finish(null));
    expect(rediscover).not.toHaveBeenCalled();
  } finally {
    unmount();
    read.mockRestore();
    await forgetAppRelayPrefs(owner);
  }
});
