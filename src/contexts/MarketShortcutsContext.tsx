import React, { createContext, useContext, useMemo, useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useBuyerOrders } from '../hooks/useBuyerOrders';
import { useSellerShop } from '../hooks/useSellerShop';
import { useShopOrders } from '../hooks/useShopOrders';
import { listingTitleMap } from '../utils/shopOrders';
import { useKnownOwnListings } from '../hooks/useKnownOwnListings';
import { buyerActionCount, sellerActionCount } from '../utils/marketShortcutCounts';
import {
  effectiveSellerInvoice,
  receiptProvesPayment,
  shopOrderStatus,
} from '../utils/shopOrderStatus';
import { expiresAtFromBolt11 } from '../utils/bolt11';

interface ShortcutCounts {
  buyer: number;
  seller: number;
  hasListings: boolean;
}
const Context = createContext<ShortcutCounts>({
  buyer: 0,
  seller: 0,
  hasListings: false,
});

/** One shared snapshot for Market and the account drawer. The existing hooks
 * use bounded fetches / local stores; no additional live relay subscriptions. */
export function MarketShortcutsProvider({ children }: { children: React.ReactNode }) {
  const { entries } = useBuyerOrders();
  const { pubkey, snapshot } = useSellerShop();
  const hasListings = useKnownOwnListings(pubkey, snapshot.listings);
  const titles = useMemo(() => listingTitleMap(snapshot.listings), [snapshot.listings]);
  const { orders, threads, invoices, paidKeys } = useShopOrders(titles);
  const [nowMs, setNowMs] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const expiries = [
        ...[...threads.values()].map((thread) => thread.invoice?.expiresAt ?? 0),
        ...Object.values(invoices).map((record) => expiresAtFromBolt11(record.bolt11) ?? 0),
      ]
        .map((expiry) => expiry * 1000)
        .filter((expiry) => expiry > Math.max(nowMs, Date.now()));
      if (!expiries.length) return;
      const timer = setTimeout(
        () => setNowMs(Date.now()),
        Math.min(Math.max(0, Math.min(...expiries) - Date.now()), 2_147_483_647),
      );
      return () => clearTimeout(timer);
    }, [threads, invoices, nowMs]),
  );
  const value = useMemo(
    () => ({
      buyer: buyerActionCount(entries),
      hasListings,
      seller: sellerActionCount(
        (orders ?? []).map((order) => {
          const thread = threads.get(order.key);
          const effective = thread
            ? effectiveSellerInvoice(invoices[order.key], thread.invoice)
            : null;
          return shopOrderStatus(thread, {
            invoiceRecord: invoices[order.key],
            walletPaid: paidKeys.has(order.key),
            nowMs: Math.max(nowMs, Date.now()),
            receiptVerified:
              thread && effective
                ? receiptProvesPayment(thread, effective.paymentHash, effective.bolt11)
                : false,
          });
        }),
      ),
    }),
    [entries, hasListings, orders, threads, invoices, paidKeys, nowMs],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useMarketShortcutCounts = () => useContext(Context);
