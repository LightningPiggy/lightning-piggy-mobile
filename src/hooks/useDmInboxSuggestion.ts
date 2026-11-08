import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { useAccountState } from '../contexts/useAccountState';
import {
  publishDefaultDmInbox,
  suggestedDmInboxRelays,
  readDefaultDmInboxState,
  writeDefaultDmInboxState,
  type DefaultDmInboxOutcome,
  type DefaultDmInboxState,
} from '../contexts/defaultDmInbox';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { getCurrentUserPubkey } from '../services/nostrActiveAccount';
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';

/**
 * The "publish your message inbox relays" suggestion in Settings → Messages,
 * for ANY account (imported nsec, Amber, NIP-46) the background check found
 * provably without a DM inbox list. The app never publishes one for an
 * existing account unasked; Publish re-runs the whole check first, so a list
 * published elsewhere meanwhile is adopted and kept.
 */
export function useDmInboxSuggestion() {
  const {
    pubkey,
    signerType,
    relays: appRelays,
    nip65Relays,
    dmInboxRelays,
    signEvent,
    applyPublishedDmInbox,
    applyPublishedRelayList,
    dmInboxLive,
  } = useNostr();
  // Read at each step of a publish, so a list or account change mid-way counts.
  const live = useRef({ pubkey, dmInboxRelays });
  live.current = { pubkey, dmInboxRelays };
  // What the app reads gift wraps from (as `getReadRelays`; the inbox list is
  // empty whenever this suggestion applies).
  const readRelays = useMemo(() => {
    const read = appRelays.filter((r) => r.read).map((r) => r.url);
    return read.length > 0 ? read : enabledAppRelays('default', DEFAULT_RELAYS);
  }, [appRelays]);
  const [state, setState] = useAccountState<DefaultDmInboxState | null>(pubkey, null);
  const [busy, setBusy] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (pubkey)
        void readDefaultDmInboxState(pubkey).then((value) => {
          // Unreadable storage: no card (fail closed).
          if (alive) setState(value === 'unreadable' ? null : value);
        });
      return () => {
        alive = false;
      };
    }, [pubkey, setState]),
  );
  const visible = state === 'suggest' && dmInboxRelays.length === 0;
  const relays = useMemo(
    () => (visible && pubkey ? suggestedDmInboxRelays(pubkey, nip65Relays, readRelays) : []),
    [visible, pubkey, nip65Relays, readRelays],
  );
  // Synchronous, so a double tap can't sign or publish twice (state lags a render).
  const inFlight = useRef(false);

  /** `confirm` approves a relay list that differs from the one shown. */
  const publish = useCallback(
    async (
      confirm: (relays: string[]) => Promise<boolean>,
    ): Promise<DefaultDmInboxOutcome | null> => {
      if (!pubkey || inFlight.current) return null;
      const pk = pubkey;
      inFlight.current = true;
      setBusy(true);
      try {
        const outcome = await publishDefaultDmInbox({
          pubkey: pk,
          nip65Relays,
          readRelays,
          knownInbox: () => live.current.dmInboxRelays,
          knownInboxCreatedAt: () => dmInboxLive.createdAt(pk),
          shownRelays: relays,
          confirm,
          sign: signEvent,
          adopt: applyPublishedDmInbox,
          adoptRelayList: applyPublishedRelayList,
          isActive: () => getCurrentUserPubkey() === pk && live.current.pubkey === pk,
        });
        if (outcome === 'exists') setState('exists');
        else if (outcome === 'published' || outcome === 'partial') setState('published');
        return outcome;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [
      pubkey,
      nip65Relays,
      readRelays,
      relays,
      signEvent,
      applyPublishedDmInbox,
      applyPublishedRelayList,
      dmInboxLive,
      setState,
    ],
  );

  const dismiss = useCallback(async () => {
    if (!pubkey) return;
    setState('dismissed');
    await writeDefaultDmInboxState(pubkey, 'dismissed');
  }, [pubkey, setState]);

  // Only a remote signer asks the user to approve (a local key signs here).
  const signerPrompts = signerType === 'amber' || signerType === 'nip46';
  return { visible, relays, busy, signerPrompts, publish, dismiss };
}
