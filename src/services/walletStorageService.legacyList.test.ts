/** Deleting the legacy shared `wallet_list` once it is a stale duplicate (#1746). */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pruneMigratedLegacyWalletList } from './walletStorageService';

const MIGRATED_KEY = 'per_account_storage_migrated_v1';
const list = (...ids: string[]) => JSON.stringify(ids.map((id) => ({ id, walletType: 'nwc' })));

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(MIGRATED_KEY, 'true');
});

it('deletes a migrated legacy list whose wallets the account already owns, idempotently', async () => {
  await AsyncStorage.setItem('wallet_list', list('w1', 'w2'));
  await AsyncStorage.setItem('wallet_list_A', list('w1', 'w2', 'w3'));
  await AsyncStorage.setItem('txs_w1', '[]');
  await pruneMigratedLegacyWalletList('A');
  expect(await AsyncStorage.getItem('wallet_list')).toBeNull();
  // The account's own list and the per-wallet caches are untouched.
  expect(await AsyncStorage.getItem('wallet_list_A')).toBe(list('w1', 'w2', 'w3'));
  expect(await AsyncStorage.getItem('txs_w1')).toBe('[]');
  await expect(pruneMigratedLegacyWalletList('A')).resolves.toBeUndefined();
});

it('keeps a legacy list holding a wallet the account does not own', async () => {
  // e.g. one added while signed out after the migration ran.
  await AsyncStorage.setItem('wallet_list', list('w1', 'signed-out'));
  await AsyncStorage.setItem('wallet_list_A', list('w1'));
  await pruneMigratedLegacyWalletList('A');
  expect(await AsyncStorage.getItem('wallet_list')).toBe(list('w1', 'signed-out'));
});

it('keeps the legacy list before the per-account migration has completed', async () => {
  await AsyncStorage.removeItem(MIGRATED_KEY);
  await AsyncStorage.setItem('wallet_list', list('w1'));
  await AsyncStorage.setItem('wallet_list_A', list('w1'));
  await pruneMigratedLegacyWalletList('A');
  expect(await AsyncStorage.getItem('wallet_list')).toBe(list('w1'));
});

it('keeps a corrupt legacy list', async () => {
  await AsyncStorage.setItem('wallet_list', '{not json');
  await pruneMigratedLegacyWalletList('A');
  expect(await AsyncStorage.getItem('wallet_list')).toBe('{not json');
});
