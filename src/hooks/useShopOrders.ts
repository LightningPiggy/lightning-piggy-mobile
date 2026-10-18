import {
  loadSellerInvoices,
  subscribeSellerInvoices,
  type SellerInvoiceRecord,
} from '../services/sellerInvoiceStore';
import { groupRowsByConversation } from '../utils/orderThreads';
import { sellerOrderThreads, type SellerOrderThread } from '../utils/shopOrderStatus';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { getShopOrderRows, subscribeDmStorage, type DmMessageRow } from '../services/dmDb';
import { deriveShopOrders, type ShopOrder } from '../utils/shopOrders';

/** Store writes arrive in bursts (inbox refresh, decrypt batches): re-read
 * once they settle, never once per write. */
const RELOAD_DEBOUNCE_MS = 400;

/**
 * Incoming Gamma orders for the signed-in seller's own listings, read from
 * the encrypted DM store (#1534). No relay subscription: the existing DM
 * pipeline stores orders, and this re-reads the store when it changes.
 * Armed only while the screen is focused.
 *
 * `titles` maps a listing's `d` tag to its title. `orders` is null until the
 * first read finishes.
 */
export function useShopOrders(titles: ReadonlyMap<string, string>): {
  orders: ShopOrder[] | null;
  threads: ReadonlyMap<string, SellerOrderThread>;
  paidKeys: ReadonlySet<string>;
  invoices: Readonly<Record<string, SellerInvoiceRecord>>;
} {
  const { pubkey } = useNostr();
  const [state, setState] = useState<{
    owner: string | null;
    rows: DmMessageRow[] | null;
    invoices: Record<string, SellerInvoiceRecord>;
  }>({
    owner: null,
    rows: null,
    invoices: {},
  });
  const generation = useRef(0);

  useFocusEffect(
    useCallback(() => {
      if (!pubkey) return;
      let active = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const load = () => {
        const run = ++generation.current;
        Promise.all([getShopOrderRows(pubkey), loadSellerInvoices(pubkey)])
          .then(([rows, invoices]) => {
            if (active && run === generation.current) setState({ owner: pubkey, rows, invoices });
          })
          .catch(() => {
            // Store unavailable: show what we had (or the empty state).
            if (active && run === generation.current)
              setState((prev) =>
                prev.owner === pubkey ? prev : { owner: pubkey, rows: [], invoices: {} },
              );
          });
      };
      load();
      const reload = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(load, RELOAD_DEBOUNCE_MS);
      };
      const unsubscribe = subscribeDmStorage((owner) => {
        if (owner === pubkey) reload();
      });
      const unsubscribeInvoices = subscribeSellerInvoices(reload);
      return () => {
        active = false;
        if (timer) clearTimeout(timer);
        unsubscribe();
        unsubscribeInvoices();
      };
    }, [pubkey]),
  );

  const rows = state.owner === pubkey ? state.rows : null;
  const orders = useMemo(
    () => (rows && pubkey ? deriveShopOrders(rows, pubkey, titles) : null),
    [rows, pubkey, titles],
  );
  const threads = useMemo(() => {
    const grouped = groupRowsByConversation(
      (rows ?? []).map((row) => ({
        ...row,
        text: row.content,
        id: row.eventId,
      })),
    );
    const result = new Map<string, SellerOrderThread>();
    for (const [buyer, messages] of grouped)
      for (const [id, thread] of sellerOrderThreads(messages)) result.set(`${buyer}:${id}`, thread);
    return result;
  }, [rows]);
  const paidKeys = useMemo(
    () =>
      new Set(
        state.owner === pubkey
          ? Object.entries(state.invoices)
              .filter(([, record]) => record.paidAt)
              .map(([key]) => key)
          : [],
      ),
    [state.owner, state.invoices, pubkey],
  );
  return { orders, threads, paidKeys, invoices: state.owner === pubkey ? state.invoices : {} };
}
