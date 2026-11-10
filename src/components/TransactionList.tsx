import BrandedSpinner from './BrandedSpinner';
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { View, Text, FlatList, type ListRenderItemInfo } from 'react-native';
import type { RefreshControlProps } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { useWalletLive } from '../contexts/WalletContext';
import type { FiatCurrency } from '../services/fiatService';
import { useNostrContacts } from '../contexts/NostrContext';
import { getActivePubkey } from '../services/walletStorageService';
import { openDirectChat } from '../utils/openDirectChat';
import ContactProfileSheet from './ContactProfileSheet';
import type { ContactProfileBodyData } from './ContactProfileBody';
import TransactionDetailSheet, {
  TransactionDetailData,
  CounterpartyContact,
} from './TransactionDetailSheet';
import SendSheet from './SendSheet';
import TransactionRow from './TransactionRow';
import type { TransactionIconState } from './TransactionTypeIcon';
import { swapIconState } from '../utils/swapIconState';
import * as swapRecoveryService from '../services/swapRecoveryService';
import type { WalletTransaction, ZapCounterpartyInfo } from '../types/wallet';
import { perfLog } from '../utils/perfLog';
import type { RootStackParamList } from '../navigation/types';
import { createTransactionListStyles } from '../styles/TransactionList.styles';
import {
  buildTransactionRows,
  hasMoreTransactions,
  nextPage,
  sortTransactions,
  windowTransactions,
  INITIAL_PAGE_SIZE,
  type TxRow,
} from '../utils/transactionPagination';

interface Props {
  transactions: WalletTransaction[];
  // Forwarded to the FlatList so Home's pull-to-refresh keeps working now
  // that the list is the scroller (it used to live on Home's ScrollView).
  refreshControl?: React.ReactElement<RefreshControlProps>;
  // Passed in (not read from WalletContext) so a memoised list doesn't
  // re-render on every wallet-context change — e.g. Home keeps the
  // neighbouring wallets' lists mounted but hidden, and a swipe must not
  // re-render them (#1304).
  currency: FiatCurrency;
}

// Translate function shape as provided by the `useLocale()` hook. Passed
// into render-path helpers so they use the hook translator (updates on locale
// change immediately) rather than the module-level one (which lags the UI).
type Translate = ReturnType<typeof useLocale>['t'];

function formatDayHeader(ts: number, t: Translate, locale: string): string {
  const date = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return t('transactionList.today');
  if (sameDay(date, yesterday)) return t('transactionList.yesterday');
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const TransactionList: React.FC<Props> = ({ transactions, refreshControl, currency }) => {
  // Per-mount first-render marker. The previous module-scope `let`
  // never reset, so navigating away + back (or switching wallets,
  // which forces a remount via the activeWalletId effect) silently
  // dropped the perf log on every subsequent mount.
  const firstRenderLogged = useRef(false);
  if (!firstRenderLogged.current) {
    firstRenderLogged.current = true;
    perfLog(`TransactionList first render (${transactions.length} txs)`);
  }
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createTransactionListStyles(colors), [colors]);
  const { btcPrice } = useWalletLive();
  const { contacts } = useNostrContacts();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // When contacts' profiles refresh, we want transaction rows to pick up
  // the newer name/picture immediately. Tx's embedded `zapCounterparty`
  // is a snapshot from when the zap was attributed, so we layer a live
  // lookup on top by pubkey.
  const contactProfileByPubkey = useMemo(() => {
    const m = new Map<string, ZapCounterpartyInfo['profile']>();
    for (const c of contacts) {
      if (c.profile) {
        m.set(c.pubkey, {
          npub: c.profile.npub ?? '',
          name: c.profile.name ?? null,
          displayName: c.profile.displayName ?? null,
          picture: c.profile.picture ?? null,
          nip05: c.profile.nip05 ?? null,
        });
      }
    }
    return m;
  }, [contacts]);
  // Non-zap transactions (plain outgoing pays to a friend's lightning
  // address, incoming LNURL-pays) never get a zapCounterparty, so the
  // row's avatar falls back to the type icon even though the description
  // often *is* the counterparty's lud16. Build a side-index keyed on the
  // normalized lightning address so we can still surface the contact's
  // picture + name (#167).
  const contactByLud16 = useMemo(() => {
    const m = new Map<string, (typeof contacts)[number]>();
    for (const c of contacts) {
      const lud = c.profile?.lud16?.trim().toLowerCase();
      if (lud) m.set(lud, c);
    }
    return m;
  }, [contacts]);

  // Incremental "infinite scroll" page counter. Page 1 renders the initial
  // window; onEndReached advances it, revealing another slice. The full tx
  // array already lives in memory (WalletContext owns it), so this is
  // in-memory windowing — we just avoid mounting hundreds of rows at once.
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [detail, setDetail] = useState<TransactionDetailData | null>(null);
  const [detailIconState, setDetailIconState] = useState<TransactionIconState | undefined>(
    undefined,
  );
  const [zapContact, setZapContact] = useState<CounterpartyContact | null>(null);
  // The detail / zap / profile sheets mount the first time a row is tapped and
  // then stay mounted (so their close animations still run). Zap and profile
  // only open from the detail sheet, so one flag covers all three. Home keeps
  // neighbouring wallets' lists mounted but hidden (#1304); without this each
  // hidden list would carry three closed sheets that re-render on every
  // wallet-context change.
  const [sheetsArmed, setSheetsArmed] = useState(false);

  // Subscribe to swapRecoveryService's attention set + claimed-hash cache
  // so rows re-render when a recovery pass / synchronous claim updates
  // either. Both are keyed by LN paymentHash (= sha256(preimage)), which
  // is what WalletTransaction rows carry, so matching is a direct .has()
  // per row. We bump a single counter on either change to force a render
  // — the actual lookups go through swapRecoveryService each time.
  const [swapStateTick, setSwapStateTick] = useState(0);
  // Fingerprint of the swap state the rows actually consult. `bump` used to
  // fire unconditionally on every notify — and `recoverPendingSwaps()` runs on
  // every pull-to-refresh — so the extraData tick changed each refresh and
  // forced EVERY visible row to re-render even when no swap state changed
  // (measured: ~110 ms of a ~130 ms Home commit, #1014). Only bump when the
  // attention/claimed sets differ from what the last render consumed.
  const swapFpRef = useRef<string | null>(null);
  useEffect(() => {
    const fingerprint = () => {
      const att = [...swapRecoveryService.getAttentionPaymentHashes()].sort().join('|');
      const claimed = [...swapRecoveryService.getClaimedPaymentHashes().entries()]
        .map(([k, v]) => `${k}=${v ?? ''}`)
        .sort()
        .join('|');
      return `${att}§${claimed}`;
    };
    const bump = () => {
      const fp = fingerprint();
      if (fp === swapFpRef.current) return;
      swapFpRef.current = fp;
      setSwapStateTick((n) => n + 1);
    };
    const unsubAttention = swapRecoveryService.subscribeAttention(bump);
    const unsubClaimed = swapRecoveryService.subscribeClaimed(bump);
    // Defensive bump: `loadClaimedHashes()` is kicked off eagerly at module
    // import, and recovery's `notifyAttention()` can fire before this
    // effect subscribes. Without an initial sync bump after subscribing,
    // either of those notifies would be missed and the list would render
    // with empty state until the *next* change. Bumping once forces a
    // fresh read through `getAttentionPaymentHashes()` /
    // `hasClaimedPaymentHash()` on the current values.
    bump();
    return () => {
      unsubAttention();
      unsubClaimed();
    };
  }, []);

  // Maps a row's live swap-recovery flags (Boltz row? in the attention set?
  // claim recorded?) onto the icon badge. The badge rules — including why a
  // recorded claim shows 'done' even when `settled_at` is missing (the #891
  // ambiguous-pay case) — live in `swapIconState`.
  const iconStateFor = (tx: WalletTransaction): TransactionIconState | undefined =>
    swapIconState(tx, {
      isBoltz: swapRecoveryService.isBoltzTransaction(tx),
      inAttention: Boolean(
        tx.paymentHash && swapRecoveryService.getAttentionPaymentHashes().has(tx.paymentHash),
      ),
      claimed: Boolean(tx.paymentHash && swapRecoveryService.hasClaimedPaymentHash(tx.paymentHash)),
    });

  // Counterparty preview — opened from TransactionDetailSheet → "view
  // profile". A quick-peek bottom sheet first; "View full profile"
  // inside drills into the ContactProfile route.
  const [sheetContact, setSheetContact] = useState<ContactProfileBodyData | null>(null);
  const [profileSheetVisible, setProfileSheetVisible] = useState(false);

  // Paging is per instance: Home renders one list per (warm) wallet, keyed by
  // wallet id, so a wallet switch shows a different instance rather than
  // re-windowing this one (#1304). A new `transactions` array from a poll keeps
  // the current page, so the user isn't snapped back to the top mid-scroll.

  const sorted = useMemo(() => sortTransactions(transactions), [transactions]);
  const visibleTransactions = useMemo(
    () => windowTransactions(sorted, pagesLoaded),
    [sorted, pagesLoaded],
  );
  const hasMore = hasMoreTransactions(transactions.length, pagesLoaded);

  // Flatten the visible window into day-header + tx rows for the FlatList.
  const rows: TxRow[] = useMemo(
    () => buildTransactionRows(visibleTransactions, (ts) => formatDayHeader(ts, t, formatLocale)),
    [visibleTransactions, t, formatLocale],
  );

  // Reveal the next slice when the user scrolls near the bottom. `nextPage`
  // caps at the page that fully reveals the array, so repeated onEndReached
  // fires near the end don't churn state.
  const handleEndReached = useCallback(() => {
    setPagesLoaded((p) => nextPage(transactions.length, p));
  }, [transactions.length]);

  // Stable press handler so TransactionRow's memo isn't defeated by a fresh
  // callback identity every render.
  const onPressTx = useCallback(
    (tx: TransactionDetailData, ic: TransactionIconState | undefined) => {
      setSheetsArmed(true);
      setDetail(tx);
      setDetailIconState(ic);
    },
    [],
  );

  // Thin renderItem: all row content lives in the memoised TransactionRow.
  // FlatList re-wraps renderItem in a fresh closure whenever the list
  // re-renders, which re-executes every visible cell — with the content
  // memoised, that re-execution is just element creation and the memo bails
  // on stable props (#1014). `swapStateTick` is a dep so a REAL swap-state
  // change recomputes iconState (a primitive prop) and repaints just the
  // rows whose badge changed.
  const renderRow = useCallback(
    ({ item: row }: ListRenderItemInfo<TxRow>) => (
      <TransactionRow
        row={row}
        styles={styles}
        contactProfileByPubkey={contactProfileByPubkey}
        contactByLud16={contactByLud16}
        btcPrice={btcPrice}
        currency={currency}
        iconState={row.kind === 'tx' ? iconStateFor(row.tx) : undefined}
        onPressTx={onPressTx}
      />
    ),
    // iconStateFor is re-declared each render (deliberately not a dep — it
    // captures no render-local values, only live swapRecoveryService reads);
    // swapStateTick re-creates this callback when that service state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [styles, contactProfileByPubkey, contactByLud16, btcPrice, currency, onPressTx, swapStateTick],
  );

  const listFooter =
    hasMore && !refreshControl?.props.refreshing ? (
      <View
        style={styles.footerSpinner}
        accessibilityLabel={t('transactionList.loadingMore')}
        testID="transaction-list-loading-more"
      >
        <BrandedSpinner size="small" />
      </View>
    ) : null;

  return (
    <>
      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        // Swap-recovery attention/claimed flags live outside `data` (they're
        // read live from swapRecoveryService inside renderRow via
        // iconStateFor). FlatList only re-renders rows when data/renderItem/
        // extraData change by shallow compare, so thread the tick here to
        // force a badge refresh when only the swap state bumps.
        extraData={swapStateTick}
        refreshControl={refreshControl}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={listFooter ?? undefined}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>{t('transactionList.noTransactions')}</Text>
          </View>
        }
        // Match the first-page window so FlatList's initial render matches the
        // paging logic and can't drift if the page size is tuned (Copilot #940).
        initialNumToRender={INITIAL_PAGE_SIZE}
        windowSize={11}
        removeClippedSubviews
        testID="transaction-list"
      />
      {sheetsArmed ? (
        <>
          <TransactionDetailSheet
            visible={detail !== null}
            tx={detail}
            iconState={detailIconState}
            onClose={() => setDetail(null)}
            onCounterpartyPress={(contact) => {
              setDetail(null);
              setSheetContact(contact);
              setProfileSheetVisible(true);
            }}
            onZapCounterparty={(contact) => {
              setDetail(null);
              setZapContact(contact);
            }}
            onMessageCounterparty={(contact) => {
              setDetail(null);
              void openDirectChat(navigation, getActivePubkey(), {
                pubkey: contact.pubkey,
                name: contact.name,
                picture: contact.picture,
                lightningAddress: contact.lightningAddress,
              });
            }}
          />
          <SendSheet
            visible={zapContact !== null}
            onClose={() => setZapContact(null)}
            initialAddress={zapContact?.lightningAddress ?? undefined}
            initialPicture={zapContact?.picture ?? undefined}
            recipientPubkey={zapContact?.pubkey ?? undefined}
            recipientName={zapContact?.name ?? undefined}
          />
          <ContactProfileSheet
            visible={profileSheetVisible}
            onClose={() => setProfileSheetVisible(false)}
            contact={sheetContact}
            onViewFullProfile={() => {
              if (!sheetContact) return;
              setProfileSheetVisible(false);
              navigation.navigate('ContactProfile', { contact: sheetContact });
            }}
            onMessage={
              sheetContact?.pubkey
                ? () => {
                    const c = sheetContact;
                    if (!c?.pubkey) return;
                    setProfileSheetVisible(false);
                    void openDirectChat(navigation, getActivePubkey(), {
                      pubkey: c.pubkey,
                      name: c.name,
                      picture: c.picture,
                      lightningAddress: c.lightningAddress,
                    });
                  }
                : undefined
            }
            onZap={
              // Require both a pubkey AND a lightning address — SendSheet's
              // zap path needs a real pubkey to attach the zap receipt to
              // (NIP-57 verification fails on an empty-string sender).
              // Anonymous-zap counterparties (no pubkey) hide the icon
              // rather than silently mis-target.
              sheetContact?.pubkey && sheetContact.lightningAddress
                ? () => {
                    const c = sheetContact;
                    if (!c?.pubkey) return;
                    setProfileSheetVisible(false);
                    setZapContact({
                      pubkey: c.pubkey,
                      name: c.name,
                      picture: c.picture,
                      lightningAddress: c.lightningAddress,
                      banner: c.banner ?? null,
                      nip05: c.nip05 ?? null,
                      source: 'nostr',
                    });
                  }
                : undefined
            }
          />
        </>
      ) : null}
    </>
  );
};

export default React.memo(TransactionList);
