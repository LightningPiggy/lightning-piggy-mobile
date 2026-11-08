import { getKeyPackageRelays, type NostrNetworkInterface } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent } from 'nostr-tools';

import { sanitizePeerRelayUrls } from '../utils/peerRelayUrls';

// Where a Marmot Welcome is published (#1402). The Nostr transport ("Account
// inbox relays") sends gift-wrapped Welcomes to the invitee's kind-10050
// inbox, and lets a sender add contextual relay hints it learned for that
// recipient. So, in order:
//   1. the invitee's 10050 inbox relays, alone;
//   2. only once a completed lookup CONFIRMS they publish no 10050: hints the
//      invitee published themselves — their NIP-65 read relays (where
//      Lightning Piggy, which publishes no 10050 by default, reads gift wraps)
//      and the `relays` tag of the KeyPackage being consumed;
//   3. else nowhere: the Welcome stays in the pre-signature queue
//      (MarmotWelcomePayloads) and is retried later, rather than going to
//      defaults. The spec is explicit that a lookup or default relay doesn't
//      become a destination because a list is missing.
// An inbox lookup that couldn't tell (no relay answered) is NOT "no inbox":
// falling through to the hints then would sign the Welcome and freeze it on
// relays a White Noise invitee — who reads only its 10050 — never reads. It
// stays queued unsigned, and the next retry decides again from a fresh lookup.
// The group's relays aren't used either: the invitee reads them only after
// joining. Test accounts are unaffected — the network keeps them on the LAN.

/** Most hint relays one Welcome goes to (read relays first, then KeyPackage hints). */
export const MAX_WELCOME_HINT_RELAYS = 8;

/**
 * Why a Welcome has nowhere to go yet:
 * - `noRelays`: confirmed — the invitee publishes no 10050 and no hints;
 * - `unknown`: their inbox lookup couldn't tell (relays unreachable).
 */
export type NoWelcomeRelaysReason = 'noRelays' | 'unknown';

/** No destination for this Welcome yet; it stays queued, unsigned. */
export class MarmotNoWelcomeRelaysError extends Error {
  constructor(
    readonly recipient: string,
    readonly reason: NoWelcomeRelaysReason,
  ) {
    super(
      reason === 'noRelays'
        ? `No inbox or relay hint to send the Welcome to ${recipient.slice(0, 16)}…`
        : `Couldn't look up where to send the Welcome to ${recipient.slice(0, 16)}…`,
    );
    this.name = 'MarmotNoWelcomeRelaysError';
  }
}

/** None of the people being invited has anywhere a Welcome can go (confirmed). */
export class MarmotInviteesUnreachableError extends Error {
  constructor(readonly people: string[]) {
    super(`No inbox or relay hint for ${people.length} invitee(s)`);
    this.name = 'MarmotInviteesUnreachableError';
  }
}

/** The KeyPackage's own `relays` tag — untrusted peer input, so sanitised and capped. */
export function keyPackageRelayHints(keyPackage: NostrEvent, max?: number): string[] {
  try {
    return sanitizePeerRelayUrls(getKeyPackageRelays(keyPackage) ?? [], max);
  } catch {
    return []; // malformed tags
  }
}

/**
 * The relays a Welcome to `keyPackage`'s author goes to. Throws
 * `MarmotNoWelcomeRelaysError` when there are none yet — `unknown` when the
 * inbox lookup failed (`getUserInboxRelays` rejected), `noRelays` when
 * confirmed.
 */
export async function welcomeRelays(
  network: Pick<NostrNetworkInterface, 'getUserInboxRelays'>,
  keyPackage: NostrEvent,
  readRelays: (pubkey: string) => Promise<string[]> = async () => [],
): Promise<string[]> {
  const pubkey = keyPackage.pubkey;
  let inbox: string[];
  try {
    inbox = await network.getUserInboxRelays(pubkey);
  } catch {
    throw new MarmotNoWelcomeRelaysError(pubkey, 'unknown');
  }
  if (inbox.length > 0) return inbox;
  const read = await readRelays(pubkey).catch(() => [] as string[]);
  // One cap over the combined list, read relays first.
  const hints = sanitizePeerRelayUrls(
    [...read, ...keyPackageRelayHints(keyPackage, MAX_WELCOME_HINT_RELAYS)],
    MAX_WELCOME_HINT_RELAYS,
  );
  if (hints.length > 0) return hints;
  throw new MarmotNoWelcomeRelaysError(pubkey, 'noRelays');
}

/**
 * Before an Add commit: throws `MarmotInviteesUnreachableError` when it's
 * CONFIRMED that nobody being invited has a Welcome destination for any of
 * their devices. The commit would otherwise give them member leaves whose
 * Welcomes can't go anywhere — and a new chat would be created only to be
 * torn down — so nothing is created and the user is told this person can't be
 * reached yet. A lookup that couldn't tell doesn't block (the invite's own
 * delivery reports that). When anyone is reachable the invite goes ahead and
 * the others' Welcomes stay queued and are retried. The lookups are the shared
 * cached ones the Welcome itself uses next.
 */
export async function requireWelcomeDestination(
  network: Pick<NostrNetworkInterface, 'getUserInboxRelays'>,
  devices: ReadonlyMap<string, readonly NostrEvent[]>,
  readRelays: (pubkey: string) => Promise<string[]>,
): Promise<void> {
  if (devices.size === 0) return;
  /** True once one of the person's devices is reachable or might be. */
  const mayReach = async (keyPackages: readonly NostrEvent[]) => {
    for (const keyPackage of keyPackages) {
      const confirmedNone = await welcomeRelays(network, keyPackage, readRelays).then(
        () => false,
        (e: unknown) => e instanceof MarmotNoWelcomeRelaysError && e.reason === 'noRelays',
      );
      if (!confirmedNone) return true;
    }
    return false;
  };
  const results = await Promise.all([...devices.values()].map(mayReach));
  if (!results.some(Boolean)) throw new MarmotInviteesUnreachableError([...devices.keys()]);
}
