import { act, renderHook } from '@testing-library/react-native';
import { useOnchainReceiveAddress } from './useOnchainReceiveAddress';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(getReceiveAddress: jest.Mock) {
  const sessionTokenRef = { current: 0 };
  const hook = renderHook(() => useOnchainReceiveAddress(getReceiveAddress, sessionTokenRef));
  return { ...hook, sessionTokenRef };
}

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it('flags a failed lookup instead of loading forever, and a retry clears it (#1801)', async () => {
  const get = jest
    .fn()
    .mockRejectedValueOnce(new Error('electrum down'))
    .mockResolvedValueOnce('bc1qretry');
  const { result } = setup(get);

  await act(async () => result.current.request('w1'));
  expect(result.current.failed).toBe(true);
  expect(result.current.address).toBeNull();

  await act(async () => result.current.retry());
  expect(get).toHaveBeenLastCalledWith('w1');
  expect(result.current.failed).toBe(false);
  expect(result.current.address).toBe('bc1qretry');
});

it('clears the error as soon as a retry starts, so the user sees loading again', async () => {
  const pending = deferred<string>();
  const get = jest.fn().mockRejectedValueOnce(new Error('x')).mockReturnValueOnce(pending.promise);
  const { result } = setup(get);
  await act(async () => result.current.request('w1'));
  expect(result.current.failed).toBe(true);
  act(() => result.current.retry());
  expect(result.current.failed).toBe(false);
  await act(async () => pending.resolve('bc1qlate'));
  expect(result.current.address).toBe('bc1qlate');
});

it('ignores a slow earlier failure once a newer request has succeeded', async () => {
  const first = deferred<string>();
  const get = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('bc1qnew');
  const { result } = setup(get);
  act(() => result.current.request('w1'));
  await act(async () => result.current.retry());
  expect(result.current.address).toBe('bc1qnew');
  await act(async () => first.reject(new Error('timeout')));
  expect(result.current.failed).toBe(false);
  expect(result.current.address).toBe('bc1qnew');
});

it('drops results from a previous sheet session', async () => {
  const pending = deferred<string>();
  const get = jest.fn().mockReturnValueOnce(pending.promise);
  const { result, sessionTokenRef } = setup(get);
  act(() => result.current.request('w1'));
  sessionTokenRef.current += 1;
  await act(async () => pending.reject(new Error('x')));
  expect(result.current.failed).toBe(false);
});

it('reset clears the error and forgets the wallet so retry is a no-op', async () => {
  const get = jest.fn().mockRejectedValueOnce(new Error('x'));
  const { result } = setup(get);
  await act(async () => result.current.request('w1'));
  act(() => result.current.reset());
  expect(result.current.failed).toBe(false);
  act(() => result.current.retry());
  expect(get).toHaveBeenCalledTimes(1);
});
