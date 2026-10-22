import { swapSupportHint } from './swapSupportText';
import { getSwapBackendForId } from '../services/swapBackendService';

jest.mock('../services/swapBackendService', () => ({
  LEGACY_SWAP_BACKEND: 'https://api.boltz.exchange/v2',
  getSwapBackendForId: jest.fn(),
}));
const backendFor = getSwapBackendForId as jest.Mock;

describe('swapSupportHint', () => {
  it('points Boltz-hosted swaps at Boltz support', async () => {
    backendFor.mockResolvedValue('https://api.boltz.exchange/v2');
    expect(await swapSupportHint('abc')).toBe('Contact Boltz support with this ID.');
  });

  it("points custom-backend swaps at that server's operator, not Boltz", async () => {
    backendFor.mockResolvedValue('https://lightning.example.org/v2');
    expect(await swapSupportHint('abc')).toMatch(/swap server's operator/);
  });

  it('stays backend-neutral when the lookup fails (no evidence it is Boltz)', async () => {
    backendFor.mockRejectedValue(new Error('storage unavailable'));
    expect(await swapSupportHint('abc')).toBe('Contact your swap provider with this ID.');
  });
});
