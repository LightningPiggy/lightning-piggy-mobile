import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { AppState } from 'react-native';

import * as onchainService from '../services/onchainService';
import {
  ONCHAIN_POLL_MS,
  clearOnchainSyncBackoff,
  isOnchainSyncBackedOff,
  noteOnchainSyncSuccess,
  pruneOnchainSyncBackoff,
  recordOnchainSyncFailure,
} from '../services/onchainSyncBackoff';
import type { WalletState } from '../types/wallet';

// On-chain incoming-payment coverage (#134). Extracted from
// WalletContext so the over-cap context doesn't grow — this is a
// self-contained polling concern (its own effect, its own cadence,
// no coupling back into the provider beyond the two callbacks passed
// in). Mirrors the NWC balance poll but on a much gentler cadence:
// Esplora / BDK Electrum syncs are an order of magnitude more
// expensive than NWC `getBalance`, so we trade detection latency for
// server politeness. Specifically:
//
//   - Launch → NO sweep during cold start. The first one runs
//     ONCHAIN_BOOT_DELAY_MS after launch: a BDK sync holds the JS thread
//     for seconds, right when the user is most likely to tap (#1725).
//   - Foreground resume → one refresh of every on-chain wallet, staggered
//     by ONCHAIN_RESUME_DELAY_MS (CLAUDE.md AppState rule, #554), so a tx
//     that landed while backgrounded is still detected soon after return.
//     Skipped when a sweep started under ONCHAIN_RESUME_MIN_GAP_MS ago, so
//     iOS `inactive → active` flickers (notification shade, Face ID, share
//     sheet) don't each buy a full BDK sweep; `inactive` keeps the poll alive.
//   - 2-minute slow poll while the app is foregrounded → catches
//     mempool credits arriving while the user lingers on Friends /
//     Home / anywhere else. Mempool (0-conf) detection is intentional:
//     the celebration is informational, not a balance commitment, and
//     waiting 10+ min for first confirmation would defeat the "sender
//     just paid me" UX. Esplora's `mempool_stats` is already included
//     in `syncSingleAddressViaEsplora`'s balance, so 0-conf credits
//     trip the existing balance-diff detector with zero extra work.
//   - A wallet whose sync fails backs off exponentially (4, 8, 16, then
//     every 30 min — services/onchainSyncBackoff). Each failure opens a fresh
//     Electrum connection, so an unreachable server mustn't be retried every
//     2 minutes forever (#1725). The backoff lifts on any successful sync of
//     that wallet (pull-to-refresh included), on a resume from background
//     (the network may have changed), and on an account switch.
//
// We sweep ALL on-chain wallets, not just the active one — incoming
// funds to any of the user's wallets warrant a celebration, mirroring
// the balance-diff detector's per-wallet behaviour.
export const ONCHAIN_BOOT_DELAY_MS = 30_000;
export const ONCHAIN_RESUME_DELAY_MS = 3_000;
export const ONCHAIN_RESUME_MIN_GAP_MS = 30_000;

interface Params {
  // Current wallet list — read only to derive the on-chain wallet
  // count (the effect's re-arm trigger). Live reads go through
  // `walletsRef` so additions/removals mid-poll are honoured.
  wallets: WalletState[];
  captureIdentity: () => () => boolean;
  // Ref to the latest wallet list; read inside the poll tick so the
  // timer doesn't need to re-arm on every balance change.
  walletsRef: MutableRefObject<WalletState[]>;
  // Commits a refreshed balance back into provider state (the same
  // callback the NWC poll uses), which trips the receive detector.
  updateWalletInState: (walletId: string, updates: Partial<WalletState>) => void;
}

export function useOnchainIncomingPoll({
  wallets,
  walletsRef,
  updateWalletInState,
  captureIdentity,
}: Params): void {
  // Track count of on-chain wallets as the dep so this effect re-arms
  // when the user adds / removes an on-chain wallet, but doesn't tear
  // down on every balance tick (the full `wallets` array would).
  const onchainWalletCount = wallets.filter((w) => w.walletType === 'onchain').length;
  // These survive a re-arm: adding a wallet mustn't restart the boot delay
  // or the resume gap, nor look like an account switch.
  const [launchedAt] = useState(Date.now);
  const lastSweepAt = useRef(0);
  const lastIdentity = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    if (onchainWalletCount === 0) return;

    // Guards against overlapping sweeps: a foreground-resume refresh
    // and the 2-minute timer (or two resumes in quick succession)
    // could otherwise kick off concurrent BDK/Electrum syncs for the
    // same wallet. If a sweep is still in flight, later triggers are
    // dropped — the next tick catches up.
    let inFlight = false;
    let disposed = false;

    const refreshAll = async () => {
      if (inFlight || disposed) return;
      const isIdentityCurrent = captureIdentity();
      const isCurrent = () => !disposed && isIdentityCurrent();
      // Another account's failures say nothing about this one's wallets.
      if (lastIdentity.current && !lastIdentity.current()) clearOnchainSyncBackoff();
      lastIdentity.current = isIdentityCurrent;
      inFlight = true;
      lastSweepAt.current = Date.now();
      try {
        // Re-read through walletsRef so additions/removals between the
        // effect run and this tick are honoured without re-arming the
        // entire poll.
        const onchain = walletsRef.current.filter((w) => w.walletType === 'onchain');
        pruneOnchainSyncBackoff(onchain.map((w) => w.id));
        // Sequential, not Promise.all: onchainService shares a singleton
        // Electrum connection (`blockchain`), so concurrent BDK syncs
        // would contend on one socket — and the BDK bindings aren't
        // guaranteed concurrency-safe. One wallet at a time keeps
        // resource usage (CPU/network/battery) smooth and avoids
        // shared-connection races.
        for (const w of onchain) {
          if (!isCurrent()) return;
          if (isOnchainSyncBackedOff(w.id)) continue;
          let b: number | null = null;
          try {
            // `getBalance` reports a failed sync as null rather than throwing.
            b = await onchainService.getBalance(w.id);
          } catch {
            // Treated like null: back off below.
          }
          if (!isCurrent()) return;
          if (b === null) {
            // Transient Electrum / Esplora failures are routine. Log only in
            // dev so we don't spam production with a flaky third party.
            recordOnchainSyncFailure(w.id);
            if (__DEV__) console.log(`[Wallet] on-chain balance refresh failed for ${w.id}`);
            continue;
          }
          noteOnchainSyncSuccess(w.id);
          // Only commit when the balance actually changed — an unchanged
          // write still costs an AsyncStorage round-trip (and needlessly
          // re-runs the receive detector).
          if (b !== w.balance) updateWalletInState(w.id, { balance: b });
        }
      } finally {
        inFlight = false;
      }
    };

    // One chained timer (not setInterval), so the boot, resume and poll
    // delays share a single cancellable slot.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delayMs: number) => {
      stop();
      timer = setTimeout(async () => {
        timer = null;
        await refreshAll();
        if (!disposed && !timer && AppState.currentState !== 'background')
          schedule(ONCHAIN_POLL_MS);
      }, delayMs);
    };
    // Resuming inside the boot window still waits out the boot delay.
    const arm = () =>
      schedule(Math.max(ONCHAIN_RESUME_DELAY_MS, launchedAt + ONCHAIN_BOOT_DELAY_MS - Date.now()));
    const resume = () => {
      const since = Date.now() - lastSweepAt.current;
      if (since >= ONCHAIN_RESUME_MIN_GAP_MS) return arm();
      // A sweep just ran: keep (or restore) the regular poll instead.
      if (!timer) schedule(Math.max(ONCHAIN_RESUME_DELAY_MS, ONCHAIN_POLL_MS - since));
    };

    let backgrounded = AppState.currentState === 'background';
    if (AppState.currentState === 'active') arm();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        // Back from the background, the network may have changed (left the
        // tunnel / captive Wi-Fi): give every wallet a fresh attempt.
        if (backgrounded) clearOnchainSyncBackoff();
        backgrounded = false;
        resume();
      } else if (next === 'background') {
        backgrounded = true;
        stop();
      }
      // 'inactive' (iOS overlays) is transient: leave the poll running.
    });
    return () => {
      disposed = true;
      stop();
      sub.remove();
    };
  }, [onchainWalletCount, walletsRef, updateWalletInState, captureIdentity, launchedAt]);
}
