import type { NostrWebLNProvider } from '@getalby/sdk';
import { listTransactionsWithRetry } from './nwcTransactionRetry';

const providerWith = (listTransactions: jest.Mock) =>
  ({ listTransactions }) as unknown as NostrWebLNProvider;
const walletError = (code: string) => Object.assign(new Error(`wallet said ${code}`), { code });

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('listTransactionsWithRetry (#1768)', () => {
  it('surfaces a NIP-47 wallet error at once: no retry, no reconnect', async () => {
    const error = walletError('NOT_IMPLEMENTED');
    const list = jest.fn().mockRejectedValue(error);
    const reconnect = jest.fn();
    await expect(
      listTransactionsWithRetry('w1', providerWith(list), reconnect, () => true),
    ).rejects.toBe(error);
    expect(list).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('still reconnects and retries on a transport failure', async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('reply timeout: event abc'), { code: 'INTERNAL' }),
      )
      .mockResolvedValueOnce({ transactions: [{ id: 't1' }] });
    const fresh = providerWith(list);
    const reconnect = jest.fn(async () => fresh);
    const pending = listTransactionsWithRetry('w1', providerWith(list), reconnect, () => true);
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toEqual([{ id: 't1' }]);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
