import { enabledAppRelays } from './appRelayPrefs';
import { cleanKeyPackageRelays, MARMOT_KEY_PACKAGE_RELAYS } from './marmotKeyPackageRelays';
import { getPeerRelayLists, type PeerRelayLists } from './peerRelayLists';

// Marmot's reads of OTHER accounts' relay lists (#1402), through the shared
// peer relay-list cache (peerRelayLists, #1570): one entry per peer with the
// same TTLs (found / absent / unknown), newest-wins, sanitising and caps as
// NIP-17 delivery, so an invite followed by its Welcome — or a busy chat's
// device sync — asks the relays once, not on every call:
//   - kind 10051 (MIP-00 KeyPackage relays) and kind 10002 write relays: where
//     the peer's key packages are fetched from (marmotInvitees). The current
//     Nostr transport binding drops 10051 in favour of 10002 writes; it's
//     still read for White Noise interop (its installs publish one);
//   - kind 10050 (NIP-17 inbox), else the kind-10002 read relays: where a
//     Welcome to them goes (marmotWelcomeRelays).
// Lookups ask the well-known Marmot relays (where 10051s live) and the
// viewer's lookup relays; the shared service adds the indexers and defaults,
// and keeps a test account's reads on the LAN test relay. Nothing here runs at
// cold start: only an invite, a 1:1's device sync or a Welcome asks.

/** A peer's key-package discovery lists, sanitised; empty when absent or unknown. */
export interface KeyPackageRelayLists {
  keyPackage: readonly string[];
  write: readonly string[];
}

export type KeyPackageListLookup = (peer: string) => Promise<KeyPackageRelayLists>;

/** One session's lookups of its peers' lists. */
export interface MarmotPeerLists {
  /** Their 10051 + 10002 write relays (key-package discovery). */
  keyPackage: KeyPackageListLookup;
  /** Their NIP-65 read relays (a Welcome's hint when they publish no 10050). */
  read: (peer: string) => Promise<string[]>;
}

export const NO_KEY_PACKAGE_LISTS: KeyPackageListLookup = async () => ({
  keyPackage: [],
  write: [],
});

/** A session on an injected (test) network looks nothing up. */
export const NO_PEER_LISTS: MarmotPeerLists = {
  keyPackage: NO_KEY_PACKAGE_LISTS,
  read: async () => [],
};

/** Most of the viewer's own lookup relays asked (the service caps the total). */
const MAX_VIEWER_LOOKUP_RELAYS = 6;

/** The shared lookup with Marmot's relays added; `undefined` when it failed. */
async function lookup(
  peer: string,
  viewer: string | null,
  lookupRelays: readonly string[],
  withKeyPackageRelays = false,
): Promise<PeerRelayLists | undefined> {
  const result = await getPeerRelayLists(peer, {
    viewerPubkey: viewer,
    lookupRelays: [
      ...enabledAppRelays('marmot', MARMOT_KEY_PACKAGE_RELAYS, viewer),
      ...cleanKeyPackageRelays(lookupRelays, MAX_VIEWER_LOOKUP_RELAYS),
    ],
    withKeyPackageRelays,
  });
  return result.status === 'ok' ? result.lists : undefined;
}

/** `viewer`'s lookups of its peers' lists (one cached lookup per peer). */
export function marmotPeerLists(
  viewer: string | null,
  getLookupRelays: () => string[],
): MarmotPeerLists {
  return {
    keyPackage: async (peer) => {
      const lists = await lookup(peer, viewer, getLookupRelays(), true);
      return { keyPackage: lists?.keyPackage ?? [], write: lists?.write ?? [] };
    },
    read: async (peer) => [...((await lookup(peer, viewer, getLookupRelays()))?.read ?? [])],
  };
}

/**
 * The peer's kind-10050 inbox relays for a Welcome: `[]` only when their
 * absence is confirmed (`inboxAbsenceConfirmed`: an indexer completed the
 * lookup, or it found another of their lists), `undefined` when it couldn't
 * tell — a fast relay that never had the event isn't proof, and a Welcome
 * sent on that would be signed and frozen on fallback relays. Never
 * defaults: a missing inbox list stays missing (#1402).
 */
export async function marmotInboxRelays(
  peer: string,
  viewer: string | null,
  lookupRelays: readonly string[],
): Promise<string[] | undefined> {
  const lists = await lookup(peer, viewer, lookupRelays);
  if (!lists?.inbox) return lists?.inbox === null && lists.inboxAbsenceConfirmed ? [] : undefined;
  return [...lists.inbox];
}
