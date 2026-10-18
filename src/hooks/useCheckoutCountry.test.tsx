import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCheckoutCountry } from './useCheckoutCountry';
import { wipeMarketAccount } from '../services/marketStorage';

let mockAccount: string | null = 'alice';
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => ({ pubkey: mockAccount }) }));
jest.mock('../data/countries', () => ({
  ...jest.requireActual('../data/countries'),
  deviceCountryCode: () => 'GB',
}));
beforeEach(() => {
  mockAccount = 'alice';
  jest.clearAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
});
it('defaults to the phone region, remembers a pick and restores it on the next visit', async () => {
  const h = renderHook(({ visible }: { visible: boolean }) => useCheckoutCountry(visible), {
    initialProps: { visible: true },
  });
  await act(async () => {});
  expect(h.result.current.countryCode).toBe('GB');
  await act(async () => h.result.current.selectCountry('DE'));
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith('market_checkout_country_v1_alice', 'DE');
  h.rerender({ visible: false });
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue('DE');
  h.rerender({ visible: true });
  await act(async () => {});
  expect(h.result.current.countryCode).toBe('DE');
});
it('isolates accounts and handles a missing or invalid saved country', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue('DE');
  const h = renderHook(() => useCheckoutCountry(true));
  await act(async () => {});
  expect(h.result.current.countryCode).toBe('DE');
  mockAccount = 'bob';
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue('Narnia');
  h.rerender({});
  expect(h.result.current.countryCode).toBe('GB');
  await act(async () => {});
  expect(h.result.current.countryCode).toBe('GB');
  expect(AsyncStorage.getItem).toHaveBeenLastCalledWith('market_checkout_country_v1_bob');
});
it('does not overwrite a user pick with a late hydration', async () => {
  let resolve!: (country: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const h = renderHook(() => useCheckoutCountry(true));
  await act(async () => {});
  await act(async () => h.result.current.selectCountry('FR'));
  await act(async () => resolve('DE'));
  expect(h.result.current.countryCode).toBe('FR');
});
it('does not show the previous account when its hydration finishes late', async () => {
  let resolve!: (country: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const h = renderHook(() => useCheckoutCountry(true));
  await act(async () => {});
  mockAccount = 'bob';
  h.rerender({});
  await act(async () => resolve('DE'));
  expect(h.result.current.countryCode).toBe('GB');
});
it('drains country writes before account wipe and rejects late writes', async () => {
  const h = renderHook(() => useCheckoutCountry(true));
  await act(async () => {});
  await act(async () => h.result.current.rememberCountry());
  await wipeMarketAccount('alice');
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith('market_checkout_country_v1_alice');
  (AsyncStorage.setItem as jest.Mock).mockClear();
  await act(async () => h.result.current.selectCountry('FR'));
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});
