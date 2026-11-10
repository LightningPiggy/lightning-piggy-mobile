import {
  Alert,
  type BrandedAlertButton,
  type BrandedAlertOptions,
} from '../components/BrandedAlert';
import type { WalletState } from '../types/wallet';
import { singleFlight } from './singleFlight';
import {
  confirmLargeMove,
  findSameChainAlternative,
  promptSameChainAlternative,
} from './transferPrompts';

jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));

/** The last alert's buttons + options, as BrandedAlert received them. */
const lastAlert = () => {
  const call = jest.mocked(Alert.alert).mock.calls.at(-1)!;
  return {
    buttons: call[2] as BrandedAlertButton[],
    options: call[3] as BrandedAlertOptions | undefined,
  };
};

// BrandedAlert closes an open alert when another replaces it and calls only the
// displaced alert's onDismiss (#1264). Each awaited Move prompt must settle
// then, or the single-flight Move guard stays locked for good (#1778).
describe('Move prompts dismissed by a superseding alert', () => {
  beforeEach(() => jest.mocked(Alert.alert).mockClear());

  it('confirmLargeMove resolves false on dismiss and true only on Confirm', async () => {
    const dismissed = confirmLargeMove('5,000 sats', 'A', 'B');
    lastAlert().options!.onDismiss!();
    await expect(dismissed).resolves.toBe(false);

    const confirmed = confirmLargeMove('5,000 sats', 'A', 'B');
    lastAlert().buttons.find((b) => b.text === 'Confirm')!.onPress!();
    await expect(confirmed).resolves.toBe(true);
  });

  it('promptSameChainAlternative resolves cancel on dismiss', async () => {
    const alt = wallet({ id: 'ln', balance: 900 });
    const choice = promptSameChainAlternative(alt, 'onchain-to-ln', 'en');
    lastAlert().options!.onDismiss!();
    await expect(choice).resolves.toBe('cancel');
  });

  it('releases the Move guard so the next tap runs', async () => {
    const transfer = jest.fn(async () => {
      if (!(await confirmLargeMove('5,000 sats', 'A', 'B'))) return;
    });
    const guarded = singleFlight((run: () => Promise<void>) => run());

    const first = guarded(transfer);
    await Promise.resolve();
    lastAlert().options!.onDismiss!(); // a refund alert replaces the prompt
    await first;

    const second = guarded(transfer);
    expect(transfer).toHaveBeenCalledTimes(2);
    lastAlert().options!.onDismiss!();
    await second;
  });
});

const wallet = (over: Partial<WalletState>): WalletState =>
  ({
    id: 'w',
    alias: 'Wallet',
    walletType: 'nwc',
    isConnected: true,
    balance: 0,
    walletAlias: null,
    transactions: [],
    ...over,
  }) as WalletState;

describe('findSameChainAlternative', () => {
  const src = wallet({ id: 'src', walletType: 'onchain', onchainImportMethod: 'mnemonic' });

  it('picks the best-funded connected Lightning wallet for on-chain → Lightning', () => {
    const small = wallet({ id: 'small', balance: 600 });
    const big = wallet({ id: 'big', balance: 900 });
    const offline = wallet({ id: 'off', balance: 5_000, isConnected: false });
    const result = findSameChainAlternative(
      [src, small, big, offline],
      'src',
      'onchain-to-ln',
      500,
    );
    expect(result?.id).toBe('big');
  });

  it('only offers spendable (mnemonic) on-chain wallets for Lightning → on-chain', () => {
    const watchOnly = wallet({
      id: 'xpub',
      walletType: 'onchain',
      onchainImportMethod: 'xpub',
      balance: 9_000,
    });
    const spendable = wallet({
      id: 'seed',
      walletType: 'onchain',
      onchainImportMethod: 'mnemonic',
      balance: 1_000,
    });
    const ln = wallet({ id: 'ln', balance: 5_000 });
    expect(
      findSameChainAlternative([ln, watchOnly, spendable], 'ln', 'ln-to-onchain', 800)?.id,
    ).toBe('seed');
  });

  it('returns null when no wallet can cover the amount or the move is same-chain', () => {
    const ln = wallet({ id: 'ln', balance: 100 });
    expect(findSameChainAlternative([src, ln], 'src', 'onchain-to-ln', 500)).toBeNull();
    expect(findSameChainAlternative([src, ln], 'src', 'ln-to-ln', 50)).toBeNull();
  });
});
