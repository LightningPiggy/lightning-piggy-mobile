import { addNwcWalletForIdentity } from './addNwcWalletForIdentity';
import * as nwc from './nwcService';
import * as storage from './walletStorageService';

jest.mock('./nwcService', () => ({
  connect: jest.fn(),
  getInfo: jest.fn(),
  disconnect: jest.fn(),
  getWalletHealth: jest.fn(() => 'responsive'),
  isSocketConnected: jest.fn(() => true),
}));
jest.mock('./walletStorageService', () => ({
  getActivePubkey: jest.fn(() => 'B'),
  generateWalletId: () => 'new-wallet',
  getNwcUrl: jest.fn(),
  saveNwcUrl: jest.fn(),
  deleteNwcUrl: jest.fn(),
  getWalletList: jest.fn(),
  saveWalletList: jest.fn(),
  updateWalletList: jest.fn(),
}));
const url =
  'nostr+walletconnect://' + 'a'.repeat(64) + '?relay=wss://example.com&secret=' + 'b'.repeat(64);
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(storage.getActivePubkey).mockReturnValue('B');
  jest.mocked(storage.getWalletList).mockResolvedValue([]);
  jest.mocked(storage.updateWalletList).mockImplementation(async (update, owner) => {
    const updated = update(await storage.getWalletList(owner));
    if (updated !== null) await storage.saveWalletList(updated, owner);
  });
  jest.mocked(nwc.connect).mockResolvedValue({ success: true, balance: 7 });
  jest.mocked(nwc.getInfo).mockResolvedValue(null);
  jest.mocked(nwc.getWalletHealth).mockReturnValue('responsive');
});
it('cancels an import when identity changes while connecting', async () => {
  const slow = deferred<{ success: boolean }>();
  jest.mocked(nwc.connect).mockReturnValueOnce(slow.promise);
  let current = true;
  const pending = addNwcWalletForIdentity(url, 'Test', 'coinos', [], () => current);
  current = false;
  slow.resolve({ success: true });
  await expect(pending).resolves.toMatchObject({ success: false });
  expect(storage.saveWalletList).not.toHaveBeenCalled();
  expect(storage.saveNwcUrl).not.toHaveBeenCalled();
  expect(nwc.disconnect).toHaveBeenCalledWith('new-wallet');
});
it('pins an already-started list write to its original owner, then suppresses UI success', async () => {
  const writing = deferred<void>();
  const started = deferred<void>();
  jest.mocked(storage.saveWalletList).mockImplementationOnce(async () => {
    started.resolve();
    await writing.promise;
  });
  let current = true;
  const pending = addNwcWalletForIdentity(url, 'Test', 'coinos', [], () => current);
  await started.promise;
  current = false;
  jest.mocked(storage.getActivePubkey).mockReturnValue('C');
  writing.resolve();
  await expect(pending).resolves.toMatchObject({ success: false });
  expect(storage.getWalletList).toHaveBeenCalledWith('B');
  expect(storage.saveWalletList).toHaveBeenCalledWith(
    [expect.objectContaining({ id: 'new-wallet' })],
    'B',
  );
  expect(storage.deleteNwcUrl).not.toHaveBeenCalled();
  expect(nwc.disconnect).toHaveBeenCalledWith('new-wallet');
});
it('returns the connected wallet only to the still-current owner', async () => {
  await expect(
    addNwcWalletForIdentity(url, 'Test', 'coinos', [], () => true),
  ).resolves.toMatchObject({
    success: true,
    state: { id: 'new-wallet', balance: 7, connectionHealth: 'responsive' },
  });
  expect(nwc.disconnect).not.toHaveBeenCalled();
});
