// Which of the seller's wallets can receive an order payment — i.e. create a
// Lightning invoice. PURE (coverage scope: src/utils).
//
// Only NWC wallets can make invoices: on-chain wallets here are xpub watch-
// only. An NWC connection may also be pay-only (no `make_invoice` grant), so
// its `get_info` methods decide. Until those are known the wallet is shown as
// "checking" but can't be chosen.
import type { WalletState } from '../types/wallet';

export type InvoiceCapability = 'yes' | 'no' | 'unknown';

/** NIP-47 name, plus the WebLN spelling some providers report. */
const MAKE_INVOICE = new Set(['make_invoice', 'makeInvoice']);

export function walletInvoiceCapability(
  wallet: Pick<WalletState, 'walletType'>,
  methods: readonly string[] | null | undefined,
): InvoiceCapability {
  if (wallet.walletType !== 'nwc') return 'no';
  if (!methods) return 'unknown';
  return methods.some((m) => MAKE_INVOICE.has(m)) ? 'yes' : 'no';
}

export interface InvoiceWalletChoice {
  wallet: Pick<WalletState, 'id' | 'alias' | 'walletType' | 'isConnected'>;
  capability: Exclude<InvoiceCapability, 'no'>;
}

/** The seller's wallets that can (or might) make invoices, in wallet order.
 * Watch-only / on-chain and pay-only NWC wallets are excluded. */
export function invoiceWalletChoices(
  wallets: readonly Pick<WalletState, 'id' | 'alias' | 'walletType' | 'isConnected' | 'order'>[],
  methodsFor: (walletId: string) => readonly string[] | null | undefined,
): InvoiceWalletChoice[] {
  return [...wallets]
    .sort((a, b) => a.order - b.order)
    .flatMap((wallet) => {
      const capability = walletInvoiceCapability(wallet, methodsFor(wallet.id));
      return capability === 'no' ? [] : [{ wallet, capability }];
    });
}

/**
 * The shop's "Receive payments to" wallet, if it still exists and can make
 * invoices — else null (the setting counts as unset and the seller must
 * choose). A wallet whose capability isn't known yet also resolves to null
 * so nothing is pre-selected on a guess.
 */
export function resolveReceiveWallet(
  storedWalletId: string | null | undefined,
  choices: readonly InvoiceWalletChoice[],
): string | null {
  if (!storedWalletId) return null;
  return choices.some((c) => c.wallet.id === storedWalletId && c.capability === 'yes')
    ? storedWalletId
    : null;
}
