import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { AppState } from 'react-native';

import * as nwcService from '../services/nwcService';
import type { WalletState } from '../types/wallet';
import { perfLog } from '../utils/perfLog';
import { singleFlight } from '../utils/singleFlight';

// Event-driven refresh of the active NWC wallet's balance (#657). Extracted
// from WalletContext (over the file-size cap). Refreshes on focus (the effect
// re-runs when a balance surface gains focus, via `balancePollDemand`) and on
// app-foreground — NOT on a constant interval. Receive *detection* is
// transaction-hash-based (#653), so the old "poll to catch LUD-16 receives"
// rationale is gone, and the constant 10 s poll was the dominant relay load
// that rate-limited self-hosted relays.
//
// The foreground refresh is staggered by BALANCE_RESUME_DELAY_MS (CLAUDE.md
// AppState rule, #554): the `active` transition is when the JS thread is
// busiest (relay re-arm, cache refetches), so an immediate relay round-trip
// lands inside that burst. The timer is cancelled if the app backgrounds again
// or the hook unmounts. A resume right after a refresh (iOS `inactive → active`
// flickers, quick app switches) is skipped: the balance is at most
// BALANCE_RESUME_MIN_GAP_MS old and a NWC round-trip buys nothing.
export const BALANCE_RESUME_DELAY_MS = 3_000;
export const BALANCE_RESUME_MIN_GAP_MS = 15_000;

interface Params {
  activeWalletId: string | null | undefined;
  activeWalletConnected: boolean;
  // > 0 while at least one balance-displaying surface is focused.
  balancePollDemand: number;
  walletsRef: MutableRefObject<WalletState[]>;
  captureIdentity: () => () => boolean;
  updateWalletInState: (walletId: string, updates: Partial<WalletState>) => void;
}

export function useActiveWalletBalanceRefresh({
  activeWalletId,
  activeWalletConnected,
  balancePollDemand,
  walletsRef,
  captureIdentity,
  updateWalletInState,
}: Params): void {
  // Per wallet: another wallet's fresh balance says nothing about the active one.
  const lastRefresh = useRef<{ walletId: string; at: number } | null>(null);

  useEffect(() => {
    if (!activeWalletId || !activeWalletConnected) return;
    // No focused surface needs the balance right now — skip entirely.
    // Re-runs when demand transitions 0 → 1 (focus event).
    if (balancePollDemand <= 0) return;

    // singleFlight drops a tick whose predecessor is still awaiting; replyTimeoutMs caps each to a single 8 s attempt (#650).
    let disposed = false;
    const pollBalance = singleFlight(async () => {
      const isIdentityCurrent = captureIdentity();
      const isCurrent = () => !disposed && isIdentityCurrent();
      if (!isCurrent()) return;
      const b = await nwcService.getBalance(activeWalletId, { replyTimeoutMs: 8000 });
      if (b === null || !isCurrent()) return;
      // Only a committed balance counts as fresh: a failed refresh must not
      // suppress the next resume retry.
      lastRefresh.current = { walletId: activeWalletId, at: Date.now() };
      updateWalletInState(activeWalletId, { balance: b });
    });
    const refreshOnce = () => {
      // Bail if the wallet has since disconnected — read through `walletsRef`
      // rather than the closure so this is current.
      const current = walletsRef.current.find((w) => w.id === activeWalletId);
      if (!current || !current.isConnected || current.walletType === 'onchain') return;
      // Skip a parked (dead/timing-out) relay so a refresh can't re-arm the
      // churn the cooldown is trying to suppress (#656).
      if (nwcService.isRelayInCooldown(activeWalletId)) return;
      pollBalance().catch(() => {});
    };

    // Focus (this effect re-running) refreshes at once: the user is looking at it.
    if (AppState.currentState === 'active') refreshOnce();

    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (next) => {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
      if (next !== 'active') return; // background / inactive cancel a pending resume
      const last = lastRefresh.current;
      if (last?.walletId === activeWalletId && Date.now() - last.at < BALANCE_RESUME_MIN_GAP_MS)
        return;
      resumeTimer = setTimeout(() => {
        resumeTimer = undefined;
        perfLog('wallet balance resume refresh (staggered)');
        refreshOnce();
      }, BALANCE_RESUME_DELAY_MS);
    });
    return () => {
      disposed = true;
      clearTimeout(resumeTimer);
      sub.remove();
    };
  }, [
    activeWalletId,
    activeWalletConnected,
    balancePollDemand,
    walletsRef,
    captureIdentity,
    updateWalletInState,
  ]);
}
