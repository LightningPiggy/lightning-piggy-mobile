import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadSellerActivityEnabled, setSellerActivityEnabled } from './sellerActivityPreference';
it('defaults on, persists explicit choices and keeps them per account', async () => {
  await AsyncStorage.clear();
  expect(await loadSellerActivityEnabled('a')).toBe(true);
  await setSellerActivityEnabled('a', false);
  expect(await loadSellerActivityEnabled('a')).toBe(false);
  expect(await loadSellerActivityEnabled('b')).toBe(true);
  await setSellerActivityEnabled('a', true);
  expect(await loadSellerActivityEnabled('a')).toBe(true);
});
