/**
 * Ark payments: receive over Lightning, and send to an Ark address (arkoor),
 * a Lightning invoice / address / LNURL, or an on-chain address. Every call
 * goes through the device's Ark wallet from `arkService`.
 */
import type { ArkDestination } from '../utils/arkDestination';
import { getArkHandle } from './arkService';

export interface ArkInvoice {
  invoice: string;
  paymentHash: string;
  amountSats: number;
}

export interface ArkFeeQuote {
  feeSats: number;
  /** What leaves the wallet in total, fee included. */
  totalSats: number;
}

export type ArkSendOutcome = 'paid' | 'pending';

/**
 * A BOLT11 invoice paid into this Ark wallet. The bark daemon claims the
 * payment into a coin once it arrives, as long as the app is open.
 */
export async function createArkInvoice(
  amountSats: number,
  description?: string,
): Promise<ArkInvoice> {
  const { wallet } = await getArkHandle();
  const inv = await wallet.bolt11Invoice(BigInt(amountSats), description || undefined, undefined);
  return { invoice: inv.invoice, paymentHash: inv.paymentHash, amountSats: Number(inv.amountSats) };
}

/** True once the invoice is paid and claimed into the wallet. */
export async function isArkInvoicePaid(paymentHash: string): Promise<boolean> {
  const { wallet } = await getArkHandle();
  return wallet.isInvoicePaid(paymentHash);
}

/** Fee quote for a payment, before the user confirms. */
export async function quoteArkSend(dest: ArkDestination, amountSats: number): Promise<ArkFeeQuote> {
  const { wallet } = await getArkHandle();
  const amount = BigInt(amountSats);
  let fee: bigint;
  switch (dest.kind) {
    case 'ark':
      fee = (await wallet.estimateArkoorPaymentFee(amount)).feeSats;
      break;
    case 'bitcoin':
      fee = (await wallet.estimateSendOnchainFee(dest.value, amount)).feeSats;
      break;
    default:
      fee = (await wallet.estimateLightningSendFee(amount)).feeSats;
  }
  return { feeSats: Number(fee), totalSats: amountSats + Number(fee) };
}

/**
 * Pay. Lightning payments are started without waiting (bark's crash-safe
 * flow) and reported `pending` until the server confirms; the history list
 * shows the outcome.
 */
export async function sendArkPayment(
  dest: ArkDestination,
  amountSats: number,
  comment?: string,
): Promise<ArkSendOutcome> {
  const { bark, wallet } = await getArkHandle();
  const amount = BigInt(amountSats);
  let status;
  switch (dest.kind) {
    case 'ark':
      if (!(await wallet.validateArkoorAddress(dest.value))) {
        throw new Error('This Ark address belongs to a different Ark server');
      }
      await wallet.sendArkoorPayment(dest.value, amount);
      return 'paid';
    case 'bitcoin':
      // Leaves the Ark in the next round as an on-chain output.
      await wallet.sendOnchain(dest.value, amount);
      return 'pending';
    case 'bolt11':
      // An invoice with its own amount must not be overridden.
      status = await wallet.payLightningInvoice(
        dest.value,
        dest.amountSats === null ? amount : undefined,
        false,
      );
      break;
    case 'lightningAddress':
      status = await wallet.payLightningAddress(dest.value, amount, comment || undefined, false);
      break;
    case 'lnurl':
      status = await wallet.payLnurl(dest.value, amount, comment || undefined, false);
      break;
  }
  return status.tag === bark.LightningSendStatus_Tags.Paid ? 'paid' : 'pending';
}
