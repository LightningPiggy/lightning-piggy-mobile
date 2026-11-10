import { Alert } from '../components/BrandedAlert';
import { QuoteChangedError, type SwapFees } from '../services/boltzService';
import { createReplyTimeoutError } from '../services/nwcErrors';
import {
  alertTransferFailure,
  classifyTransferError,
  exceedsSourceBalance,
  transferFailureMessage,
} from './transferOutcome';

jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));

const t = (key: string) => `t:${key}`;

describe('exceedsSourceBalance (#1778)', () => {
  it('blocks an amount above the known balance', () => {
    expect(exceedsSourceBalance(1_000, 1_001)).toBe(true);
  });

  it('allows the full balance and anything below it', () => {
    expect(exceedsSourceBalance(1_000, 1_000)).toBe(false);
    expect(exceedsSourceBalance(1_000, 1)).toBe(false);
  });

  it('never blocks while the balance is unknown', () => {
    expect(exceedsSourceBalance(null, 5_000)).toBe(false);
    expect(exceedsSourceBalance(undefined, 5_000)).toBe(false);
  });
});

describe('classifyTransferError (#1778)', () => {
  it('reports a reply timeout after the payment was sent as an unknown outcome', () => {
    expect(classifyTransferError(createReplyTimeoutError(), 'lightning')).toBe('unknown-outcome');
  });

  it('reports a relay / connection drop after the payment was sent as an unknown outcome', () => {
    const relayDrop = new Error("Couldn't reach your wallet: relay publish timed out");
    expect(classifyTransferError(relayDrop, 'lightning')).toBe('unknown-outcome');
    expect(classifyTransferError(new Error('Network request failed'), 'lightning')).toBe(
      'unknown-outcome',
    );
  });

  it('treats the same errors as failures before anything was sent', () => {
    expect(classifyTransferError(createReplyTimeoutError(), 'none')).toBe('failed');
    expect(classifyTransferError(new Error('Failed to connect to wss://relay'), 'none')).toBe(
      'failed',
    );
  });

  it('keeps a wallet’s own rejection a failure even after dispatch', () => {
    expect(classifyTransferError(new Error('Insufficient balance'), 'lightning')).toBe('failed');
  });

  it('treats ANY error after an on-chain broadcast attempt as an unknown outcome', () => {
    // A lost Electrum reply surfaces as arbitrary BDK text, matching no NWC pattern.
    expect(classifyTransferError(new Error('electrum: unexpected EOF'), 'onchain')).toBe(
      'unknown-outcome',
    );
    // Even the Metro-reload text: the transaction may already be in the mempool.
    expect(
      classifyTransferError(new TypeError("Cannot read property 'reload' of undefined"), 'onchain'),
    ).toBe('unknown-outcome');
  });

  it('keeps on-chain errors before the broadcast (sync, build, funds) as failures', () => {
    expect(classifyTransferError(new Error('Insufficient funds'), 'none')).toBe('failed');
    expect(classifyTransferError(new Error('electrum: unexpected EOF'), 'none')).toBe('failed');
  });

  it('recognises a changed swap quote and a Metro dev reload', () => {
    const quote = { minAmount: 1, maxAmount: 2 } as unknown as SwapFees;
    expect(classifyTransferError(new QuoteChangedError(quote), 'none')).toBe('quote-changed');
    expect(
      classifyTransferError(new TypeError("Cannot read property 'reload' of undefined"), 'none'),
    ).toBe('dev-reload');
    // After a Lightning payment was sent, a reload must not claim nothing moved.
    expect(
      classifyTransferError(
        new TypeError("Cannot read property 'reload' of undefined"),
        'lightning',
      ),
    ).toBe('unknown-outcome');
  });
});

describe('transferFailureMessage / alertTransferFailure', () => {
  beforeEach(() => jest.mocked(Alert.alert).mockClear());

  it('never says "Move Failed" for an unknown outcome', () => {
    const message = transferFailureMessage('unknown-outcome', createReplyTimeoutError(), t);
    expect(message).toBe('t:transferSheet.unknownOutcomeBody');
    alertTransferFailure('unknown-outcome', message, t);
    expect(Alert.alert).toHaveBeenCalledWith('t:transferSheet.unknownOutcomeTitle', message);
  });

  it('shows the wallet’s message for a confirmed failure', () => {
    const message = transferFailureMessage('failed', new Error('Insufficient balance'), t);
    expect(message).toBe('Insufficient balance');
    alertTransferFailure('failed', message, t);
    expect(Alert.alert).toHaveBeenCalledWith('Move Failed', 'Insufficient balance');
  });
});
