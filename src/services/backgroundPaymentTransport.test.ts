import { AppState, type AppStateStatus } from 'react-native';
import { PAGE_SIZE, readBackgroundPayments } from './backgroundPaymentTransport';
import { patchRelayPublish } from './nwcRelayPublishPatch';
const mockEnable = jest.fn();
const mockList = jest.fn();
const mockClose = jest.fn();
jest.mock('@getalby/sdk', () => ({
  NostrWebLNProvider: jest.fn().mockImplementation(() => ({
    enable: mockEnable,
    close: mockClose,
    listTransactions: mockList,
  })),
}));
jest.mock('./nwcEncryption', () => ({
  pinNip04IfNoInfoEvent: jest.fn(),
  clearEncryptionDecision: jest.fn(),
}));
jest.mock('./nwcRelayPublishPatch', () => ({ patchRelayPublish: jest.fn() }));
beforeEach(() => {
  AppState.currentState = 'background';
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockEnable.mockResolvedValue(undefined);
  mockList.mockResolvedValue({ transactions: [] });
});
afterEach(() => jest.useRealTimers());
it('only requests paid incoming history on its own connection and closes it', async () => {
  await readBackgroundPayments('wallet', 'url', new AbortController().signal);
  expect(mockList).toHaveBeenCalledWith({
    type: 'incoming',
    unpaid: false,
    limit: PAGE_SIZE,
    offset: 0,
  });
  // The LNbits no-wait-for-OK patch must be applied to THIS provider before
  // any request goes out, exactly as nwcService.connect does.
  const patch = jest.mocked(patchRelayPublish);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(patch.mock.invocationCallOrder[0]).toBeLessThan(mockEnable.mock.invocationCallOrder[0]);
  expect(mockClose).toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
it('bounds a stalled wallet and cleans up', async () => {
  mockList.mockReturnValue(new Promise(() => {}));
  const request = readBackgroundPayments('wallet', 'url', new AbortController().signal);
  const assertion = expect(request).rejects.toThrow('timed out');
  await jest.advanceTimersByTimeAsync(25_000);
  await assertion;
  expect(mockClose).toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
it('cancels on stop and does not issue history requests after a late enable', async () => {
  let enabled!: () => void;
  mockEnable.mockReturnValue(
    new Promise<void>((resolve) => {
      enabled = resolve;
    }),
  );
  const controller = new AbortController();
  const request = readBackgroundPayments('wallet', 'url', controller.signal);
  const assertion = expect(request).rejects.toThrow('cancelled');
  controller.abort();
  await assertion;
  enabled();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockClose.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('returns the WebLN rows unchanged, already in sats', async () => {
  // NostrWebLNProvider.listTransactions has converted the NIP-47 msats
  // (1_234_000) to 1234 sats; the transport must not scale them again.
  const row = { type: 'incoming', state: 'settled', amount: 1234, fees_paid: 0 };
  mockList.mockResolvedValue({ transactions: [row] });
  await expect(
    readBackgroundPayments('wallet', 'url', new AbortController().signal),
  ).resolves.toEqual([row]);
});

it('normalizes a wallet response with no transaction array', async () => {
  mockList.mockResolvedValue({});
  await expect(
    readBackgroundPayments('wallet', 'url', new AbortController().signal),
  ).resolves.toEqual([]);
});

it('cancels the private connection when the UI resumes', async () => {
  let resume!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  const listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, fn) => {
    resume = fn;
    return { remove };
  });
  mockList.mockReturnValue(new Promise(() => {}));
  const pending = readBackgroundPayments('wallet', 'url', new AbortController().signal);
  const assertion = expect(pending).rejects.toThrow('cancelled');
  resume('active');
  await assertion;
  expect(mockClose).toHaveBeenCalled();
  expect(remove).toHaveBeenCalled();
  listener.mockRestore();
});

const stubAppState = () =>
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);

const rowsAt = (time: number, count: number) =>
  Array.from({ length: count }, () => ({ settled_at: time, created_at: time }));

it('asks for one small page when the page reaches back past the watch window', async () => {
  stubAppState();
  mockList.mockResolvedValueOnce({
    transactions: [...rowsAt(2_000, PAGE_SIZE - 1), ...rowsAt(500, 1)],
  });
  const rows = await readBackgroundPayments('wallet', 'url', new AbortController().signal, 1_000);
  expect(mockList).toHaveBeenCalledTimes(1);
  expect(rows).toHaveLength(PAGE_SIZE);
});

it('pages on while a whole page is inside the window, so a burst of payments is not missed', async () => {
  stubAppState();
  mockList
    .mockResolvedValueOnce({ transactions: rowsAt(2_000, PAGE_SIZE) })
    .mockResolvedValueOnce({ transactions: rowsAt(1_500, 3) });
  const rows = await readBackgroundPayments('wallet', 'url', new AbortController().signal, 1_000);
  expect(mockList).toHaveBeenCalledTimes(2);
  expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ offset: PAGE_SIZE }));
  expect(rows).toHaveLength(PAGE_SIZE + 3);
});

it('stops after five pages however busy the wallet is', async () => {
  stubAppState();
  mockList.mockResolvedValue({ transactions: rowsAt(2_000, PAGE_SIZE) });
  await readBackgroundPayments('wallet', 'url', new AbortController().signal, 1_000);
  expect(mockList).toHaveBeenCalledTimes(5);
});
