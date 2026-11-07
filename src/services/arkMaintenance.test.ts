/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import {
  boardOnchainFunds,
  claimExitsTo,
  getArkBoardingAddress,
  getArkOverview,
  moveAllOnchain,
  progressEmergencyExit,
  quoteMoveAllOnchain,
  refreshArkCoins,
  startEmergencyExit,
} from './arkMaintenance';

jest.mock('./arkService', () => {
  const bark = require('@secondts/bark-react-native');
  return {
    getArkHandle: jest.fn(async () => ({
      bark,
      wallet: bark.__wallet,
      onchain: bark.__onchain,
      server: { network: 'signet' },
    })),
    getArkReceiveAddress: jest.fn(async () => 'tark1receive'),
  };
});

const bark = require('@secondts/bark-react-native');
const w = () => bark.__wallet;
const o = () => bark.__onchain;

describe('arkMaintenance', () => {
  beforeEach(() => {
    bark.__resetBarkMock();
  });

  describe('getArkOverview', () => {
    it('syncs, claims Lightning receives and summarises the wallet', async () => {
      w().getVtxosToRefresh.mockResolvedValueOnce([{ id: 'v1' }]);
      w().listClaimableExits.mockResolvedValueOnce([
        { vtxoId: 'e1', isClaimable: true },
        { vtxoId: 'e2', isClaimable: false },
      ]);
      o().balance.mockResolvedValueOnce({ confirmedSats: 7n, pendingSats: 0n, totalSats: 7n });
      const overview = await getArkOverview();
      expect(w().sync).toHaveBeenCalled();
      expect(w().tryClaimAllLightningReceives).toHaveBeenCalledWith(false);
      expect(overview).toMatchObject({
        spendableSats: 21_000,
        pendingSats: 1_500,
        exitingSats: 0,
        onchainSats: 7,
        arkAddress: 'tark1receive',
        coinsToRefresh: 1,
        claimableExits: 1,
        history: [],
      });
      // tip 900, first expiry 1000 → 100 blocks: under a day.
      expect(overview.expiry).toEqual({ health: 'urgent', blocksLeft: 100, daysLeft: 0 });
    });

    it('still loads when the on-chain side is unreachable', async () => {
      o().sync.mockRejectedValueOnce(new Error('esplora down'));
      o().balance.mockRejectedValueOnce(new Error('esplora down'));
      o().tipHeight.mockRejectedValueOnce(new Error('esplora down'));
      const overview = await getArkOverview();
      expect(overview.onchainSats).toBe(0);
      expect(overview.expiry.blocksLeft).toBeNull();
    });
  });

  describe('refreshArkCoins', () => {
    it('refreshes the coins bark says are due', async () => {
      w().getVtxosToRefresh.mockResolvedValueOnce([{ id: 'due' }]);
      await expect(refreshArkCoins()).resolves.toBe(true);
      expect(w().refreshVtxos).toHaveBeenCalledWith(['due']);
    });

    it('refreshes every spendable coin when none is due yet', async () => {
      await expect(refreshArkCoins()).resolves.toBe(true);
      expect(w().refreshVtxos).toHaveBeenCalledWith(['v1', 'v2']);
    });

    it('does nothing for an empty wallet', async () => {
      w().spendableVtxos.mockResolvedValueOnce([]);
      await expect(refreshArkCoins()).resolves.toBe(false);
      expect(w().refreshVtxos).not.toHaveBeenCalled();
    });
  });

  it('boards from the on-chain wallet', async () => {
    await expect(getArkBoardingAddress()).resolves.toBe('tb1qboarding');
    await expect(boardOnchainFunds()).resolves.toBe(50_000);
  });

  it('quotes and moves the whole balance on-chain', async () => {
    await expect(quoteMoveAllOnchain('tb1qdest')).resolves.toEqual({
      feeSats: 400,
      netSats: 20_600,
    });
    await expect(moveAllOnchain('tb1qdest')).resolves.toBe('offboardtx');
    expect(w().offboardAll).toHaveBeenCalledWith('tb1qdest');
  });

  describe('emergency exit', () => {
    it('starts the exit for the whole wallet and pushes it forward', async () => {
      await startEmergencyExit();
      expect(w().startExitForEntireWallet).toHaveBeenCalled();
      expect(w().progressExits).toHaveBeenCalledWith(undefined);
    });

    it('only progresses when there are exits in flight', async () => {
      await progressEmergencyExit();
      expect(w().progressExits).not.toHaveBeenCalled();
      w().hasPendingExits.mockResolvedValueOnce(true);
      await progressEmergencyExit();
      expect(w().syncExits).toHaveBeenCalled();
      expect(w().progressExits).toHaveBeenCalled();
    });

    it('drains, signs, extracts and broadcasts the claim', async () => {
      await expect(claimExitsTo('tb1qdest')).resolves.toBe('claimtx');
      expect(w().drainExits).toHaveBeenCalledWith([], true, 'tb1qdest', undefined);
      expect(w().signExitClaimInputs).toHaveBeenCalledWith('unsigned');
      expect(bark.extractTxFromPsbt).toHaveBeenCalledWith('signed');
      expect(w().broadcastTx).toHaveBeenCalledWith('hex(signed)');
    });
  });
});
