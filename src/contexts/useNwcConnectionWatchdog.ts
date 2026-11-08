import type React from 'react';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as nwcService from '../services/nwcService';
import * as walletStorage from '../services/walletStorageService';
import type { WalletState } from '../types/wallet';

/** Watchdog tick: reconnect dropped sockets, probe idle wallets, sync health. */
export const WATCHDOG_INTERVAL_MS = 30_000;
/** Resume stagger (CLAUDE.md "AppState `active` handlers stagger", #554/#1031). */
export const WATCHDOG_RESUME_DELAY_MS = 3_000;
/** Coalescing window for health-change notifications (≤150 ms per CLAUDE.md). */
export const HEALTH_SYNC_COALESCE_MS = 150;
/** Single-attempt ceiling for the liveness probe — same as the focus balance poll (#650). */
export const PROBE_REPLY_TIMEOUT_MS = 8_000;

/**
 * NWC connection watchdog — extracted from `WalletContext` (per-responsibility
 * hook split, see CLAUDE.md "File size and modularity").
 *
 * Every 30 s, for each NWC wallet:
 *  1. reconnect a dropped / dead socket (respecting the relay cooldown, #656);
 *  2. send a liveness probe — one `get_balance`, which also refreshes the
 *     balance — when the wallet hasn't answered anything for ~4 min (#1768).
 *     Without it, a wallet backend that goes down while the app sits idle
 *     never fails a request and so stays green "Connected" indefinitely. The
 *     probe skips parked / rate-limited relays, handshakes in flight and a
 *     backgrounded app, and is throttled per wallet in `shouldProbeWallet`;
 *     balance surfaces' own refreshes count as replies, so they suppress it;
 *  3. sync `isConnected` + the four-state `connectionHealth` into wallet state
 *     (write only on change).
 *
 * On resume the same pass runs once after a cancellable ~3 s stagger, so a
 * wallet left idle past the freshness window decays to grey "Checking…" and is
 * re-probed promptly instead of waiting for the next tick. Between passes,
 * relay-health notifications (an answer, a timeout, a fresh socket) trigger a
 * coalesced no-network health sync so the card turns green as soon as the
 * startup probe answers.
 *
 * Reads the wallet list through a ref so the interval isn't torn down and
 * re-created on every wallet state update (the wallets array churns constantly
 * with balance polls / tx refreshes).
 */
export function useNwcConnectionWatchdog(
  walletsRef: React.MutableRefObject<WalletState[]>,
  updateWalletInState: (walletId: string, updates: Partial<WalletState>) => void,
  captureIdentity: () => () => boolean,
): void {
  useEffect(() => {
    let checkInProgress = false;
    let disposed = false;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;

    // Sync stored state to relay *responsiveness* (does it answer?), not
    // connect()'s socket-level success — so a dead relay stays Disconnected
    // instead of flapping back to Connected (#654). getWalletHealth needs the
    // SOCKET-only state to tell amber "Not responding" (socket up, relay
    // parked) from red "Disconnected" (socket down) — isWalletConnected is
    // already false for the degraded case (#786 review). Write only on change.
    const syncHealth = (w: WalletState) => {
      const isConnected = nwcService.isWalletConnected(w.id);
      const health = nwcService.getWalletHealth(w.id, nwcService.isSocketConnected(w.id));
      if (isConnected !== w.isConnected || health !== w.connectionHealth) {
        updateWalletInState(w.id, { isConnected, connectionHealth: health });
      }
    };

    const probe = async (w: WalletState, isCurrent: () => boolean) => {
      if (AppState.currentState !== 'active') return;
      if (!nwcService.isWalletConnected(w.id) || nwcService.isRelayInCooldown(w.id)) return;
      if (nwcService.isConnectionInProgress(w.id) || !nwcService.shouldProbeWallet(w.id)) return;
      nwcService.markWalletProbed(w.id);
      const balance = await nwcService.getBalance(w.id, { replyTimeoutMs: PROBE_REPLY_TIMEOUT_MS });
      if (balance !== null && isCurrent()) {
        const current = walletsRef.current.find((ww) => ww.id === w.id);
        if (current && current.balance !== balance) updateWalletInState(w.id, { balance });
      }
    };

    const runCheck = async () => {
      // A reconnect on a dead relay can outlast the 30s tick; this guard stops
      // checks stacking across ticks (#654).
      if (checkInProgress) return;
      checkInProgress = true;
      const currentIdentity = captureIdentity();
      const isCurrent = () => !disposed && currentIdentity();
      try {
        for (const w of walletsRef.current.filter((ww) => ww.walletType === 'nwc')) {
          if (!isCurrent()) return;
          // A handshake already in flight (startup connect, payInvoice's
          // publish-failure reconnect) must not be superseded by the tick.
          if (nwcService.isConnectionInProgress(w.id)) continue;
          if (!nwcService.isWalletConnected(w.id) && !nwcService.isRelayInCooldown(w.id)) {
            // Relay unresponsive (dead / hung) and not currently parked — try to
            // (re)connect, which re-probes via its initial getBalance. The
            // cooldown gate (#656) backs off a persistently-dead relay so we
            // don't hammer it every 30s tick.
            try {
              const nwcUrl = await walletStorage.getNwcUrl(w.id);
              if (nwcUrl && isCurrent())
                await nwcService.connect(w.id, nwcUrl, undefined, isCurrent);
            } catch {
              // connect threw — the responsiveness read below reflects it
            }
          } else {
            try {
              await probe(w, isCurrent);
            } catch {
              // getBalance records the outcome itself; the sync below reflects it
            }
          }
          if (!isCurrent()) return;
          syncHealth(walletsRef.current.find((ww) => ww.id === w.id) ?? w);
        }
      } finally {
        checkInProgress = false;
      }
    };

    const interval = setInterval(() => {
      void runCheck();
    }, WATCHDOG_INTERVAL_MS);

    const appStateSub = AppState.addEventListener('change', (next) => {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      if (next !== 'active') return;
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        void runCheck();
      }, WATCHDOG_RESUME_DELAY_MS);
    });

    const unsubscribeHealth = nwcService.subscribeWalletHealth(() => {
      if (syncTimer || disposed) return;
      syncTimer = setTimeout(() => {
        syncTimer = null;
        if (disposed) return;
        for (const w of walletsRef.current) {
          if (w.walletType === 'nwc') syncHealth(w);
        }
      }, HEALTH_SYNC_COALESCE_MS);
    });

    return () => {
      disposed = true;
      clearInterval(interval);
      if (resumeTimer) clearTimeout(resumeTimer);
      if (syncTimer) clearTimeout(syncTimer);
      appStateSub.remove();
      unsubscribeHealth();
    };
  }, [walletsRef, updateWalletInState, captureIdentity]);
}
