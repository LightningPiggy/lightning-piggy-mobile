import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { useWallet } from '../contexts/WalletContext';
import { getOrderRows, subscribeDmStorage } from '../services/dmDb';
import { loadBuyerOrderTitles, type BuyerOrderTitles } from '../services/buyerOrderTitles';
import { paymentHashFromBolt11 } from '../utils/bolt11';
import { isTransactionSettled } from '../utils/transactionSettlement';
import {
  buyerOrderEntries,
  groupRowsByConversation,
  payNowCount,
  type BuyerOrderEntry,
  type OrderRowInput,
} from '../utils/orderThreads';

type Row = OrderRowInput & { conversation: string };

/** One account's loaded orders — tagged with its owner so an account switch never shows another account's purchases. */
interface Snapshot {
  owner: string | null;
  rows: Row[];
  titles: BuyerOrderTitles;
}

const EMPTY_SNAPSHOT: Snapshot = { owner: null, rows: [], titles: {} };

/** Coalesce bursts of DM-store commits into one reload. */
const RELOAD_DEBOUNCE_MS = 600;

export interface UseBuyerOrders {
  entries: BuyerOrderEntry[];
  titles: BuyerOrderTitles;
  loading: boolean;
  /** Orders with an invoice waiting to be paid. */
  payNow: number;
}

/**
 * My orders, from the encrypted DM store only (no relay subscription): every
 * order I placed, newest first, with its status. Focus-armed — loads when the
 * screen gains focus and follows store commits while focused. "Paid" also
 * reads wallet history: an outgoing payment with the invoice's hash.
 */
export function useBuyerOrders(): UseBuyerOrders {
  const { pubkey } = useNostr();
  const { wallets } = useWallet();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [loadingState, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now);
  const loadId = useRef(0);

  const load = useCallback(async (owner: string) => {
    const id = ++loadId.current;
    try {
      const [stored, storedTitles] = await Promise.all([
        getOrderRows(owner),
        loadBuyerOrderTitles(owner),
      ]);
      if (id !== loadId.current) return;
      setSnapshot({
        owner,
        rows: stored.map((r) => ({
          id: r.eventId,
          conversation: r.conversation,
          fromMe: r.fromMe,
          text: r.content,
          wireKind: r.wireKind,
          createdAt: r.createdAt,
        })),
        titles: storedTitles,
      });
    } catch {
      // Store unavailable: keep what we had (only ever shown for its own owner).
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!pubkey) {
        setSnapshot(EMPTY_SNAPSHOT);
        setLoading(false);
        return;
      }
      void load(pubkey);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = subscribeDmStorage((owner) => {
        if (owner !== pubkey) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void load(pubkey), RELOAD_DEBOUNCE_MS);
      });
      return () => {
        unsubscribe();
        if (timer) clearTimeout(timer);
        loadId.current += 1;
      };
    }, [pubkey, load]),
  );

  const isCurrent = pubkey !== null && snapshot.owner === pubkey;
  const rows = isCurrent ? snapshot.rows : EMPTY_SNAPSHOT.rows;
  const titles = isCurrent ? snapshot.titles : EMPTY_SNAPSHOT.titles;
  const loading = loadingState || (!!pubkey && !isCurrent);

  // Payment hashes my wallets paid out — the "our payment succeeded" signal.
  const paidHashes = useMemo(() => {
    const set = new Set<string>();
    for (const wallet of wallets) {
      for (const tx of wallet.transactions) {
        if (tx.type === 'outgoing' && tx.paymentHash && isTransactionSettled(tx)) {
          set.add(tx.paymentHash.toLowerCase());
        }
      }
    }
    return set;
  }, [wallets]);

  const entries = useMemo(
    () =>
      buyerOrderEntries(
        groupRowsByConversation(rows),
        (bolt11) => {
          const hash = paymentHashFromBolt11(bolt11);
          return hash !== null && paidHashes.has(hash.toLowerCase());
        },
        Math.max(nowMs, Date.now()),
      ),
    [rows, paidHashes, nowMs],
  );

  useFocusEffect(
    useCallback(() => {
      const expiries = entries.flatMap((entry) =>
        entry.paymentExpiresAt === undefined ? [] : [entry.paymentExpiresAt * 1000],
      );
      if (expiries.length === 0) return;
      const delay = Math.max(0, Math.min(...expiries) - Date.now());
      // Long-lived invoices must not overflow the platform's signed 32-bit timer.
      const timer = setTimeout(() => setNowMs(Date.now()), Math.min(delay, 2_147_483_647));
      return () => clearTimeout(timer);
    }, [entries]),
  );

  return { entries, titles, loading, payNow: payNowCount(entries) };
}
