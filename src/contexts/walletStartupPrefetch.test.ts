/** The owner-hint prefetch never writes or deletes the hinted account's data (#1746). */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { prefetchWalletStates, takeWalletPrefetch } from './walletStartupPrefetch';

const wallets = [
  {
    id: 'w1',
    alias: 'w1',
    theme: 'lightning-piggy',
    order: 0,
    walletType: 'nwc',
    lightningAddress: null,
  },
];

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('wallet_list_hinted', JSON.stringify(wallets));
  jest.mocked(AsyncStorage.removeItem).mockClear();
  jest.mocked(AsyncStorage.setItem).mockClear();
});

it('leaves a corrupt tx cache in place and fails over to a full hydration', async () => {
  await AsyncStorage.setItem('txs_w1', '{corrupt');
  jest.mocked(AsyncStorage.setItem).mockClear();
  const prefetch = prefetchWalletStates('hinted');
  await expect(prefetch.result).resolves.toBeNull();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem('txs_w1')).toBe('{corrupt');
  // Even for the confirmed owner the prefetch is discarded, so the confirmed
  // owner's own hydration (which may clear the cache) runs instead.
  const fingerprints = { current: new Map<string, string>() };
  await expect(
    takeWalletPrefetch(
      prefetch,
      'hinted',
      wallets,
      fingerprints,
      async () => {},
      () => true,
    ),
  ).resolves.toBeNull();
});

it('does not touch storage when the hint names a different account', async () => {
  await AsyncStorage.setItem('txs_w1', '[]');
  jest.mocked(AsyncStorage.setItem).mockClear();
  const prefetch = prefetchWalletStates('hinted');
  await prefetch.result;
  const fingerprints = { current: new Map<string, string>() };
  const seed = jest.fn(async () => {});
  await expect(
    takeWalletPrefetch(prefetch, 'confirmed', [], fingerprints, seed, () => true),
  ).resolves.toBeNull();
  expect(seed).not.toHaveBeenCalled();
  expect(fingerprints.current.size).toBe(0);
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});
