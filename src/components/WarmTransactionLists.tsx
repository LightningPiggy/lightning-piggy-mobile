import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { idleScheduler } from '../utils/idleScheduler';
import type { RefreshControlProps } from 'react-native';
import TransactionList from './TransactionList';
import type { WalletState } from '../types/wallet';
import type { FiatCurrency } from '../services/fiatService';
import { walletListsToRender, warmWalletIds } from '../utils/warmWalletLists';
import { warmTransactionListsStyles as styles } from '../styles/WarmTransactionLists.styles';

// Wait this long after the active card stops changing before mounting its
// neighbours' lists, so a fast flick doesn't render lists it flies past.
const WARM_NEIGHBOURS_AFTER_MS = 600;

interface Props {
  wallets: WalletState[];
  activeWalletId: string | null;
  /** False while Home shows an empty / add-wallet / first-load state instead. */
  visible: boolean;
  currency: FiatCurrency;
  refreshControl: React.ReactElement<RefreshControlProps>;
}

/**
 * Home's transaction lists, one per warm wallet (#1304). Rendering a wallet's
 * list is the expensive part of a swipe (~230 ms on the emulator, every visible
 * row mounts), so instead of re-rendering one list with new data, this keeps
 * the active wallet's list and its neighbours' lists mounted and only toggles
 * which one is shown. Swiping to a warm neighbour reveals rows that are
 * already rendered, in the same commit as the card change.
 *
 * Bounded: at most the active card and its two neighbours. Neighbours mount
 * once the active card has settled (after interactions), never mid-flick.
 */
const WarmTransactionLists: React.FC<Props> = ({
  wallets,
  activeWalletId,
  visible,
  currency,
  refreshControl,
}) => {
  const walletIds = useMemo(() => wallets.map((w) => w.id), [wallets]);
  const walletIdsKey = walletIds.join(',');
  const [warm, setWarm] = useState<string[]>([]);

  useEffect(() => {
    if (activeWalletId === null) return;
    let task: { cancel: () => void } | null = null;
    const timer = setTimeout(() => {
      task = idleScheduler.runWhenIdle(() =>
        setWarm(warmWalletIds(walletIdsKey.split(','), activeWalletId)),
      );
    }, WARM_NEIGHBOURS_AFTER_MS);
    return () => {
      clearTimeout(timer);
      task?.cancel();
    };
  }, [activeWalletId, walletIdsKey]);

  const rendered = walletListsToRender(walletIds, activeWalletId, warm);

  return (
    <>
      {rendered.map((id) => {
        const wallet = wallets.find((w) => w.id === id);
        if (!wallet) return null;
        const shown = visible && id === activeWalletId;
        return (
          <View
            key={id}
            style={shown ? styles.shown : styles.hidden}
            pointerEvents={shown ? 'auto' : 'none'}
            importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
            accessibilityElementsHidden={!shown}
          >
            <TransactionList
              transactions={wallet.transactions}
              refreshControl={refreshControl}
              currency={currency}
            />
          </View>
        );
      })}
    </>
  );
};

export default React.memo(WarmTransactionLists);
