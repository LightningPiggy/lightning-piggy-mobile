import { readStoredRecoverySecrets } from './useRemoveWalletConfirm';
import { getCoinosRecovery, hasMnemonic } from '../services/walletStorageService';

jest.mock('../services/walletStorageService', () => ({
  getCoinosRecovery: jest.fn(),
  hasMnemonic: jest.fn(),
}));
jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('../contexts/LocaleContext', () => ({ useLocale: jest.fn() }));

const mockHasMnemonic = hasMnemonic as jest.MockedFunction<typeof hasMnemonic>;
const mockGetCoinos = getCoinosRecovery as jest.MockedFunction<typeof getCoinosRecovery>;

const recovery = {
  baseUrl: 'https://coinos.io/api',
  username: 'piggy',
  password: 'secret',
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => jest.clearAllMocks());

describe('readStoredRecoverySecrets', () => {
  it('checks the stored mnemonic for an on-chain wallet', async () => {
    mockHasMnemonic.mockResolvedValue(true);
    await expect(readStoredRecoverySecrets({ id: 'w1', walletType: 'onchain' })).resolves.toEqual({
      mnemonicStored: true,
      hasCoinosRecovery: false,
    });
    expect(mockHasMnemonic).toHaveBeenCalledWith('w1');
    expect(mockGetCoinos).not.toHaveBeenCalled();
  });

  it('reports a failed mnemonic read as unknown (null)', async () => {
    mockHasMnemonic.mockRejectedValue(new Error('keystore locked'));
    await expect(readStoredRecoverySecrets({ id: 'w1', walletType: 'onchain' })).resolves.toEqual({
      mnemonicStored: null,
      hasCoinosRecovery: false,
    });
  });

  it('checks the CoinOS login for an NWC wallet', async () => {
    mockGetCoinos.mockResolvedValueOnce(recovery).mockResolvedValueOnce(null);
    await expect(readStoredRecoverySecrets({ id: 'w2', walletType: 'nwc' })).resolves.toEqual({
      mnemonicStored: false,
      hasCoinosRecovery: true,
    });
    await expect(readStoredRecoverySecrets({ id: 'w2', walletType: 'nwc' })).resolves.toEqual({
      mnemonicStored: false,
      hasCoinosRecovery: false,
    });
    expect(mockHasMnemonic).not.toHaveBeenCalled();
  });

  it('reports a failed CoinOS read as unknown (null)', async () => {
    mockGetCoinos.mockRejectedValue(new Error('keystore locked'));
    await expect(readStoredRecoverySecrets({ id: 'w2', walletType: 'nwc' })).resolves.toEqual({
      mnemonicStored: false,
      hasCoinosRecovery: null,
    });
  });
});
