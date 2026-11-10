import { useEffect, useRef } from 'react';
import { idleScheduler } from '../utils/idleScheduler';
import { getCurrentUserPubkey } from '../services/nostrActiveAccount';
import type { RelayConfig } from '../types/nostr';
import { checkDefaultDmInbox } from './defaultDmInbox';
import type { AdoptResult } from './useNip65Relays';

/** Well clear of cold start (relay-list refresh, inbox drain, first taps). */
export const DEFAULT_DM_INBOX_DELAY_MS = 12_000;

export interface UseDefaultDmInboxParams {
  pubkey: string | null;
  isLoggedIn: boolean;
  signerType: string | null;
  nip65Relays: RelayConfig[];
  /** The DM inbox as held right now (`useNip65Relays().dmInboxLive`). */
  dmInboxLive: {
    relays: () => string[];
    createdAt: (pk: string) => number;
    session: () => number;
  };
  getReadRelays: () => string[];
  applyPublishedDmInbox: (
    pk: string,
    list: string[],
    createdAt?: number,
    session?: number,
  ) => Promise<AdoptResult>;
  applyPublishedRelayList: (
    pk: string,
    list: RelayConfig[],
    createdAt?: number,
  ) => Promise<AdoptResult>;
}

/**
 * Once per signed-in account, after cold start has settled, check whether
 * the user provably has no DM inbox list, so Settings → Messages can offer
 * one (`checkDefaultDmInbox`). Never signs or publishes. Re-runs only when
 * the account or signer changes; the per-account state and backoff stop
 * repeats.
 */
export function useDefaultDmInbox(params: UseDefaultDmInboxParams): void {
  // Read the newest relay lists when the timer fires, not those at sign-in.
  const latest = useRef(params);
  latest.current = params;
  const { pubkey, isLoggedIn, signerType } = params;
  useEffect(() => {
    if (!pubkey || !isLoggedIn || !signerType) return;
    let cancelled = false;
    let task: { cancel: () => void } | undefined;
    // This account, still signed in, and its relay state untouched.
    const isActive = () =>
      !cancelled &&
      getCurrentUserPubkey() === pubkey &&
      latest.current.pubkey === pubkey &&
      latest.current.isLoggedIn;
    const timer = setTimeout(() => {
      task = idleScheduler.runWhenIdle(() => {
        if (!isActive()) return;
        const p = latest.current;
        void checkDefaultDmInbox({
          pubkey,
          nip65Relays: p.nip65Relays,
          readRelays: p.getReadRelays(),
          knownInbox: () => latest.current.dmInboxLive.relays(),
          knownInboxCreatedAt: () => latest.current.dmInboxLive.createdAt(pubkey),
          adopt: p.applyPublishedDmInbox,
          adoptRelayList: p.applyPublishedRelayList,
          // Bound to this moment: a reset (account switch) refuses the adoption.
          session: p.dmInboxLive.session(),
          isActive,
        })
          .then((outcome) => {
            if (__DEV__) console.log(`[Nostr] default DM inbox check: ${outcome}`);
          })
          .catch((e) => console.warn('[Nostr] default DM inbox check failed:', e));
      });
    }, DEFAULT_DM_INBOX_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [pubkey, isLoggedIn, signerType]);
}
