import {
  invoiceWalletChoices,
  resolveReceiveWallet,
  walletInvoiceCapability,
} from './invoiceWallets';

const wallet = (id: string, walletType: 'nwc' | 'onchain', order = 0) => ({
  id,
  alias: id,
  walletType,
  isConnected: true,
  order,
});

describe('which wallets can receive an order payment', () => {
  const methods: Record<string, string[] | undefined> = {
    receive: ['pay_invoice', 'make_invoice', 'lookup_invoice'],
    webln: ['sendPayment', 'makeInvoice'],
    payOnly: ['pay_invoice', 'get_balance'],
  };
  const wallets = [
    wallet('payOnly', 'nwc', 1),
    wallet('xpub', 'onchain', 2),
    wallet('receive', 'nwc', 3),
    wallet('unknown', 'nwc', 4),
    wallet('webln', 'nwc', 0),
  ];

  it('excludes on-chain (watch-only) and pay-only NWC wallets', () => {
    const choices = invoiceWalletChoices(wallets, (id) => methods[id]);
    expect(choices.map((c) => [c.wallet.id, c.capability])).toEqual([
      ['webln', 'yes'],
      ['receive', 'yes'],
      ['unknown', 'unknown'],
    ]);
  });

  it('capability: unknown until methods are known', () => {
    expect(walletInvoiceCapability({ walletType: 'nwc' }, undefined)).toBe('unknown');
    expect(walletInvoiceCapability({ walletType: 'nwc' }, ['make_invoice'])).toBe('yes');
    expect(walletInvoiceCapability({ walletType: 'onchain' }, ['make_invoice'])).toBe('no');
  });

  it('the shop wallet counts as unset when missing, removed, pay-only or unchecked', () => {
    const choices = invoiceWalletChoices(wallets, (id) => methods[id]);
    expect(resolveReceiveWallet('receive', choices)).toBe('receive');
    expect(resolveReceiveWallet(null, choices)).toBeNull();
    expect(resolveReceiveWallet('deleted-wallet', choices)).toBeNull();
    expect(resolveReceiveWallet('payOnly', choices)).toBeNull();
    expect(resolveReceiveWallet('xpub', choices)).toBeNull();
    expect(resolveReceiveWallet('unknown', choices)).toBeNull();
  });
});
