import { useAppRelayPrefs } from './useAppRelayPrefs';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { decodeLivePingPayload, type LiveUpdateKey } from '../services/liveLocationService';
import { decryptIncomingLivePing } from '../services/liveLocationPingReceive';
import {
  getLiveUpdate,
  getLiveUpdatesVersion,
  ingestLiveUpdate,
  liveKey,
  subscribeLiveUpdates,
  type LiveUpdate,
} from '../services/liveLocationUpdateStore';
import {
  decryptSessionLiveUpdate,
  subscribeLiveLocationPingsMulti,
  subscribeSessionLiveUpdates,
} from '../services/nostrLiveLocation';
import { LIVE_LOCATION_PING_KIND } from '../services/liveLocationService';
import { DEFAULT_RELAYS as DEFAULT_NOSTR_RELAYS } from '../services/nostrService';
import type { RelayConfig } from '../types/nostr';

/** An inbound share a viewer is watching. */
export interface WatchedShare {
  /** Hex pubkey of the share's owner (the start marker's sender). */
  sender: string;
  sessionId: string;
  startedAt: number;
  /** NIP-17 session-key channel from the start marker (absent on legacy shares). */
  updateKey?: LiveUpdateKey;
  /** Marmot share — its updates arrive over MLS, not from a relay REQ. */
  marmot?: boolean;
}

const sharesKey = (shares: WatchedShare[]) =>
  shares
    .map((s) => `${s.sender}:${s.sessionId}:${s.updateKey?.pubkey ?? ''}:${s.marmot ? 1 : 0}`)
    .join('|');

/**
 * Read the coalesced update store (#1300) for `shares`: the latest fix per
 * share, keyed `sender:sessionId` (liveKey). Re-renders at most once per
 * store flush (≤150 ms), never per relay / MLS event.
 */
export function useLiveUpdates(shares: WatchedShare[]): Record<string, LiveUpdate | undefined> {
  const version = useSyncExternalStore(subscribeLiveUpdates, getLiveUpdatesVersion);
  const key = sharesKey(shares);
  return useMemo(() => {
    const out: Record<string, LiveUpdate | undefined> = {};
    for (const s of shares) {
      const u = getLiveUpdate(s.sender, s.sessionId);
      if (u) out[liveKey(s.sender, s.sessionId)] = u;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the stable surrogate for shares; version bumps once per flush
  }, [key, version]);
}

/**
 * Open the relay subscriptions that feed the update store for the NIP-17
 * shares in `shares` (Marmot shares are fed by the MLS listener):
 *   - ONE REQ by session pubkey for current (session-key, NIP-44) updates —
 *     decrypted with the secret from the start marker, no signer involved;
 *   - ONE legacy REQ for shares from older builds (author-signed NIP-04),
 *     decrypted with the viewer's signer as before.
 * Both are bounded by the earliest share start + a limit, and close when the
 * share set changes or the caller disables them.
 */
export function useLiveUpdateRelaySubscriptions(params: {
  shares: WatchedShare[];
  enabled: boolean;
  myPubkey: string | null;
  signerType: string | null;
  relays: RelayConfig[];
}): void {
  const { shares, enabled, myPubkey, signerType, relays } = params;
  const relayScope = useAppRelayPrefs();
  const key = sharesKey(shares);
  const relayKey = relays
    .filter((r) => r.read)
    .map((r) => r.url)
    .sort()
    .join('|');
  useEffect(() => {
    const relayShares = shares.filter((s) => !s.marmot);
    if (!enabled || !myPubkey || relayShares.length === 0) return;
    let cancelled = false;
    const targetRelays = Array.from(
      new Set([
        ...relays.filter((r) => r.read).map((r) => r.url),
        ...enabledAppRelays('default', DEFAULT_NOSTR_RELAYS),
      ]),
    );
    const sinceFor = (list: WatchedShare[]) =>
      Math.floor(Math.min(...list.map((s) => s.startedAt)) / 1000) - 60;
    const unsubs: (() => void)[] = [];

    const keyed = relayShares.filter((s) => s.updateKey);
    if (keyed.length > 0) {
      const byPubkey = new Map(keyed.map((s) => [s.updateKey!.pubkey, s]));
      unsubs.push(
        subscribeSessionLiveUpdates({
          sessionPubkeys: [...byPubkey.keys()],
          since: sinceFor(keyed),
          relays: targetRelays,
          onEvent: (ev) => {
            if (cancelled) return;
            const share = byPubkey.get(ev.pubkey);
            if (!share?.updateKey) return;
            const plain = decryptSessionLiveUpdate(share.updateKey.secret, ev.content);
            const payload = plain ? decodeLivePingPayload(plain) : null;
            if (payload && payload.sessionId === share.sessionId) {
              ingestLiveUpdate(share.sender, payload);
            }
          },
        }),
      );
    }

    const legacy = relayShares.filter((s) => !s.updateKey);
    if (legacy.length > 0) {
      const sessionOwners = new Map(legacy.map((s) => [s.sessionId, s.sender]));
      unsubs.push(
        subscribeLiveLocationPingsMulti({
          viewerPubkey: myPubkey,
          senderPubkeys: Array.from(new Set(legacy.map((s) => s.sender))),
          sessionIds: legacy.map((s) => s.sessionId),
          kind: LIVE_LOCATION_PING_KIND,
          since: sinceFor(legacy),
          relays: targetRelays,
          onEvent: async (ev) => {
            const payload = await decryptIncomingLivePing({
              signerType,
              content: ev.content,
              senderPubkey: ev.pubkey,
              viewerPubkey: myPubkey,
            });
            // Route by sessionId, and only from the session's own author.
            if (!cancelled && payload && sessionOwners.get(payload.sessionId) === ev.pubkey) {
              ingestLiveUpdate(ev.pubkey, payload);
            }
          },
        }),
      );
    }
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key / relayKey are stable surrogates for shares / relays
  }, [key, enabled, myPubkey, signerType, relayKey, relayScope]);
}
