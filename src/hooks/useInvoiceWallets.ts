import { useEffect, useMemo, useState } from 'react';
import { useWallet } from '../contexts/WalletContext';
import {
  cachedWalletMethods,
  fetchWalletMethods,
  subscribeWalletMethods,
} from '../services/nwcWalletMethods';
import { invoiceWalletChoices, type InvoiceWalletChoice } from '../utils/invoiceWallets';

/**
 * The seller's wallets that can create an order invoice (NWC connections
 * granting `make_invoice`). While `enabled`, asks each NWC wallet whose
 * methods aren't known yet — once, shared across pickers — so a pay-only
 * connection drops out of the list instead of failing at invoice time.
 */
export function useInvoiceWallets(enabled: boolean): InvoiceWalletChoice[] {
  const { wallets } = useWallet();
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeWalletMethods(() => setVersion((v) => v + 1)), []);

  const nwcIdsKey = wallets
    .filter((w) => w.walletType === 'nwc')
    .map((w) => w.id)
    .join(',');
  useEffect(() => {
    if (!enabled || !nwcIdsKey) return;
    for (const id of nwcIdsKey.split(',')) {
      if (!cachedWalletMethods(id)) void fetchWalletMethods(id);
    }
  }, [enabled, nwcIdsKey]);

  return useMemo(
    () => invoiceWalletChoices(wallets, cachedWalletMethods),
    // `version` re-reads the methods cache after a fetch lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallets, version],
  );
}
