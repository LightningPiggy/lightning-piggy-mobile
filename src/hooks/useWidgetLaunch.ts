import { useEffect, useRef, type RefObject } from 'react';
import { Toast } from '../components/BrandedToast';
import type { HomeSheetActions } from './useHomeSheetState';
import type { WalletState } from '../types/wallet';
import type { WidgetAction } from '../navigation/widgetDeepLinks';
import { nextWidgetLaunchStep } from '../utils/widgetLaunch';

interface Options {
  /** From Home's route params (set by `navigateToWidgetAction`). */
  action: WidgetAction | undefined;
  walletId: string | undefined;
  /** Changes on every widget tap, so the same button twice opens twice. */
  nonce: number | undefined;
  wallets: readonly WalletState[];
  activeWalletId: string | null;
  walletsHydrated: boolean;
  setActiveWallet: (walletId: string | null) => void;
  sheetsRef: RefObject<HomeSheetActions | null>;
  clearParams: () => void;
  watchOnlyMessage: string;
}

// A wallet switch that never takes (the wallet vanished between steps) must
// not loop: after this many selects the request is dropped.
const MAX_SELECTS = 3;

/**
 * Home's handler for the widget deep links (#1849). Waits for the wallet list
 * on a cold start, selects the requested wallet, and only then opens the
 * Receive / Send sheet, so the sheet opens on the wallet the widget showed.
 * Does nothing (and costs nothing) while no widget request is pending.
 */
export function useWidgetLaunch({
  action,
  walletId,
  nonce,
  wallets,
  activeWalletId,
  walletsHydrated,
  setActiveWallet,
  sheetsRef,
  clearParams,
  watchOnlyMessage,
}: Options): void {
  const selectsRef = useRef(0);
  useEffect(() => {
    selectsRef.current = 0;
  }, [action, walletId, nonce]);

  useEffect(() => {
    if (!action) return;
    const step = nextWidgetLaunchStep({
      action,
      walletId: walletId ?? null,
      wallets,
      activeWalletId,
      walletsHydrated,
    });
    if (step.kind === 'wait') return;
    if (step.kind === 'select' && selectsRef.current < MAX_SELECTS) {
      selectsRef.current += 1;
      setActiveWallet(step.walletId);
      return;
    }
    clearParams();
    if (step.kind === 'open') {
      if (step.sheet === 'receive') sheetsRef.current?.openReceive();
      else sheetsRef.current?.openSend(step.sheet === 'scan' ? { mode: 'scan' } : {});
    } else if (step.kind === 'watchOnly') {
      Toast.show({ type: 'info', text1: watchOnlyMessage, position: 'top' });
    }
  }, [
    action,
    walletId,
    nonce,
    wallets,
    activeWalletId,
    walletsHydrated,
    setActiveWallet,
    sheetsRef,
    clearParams,
    watchOnlyMessage,
  ]);
}
