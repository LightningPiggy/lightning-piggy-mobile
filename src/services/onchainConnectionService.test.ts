const mockStored = { value: 'old.example:50002:s' };
const mockSave = jest.fn(async (value: string) => {
  mockStored.value = value;
});
const mockGet = jest.fn(async () => mockStored.value);
const mockHeight = jest.fn();
const mockDisconnect = jest.fn();
jest.mock('./walletStorageService', () => ({
  DEFAULT_ELECTRUM_SERVER: 'electrum.example:50002:s',
  getElectrumServer: () => mockGet(),
  setElectrumServer: (value: string) => mockSave(value),
}));
jest.mock('./onchainService', () => ({
  getBlockHeight: () => mockHeight(),
  disconnectElectrum: () => mockDisconnect(),
}));
import {
  checkAndSaveElectrumServer,
  checkElectrumConnection,
  electrumSaveErrorKey,
} from './onchainConnectionService';

const signal = () => new AbortController().signal;
const failureKey = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return electrumSaveErrorKey(error);
  }
  throw new Error('expected a failure');
};
beforeEach(() => {
  jest.clearAllMocks();
  mockStored.value = 'old.example:50002:s';
  mockHeight.mockResolvedValue(900000);
});

it('Test probes the draft, then restores the previous server', async () => {
  mockHeight.mockImplementationOnce(async () => {
    expect(mockStored.value).toBe('new.example:50001:t');
    return 900000;
  });
  await expect(checkElectrumConnection('new.example:50001', false, signal())).resolves.toBe(900000);
  expect(mockStored.value).toBe('old.example:50002:s');
  expect(mockDisconnect).toHaveBeenCalledTimes(2);
});
it('Check and save keeps the draft only when the chain tip was read', async () => {
  await expect(checkAndSaveElectrumServer('new.example:50002', true)).resolves.toBe(
    'new.example:50002:s',
  );
  expect(mockStored.value).toBe('new.example:50002:s');
  mockHeight.mockRejectedValueOnce(new Error('Electrum client error: timed out'));
  await expect(failureKey(checkAndSaveElectrumServer('dead.example:50002', true))).resolves.toBe(
    'onChainScreen.errorUnreachable',
  );
  expect(mockStored.value).toBe('new.example:50002:s');
  mockHeight.mockResolvedValueOnce(null);
  await expect(failureKey(checkAndSaveElectrumServer('bad.example:50002', true))).resolves.toBe(
    'onChainScreen.errorUnreachable',
  );
  expect(mockStored.value).toBe('new.example:50002:s');
});
it('rejects an invalid host:port before any write or probe', async () => {
  await expect(failureKey(checkAndSaveElectrumServer('example:65536', true))).resolves.toBe(
    'onChainScreen.errorInvalidServer',
  );
  await expect(failureKey(checkElectrumConnection('no port', true, signal()))).resolves.toBe(
    'onChainScreen.errorInvalidServer',
  );
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockHeight).not.toHaveBeenCalled();
});
it('never probes when the previous setting cannot be read or the draft cannot be stored', async () => {
  mockGet.mockRejectedValueOnce(new Error('locked'));
  await expect(failureKey(checkAndSaveElectrumServer('new.example:50002', true))).resolves.toBe(
    'serverConnection.electrumSaveError',
  );
  mockSave.mockRejectedValueOnce(new Error('disk full'));
  await expect(failureKey(checkAndSaveElectrumServer('new.example:50002', true))).resolves.toBe(
    'serverConnection.electrumSaveError',
  );
  expect(mockHeight).not.toHaveBeenCalled();
  expect(mockStored.value).toBe('old.example:50002:s');
});
it('serializes a save behind an in-flight Test so the Test rollback cannot undo it', async () => {
  let finish!: (height: number) => void;
  mockHeight.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const test = checkElectrumConnection('draft.example:50002', true, signal());
  const save = checkAndSaveElectrumServer('chosen.example:50002', true);
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockHeight).toHaveBeenCalledTimes(1);
  finish(900000);
  await test;
  await save;
  expect(mockStored.value).toBe('chosen.example:50002:s');
});
it('does not turn cancellation into success and still restores the previous server', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(checkElectrumConnection('example:50002', true, controller.signal)).rejects.toThrow(
    'cancelled',
  );
  expect(mockSave).not.toHaveBeenCalled();
  const late = new AbortController();
  mockHeight.mockImplementationOnce(async () => {
    late.abort();
    return 900000;
  });
  await expect(checkElectrumConnection('example:50002', true, late.signal)).rejects.toThrow(
    'cancelled',
  );
  expect(mockStored.value).toBe('old.example:50002:s');
});
