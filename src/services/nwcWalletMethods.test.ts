import {
  __resetWalletMethodsForTests,
  cachedWalletMethods,
  fetchWalletMethods,
} from './nwcWalletMethods';
import { getWalletMethods } from './nwcService';

jest.mock('./nwcService', () => ({ getWalletMethods: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  __resetWalletMethodsForTests();
});

it('caches granted methods and shares one request', async () => {
  (getWalletMethods as jest.Mock).mockResolvedValue(['pay_invoice', 'make_invoice']);
  await Promise.all([fetchWalletMethods('w1'), fetchWalletMethods('w1')]);
  expect(getWalletMethods).toHaveBeenCalledTimes(1);
  expect(cachedWalletMethods('w1')).toEqual(['pay_invoice', 'make_invoice']);
});

it('a failed lookup stays unknown (never cached as "can not receive")', async () => {
  (getWalletMethods as jest.Mock).mockResolvedValue(null);
  await fetchWalletMethods('w2');
  expect(cachedWalletMethods('w2')).toBeUndefined();
});
