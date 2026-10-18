import { act, renderHook } from '@testing-library/react-native';
import { useCheckoutAddress } from './useCheckoutAddress';
import { readCheckoutAddress, rememberCheckoutAddress } from '../services/checkoutAddressStorage';
import type { DeliveryAddress } from '../utils/deliveryAddress';
let mockAccount = 'alice';
let mockName = 'Nostr nickname';
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockAccount, profile: { displayName: mockName } }),
}));
jest.mock('../services/checkoutAddressStorage', () => ({
  readCheckoutAddress: jest.fn(async () => null),
  rememberCheckoutAddress: jest.fn(async () => {}),
  checkoutAddressGeneration: () => 0,
}));
const saved: DeliveryAddress = {
  name: 'Saved nickname',
  line1: 'Private lane',
  line2: '',
  town: 'Town',
  postcode: '90210',
};
beforeEach(() => {
  mockAccount = 'alice';
  mockName = 'Nostr nickname';
  jest.clearAllMocks();
  jest.mocked(readCheckoutAddress).mockResolvedValue(null);
});
it('prefills an editable display name and starts each visit with remembering off', async () => {
  const h = renderHook(({ visible }: { visible: boolean }) => useCheckoutAddress(visible), {
    initialProps: { visible: true },
  });
  await act(async () => {});
  expect(h.result.current.fields.name).toBe(mockName);
  expect(h.result.current.remember).toBe(false);
  act(() => h.result.current.changeField('name', 'Letterbox nickname'));
  mockName = 'Updated profile';
  h.rerender({ visible: true });
  expect(h.result.current.fields.name).toBe('Letterbox nickname');
  act(() => h.result.current.toggleRemember());
  await act(async () => h.result.current.save());
  expect(rememberCheckoutAddress).toHaveBeenLastCalledWith(
    'alice',
    expect.objectContaining({ name: 'Letterbox nickname' }),
    true,
    0,
  );
  h.rerender({ visible: false });
  h.rerender({ visible: true });
  await act(async () => {});
  expect(h.result.current.remember).toBe(false);
});
it('restores remembered fields but does not overwrite edits with a late read', async () => {
  jest.mocked(readCheckoutAddress).mockResolvedValueOnce(saved);
  const h = renderHook(() => useCheckoutAddress(true));
  await act(async () => {});
  expect(h.result.current.fields).toEqual(saved);
  let resolve!: (fields: DeliveryAddress) => void;
  jest.mocked(readCheckoutAddress).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  mockAccount = 'bob';
  h.rerender({});
  expect(h.result.current.fields.line1).toBe('');
  act(() => h.result.current.changeField('line1', 'New address'));
  await act(async () => resolve(saved));
  expect(h.result.current.fields.line1).toBe('New address');
});
it('ignores a previous account’s late address read', async () => {
  let resolve!: (fields: DeliveryAddress) => void;
  jest.mocked(readCheckoutAddress).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const h = renderHook(() => useCheckoutAddress(true));
  mockAccount = 'bob';
  h.rerender({});
  await act(async () => resolve(saved));
  expect(h.result.current.fields.line1).toBe('');
});
