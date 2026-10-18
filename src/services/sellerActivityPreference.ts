import AsyncStorage from '@react-native-async-storage/async-storage';
import { perAccountKey } from './perAccountStorage';
const key = (owner: string) => perAccountKey('seller_activity_enabled_v1', owner);
export const loadSellerActivityEnabled = async (owner: string): Promise<boolean> =>
  (await AsyncStorage.getItem(key(owner))) !== '0';
export const setSellerActivityEnabled = (owner: string, enabled: boolean): Promise<void> =>
  AsyncStorage.setItem(key(owner), enabled ? '1' : '0');
