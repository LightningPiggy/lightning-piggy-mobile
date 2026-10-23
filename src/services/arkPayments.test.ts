/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import { createArkInvoice, isArkInvoicePaid, quoteArkSend, sendArkPayment } from './arkPayments';
import type { ArkDestination } from '../utils/arkDestination';

jest.mock('./arkService', () => {
  const bark = require('@secondts/bark-react-native');
  return {
    getArkHandle: jest.fn(async () => ({ bark, wallet: bark.__wallet, onchain: bark.__onchain })),
  };
});

const bark = require('@secondts/bark-react-native');
const w = () => bark.__wallet;

const dest = (kind: ArkDestination['kind'], value: string, amountSats: number | null = null) => ({
  kind,
  value,
  amountSats,
});

describe('arkPayments', () => {
  beforeEach(() => {
    bark.__resetBarkMock();
  });

  it('creates a Lightning invoice for the amount, as bigint sats', async () => {
    await expect(createArkInvoice(1_500, 'Pocket money')).resolves.toEqual({
      invoice: 'lntbs1invoice',
      paymentHash: 'hash',
      amountSats: 1_500,
    });
    expect(w().bolt11Invoice).toHaveBeenCalledWith(1_500n, 'Pocket money', undefined);
  });

  it('passes no description when it is empty', async () => {
    await createArkInvoice(10, '');
    expect(w().bolt11Invoice).toHaveBeenCalledWith(10n, undefined, undefined);
  });

  it('reports invoice settlement', async () => {
    w().isInvoicePaid.mockResolvedValueOnce(true);
    await expect(isArkInvoicePaid('hash')).resolves.toBe(true);
  });

  it.each([
    ['ark', 'estimateArkoorPaymentFee', 0],
    ['bitcoin', 'estimateSendOnchainFee', 300],
    ['bolt11', 'estimateLightningSendFee', 10],
    ['lightningAddress', 'estimateLightningSendFee', 10],
  ] as const)('quotes a %s send with %s', async (kind, method, feeSats) => {
    await expect(quoteArkSend(dest(kind, 'x'), 1_000)).resolves.toEqual({
      feeSats,
      totalSats: 1_000 + feeSats,
    });
    expect(w()[method]).toHaveBeenCalled();
  });

  it('pays an Ark address with arkoor after checking it belongs to our server', async () => {
    await expect(sendArkPayment(dest('ark', 'tark1abc'), 700)).resolves.toBe('paid');
    expect(w().validateArkoorAddress).toHaveBeenCalledWith('tark1abc');
    expect(w().sendArkoorPayment).toHaveBeenCalledWith('tark1abc', 700n);
  });

  it('refuses an Ark address from another server', async () => {
    w().validateArkoorAddress.mockResolvedValueOnce(false);
    await expect(sendArkPayment(dest('ark', 'tark1other'), 700)).rejects.toThrow(
      'different Ark server',
    );
    expect(w().sendArkoorPayment).not.toHaveBeenCalled();
  });

  it('does not override the amount of an invoice that carries one', async () => {
    await expect(sendArkPayment(dest('bolt11', 'lntbs10u1x', 1_000), 1_000)).resolves.toBe('paid');
    expect(w().payLightningInvoice).toHaveBeenCalledWith('lntbs10u1x', undefined, false);
  });

  it('passes the amount for an amountless invoice', async () => {
    await sendArkPayment(dest('bolt11', 'lntbs1x'), 2_000);
    expect(w().payLightningInvoice).toHaveBeenCalledWith('lntbs1x', 2_000n, false);
  });

  it('pays a Lightning address with a comment and reports it pending', async () => {
    await expect(
      sendArkPayment(dest('lightningAddress', 'piggy@example.com'), 21, 'thanks'),
    ).resolves.toBe('pending');
    expect(w().payLightningAddress).toHaveBeenCalledWith('piggy@example.com', 21n, 'thanks', false);
  });

  it('pays an LNURL', async () => {
    await sendArkPayment(dest('lnurl', 'lnurl1abc'), 50);
    expect(w().payLnurl).toHaveBeenCalledWith('lnurl1abc', 50n, undefined, false);
  });

  it('sends on-chain through the next round', async () => {
    await expect(sendArkPayment(dest('bitcoin', 'tb1qxyz'), 5_000)).resolves.toBe('pending');
    expect(w().sendOnchain).toHaveBeenCalledWith('tb1qxyz', 5_000n);
  });
});
