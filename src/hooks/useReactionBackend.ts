import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useNostr } from '../contexts/NostrContext';
import { marmotReactionSource } from '../services/marmotReactions';
import { nip17ReactionSource, type ChatRumor } from '../services/nip17ReactionSource';
import { fetchOwnDmReactions } from '../services/nostrReactions';
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';
import { enabledAppRelays, loadAppRelayPrefs } from '../services/appRelayPrefs';
import type { OwnDmReactionsRead } from '../services/legacyDmReactions';
import type { DmProtocol } from '../utils/dmProtocol';
import type { UseConversationReactionsParams } from './useConversationReactions';

type Backend = Pick<
  UseConversationReactionsParams,
  | 'fetchReactionsForMessages'
  | 'publishReaction'
  | 'deleteReaction'
  | 'fetchReactionDeletions'
  | 'subscribeLiveReactions'
>;

// Nothing was read, so nothing is known to be empty.
const noOwnReactions = async (): Promise<OwnDmReactionsRead> => ({ events: [], complete: false });

/** Gift-wraps a rumor to the recipients (NostrContext's `sendDirectRumor`). */
export type SendChatRumor = (
  recipients: string[],
  rumor: ChatRumor,
  hooks: { protocol: DmProtocol },
) => Promise<{ success: boolean }>;

/**
 * Where a 1:1 thread's reactions live:
 *  - Marmot: inside its MLS group (White Noise's format, so they show up there too).
 *  - NIP-17: gift-wrapped kind-7 / kind-5 rumors, like the messages (#1319).
 *    Public reactions from older builds are still read.
 *  - NIP-04: public NIP-25 reactions on the relays (`relayBackend`). The
 *    kind-4 messages they target are public events already.
 */
export function useReactionBackend(
  protocol: DmProtocol,
  myPubkey: string | null,
  peerPubkey: string,
  relayBackend: Omit<Backend, 'subscribeLiveReactions'>,
  sendDirectRumor: SendChatRumor,
  /** Our own public DM reactions from earlier builds (NIP-17 threads only). */
  fetchOwnPublicDmReactions: () => Promise<OwnDmReactionsRead> = noOwnReactions,
): Backend {
  // Latest send / read / relay functions without rebuilding the source (and
  // re-subscribing, re-reading) whenever their identity changes, e.g. on a
  // relay-list update.
  const sendRef = useRef(sendDirectRumor);
  const ownRef = useRef(fetchOwnPublicDmReactions);
  const relayRef = useRef(relayBackend);
  useEffect(() => {
    sendRef.current = sendDirectRumor;
    ownRef.current = fetchOwnPublicDmReactions;
    relayRef.current = relayBackend;
  }, [sendDirectRumor, fetchOwnPublicDmReactions, relayBackend]);
  const own = useMemo<Backend | null>(() => {
    if (!myPubkey) return null;
    if (protocol === 'marmot') {
      const marmot = marmotReactionSource(myPubkey, peerPubkey);
      return {
        fetchReactionsForMessages: marmot.fetchReactionsForMessages,
        fetchReactionDeletions: marmot.fetchReactionDeletions,
        publishReaction: marmot.publishReaction,
        deleteReaction: marmot.deleteReaction,
        subscribeLiveReactions: marmot.subscribe,
      };
    }
    if (protocol === 'nip17') {
      const nip17 = nip17ReactionSource({
        myPubkey,
        peerPubkey,
        sendRumor: async (rumor) =>
          (await sendRef.current([peerPubkey], rumor, { protocol: 'nip17' })).success,
        publicReactions: {
          fetchOwnDmReactions: () => ownRef.current(),
          fetchReactionDeletions: (ids) => relayRef.current.fetchReactionDeletions(ids),
          deleteReaction: (id) => relayRef.current.deleteReaction(id),
        },
      });
      return {
        fetchReactionsForMessages: nip17.fetchReactionsForMessages,
        fetchReactionDeletions: nip17.fetchReactionDeletions,
        publishReaction: nip17.publishReaction,
        deleteReaction: nip17.deleteReaction,
        subscribeLiveReactions: nip17.subscribe,
      };
    }
    return null;
  }, [protocol, myPubkey, peerPubkey]);
  return own ?? relayBackend;
}

/** A 1:1 thread's reaction backend, wired to the signed-in account. */
export function useThreadReactionBackend(
  protocol: DmProtocol,
  myPubkey: string | null,
  peerPubkey: string,
): Backend {
  const {
    publishReaction,
    deleteReaction,
    fetchReactionsForMessages,
    fetchReactionDeletionsForReactions,
    sendDirectRumor,
    relays,
  } = useNostr();
  const relayBackend = useMemo(
    () => ({
      fetchReactionsForMessages,
      publishReaction,
      deleteReaction,
      fetchReactionDeletions: fetchReactionDeletionsForReactions,
    }),
    [
      fetchReactionsForMessages,
      publishReaction,
      deleteReaction,
      fetchReactionDeletionsForReactions,
    ],
  );
  // Where earlier builds published our DM reactions: write relays + defaults.
  const fetchOwnPublic = useCallback(async (): Promise<OwnDmReactionsRead> => {
    if (!myPubkey) return { events: [], complete: false };
    // Until the app relay prefs load, the defaults read as none: wait for
    // them, and if they can't load the read is partial.
    const prefsLoaded = await loadAppRelayPrefs(myPubkey).then(
      () => true,
      () => false,
    );
    const publishRelays = [
      ...relays.filter((r) => r.write).map((r) => r.url),
      ...enabledAppRelays('default', DEFAULT_RELAYS, myPubkey),
    ];
    const read = await fetchOwnDmReactions(myPubkey, [...new Set(publishRelays)]);
    return { events: read.events, complete: read.complete && prefsLoaded };
  }, [myPubkey, relays]);
  return useReactionBackend(
    protocol,
    myPubkey,
    peerPubkey,
    relayBackend,
    sendDirectRumor,
    fetchOwnPublic,
  );
}
