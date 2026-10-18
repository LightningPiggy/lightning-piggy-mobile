import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MAX_REMEMBERED_CHARS,
  checkoutAddressGeneration,
  checkoutAddressKey,
  readCheckoutAddress,
  rememberCheckoutAddress,
  wipeCheckoutAddress,
} from './checkoutAddressStorage';
const mockDisk = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => mockDisk.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockDisk.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockDisk.delete(key);
  }),
}));
const fields = {
  name: 'Private buyer',
  line1: 'Private street',
  line2: '',
  town: 'London',
  postcode: 'SW1A 1AA',
};
beforeEach(() => {
  mockDisk.clear();
  jest.clearAllMocks();
});
it('remember off writes nothing; opt-in uses SecureStore only', async () => {
  await rememberCheckoutAddress('a', fields, false);
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  await rememberCheckoutAddress('a', fields, true);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    checkoutAddressKey('a'),
    JSON.stringify(fields),
    { keychainAccessible: 'afterFirstUnlockThisDeviceOnly' },
  );
  expect(await readCheckoutAddress('a')).toEqual(fields);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});
it('wipes only the departing account and rejects a submit captured before its wipe', async () => {
  const epoch = checkoutAddressGeneration('a');
  await rememberCheckoutAddress('a', fields, true);
  await rememberCheckoutAddress('b', fields, true);
  await wipeCheckoutAddress('a');
  await rememberCheckoutAddress('a', fields, true, epoch);
  expect(await readCheckoutAddress('a')).toBeNull();
  expect(await readCheckoutAddress('b')).toEqual(fields);
});
it('drains a native write before deleting the address', async () => {
  let release!: () => void;
  let started!: () => void;
  const paused = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
    started();
    await resume;
    mockDisk.set(key, value);
  });
  const write = rememberCheckoutAddress('a', fields, true);
  await paused;
  const wipe = wipeCheckoutAddress('a');
  release();
  await Promise.all([write, wipe]);
  expect(await readCheckoutAddress('a')).toBeNull();
});

it("doesn't remember an address too long for secure storage", async () => {
  (SecureStore.setItemAsync as jest.Mock).mockClear();
  const huge = { ...fields, line2: 'x'.repeat(MAX_REMEMBERED_CHARS) };
  await rememberCheckoutAddress('big', huge, true);
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});
