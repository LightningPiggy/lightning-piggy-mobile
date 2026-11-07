/**
 * The app's built-in relay lists (#1326). Kept apart from `nostrService` so
 * they're easy to audit, and so `nostrRelayDefaults.test.ts` can fail the
 * build if a relay known to be dead comes back.
 *
 * Checked 2026-10-11 from three networks (War Machine, black-panther, an
 * external fetcher): connect + EOSE time, NIP-11, whether an unknown key may
 * write, and how far back the relay serves events. Rules:
 *  - every list has at least 3 healthy relays run by different operators;
 *  - nos.lol / nostr.mom (one server, intermittently unreachable /
 *    rate-limited for some IPs) only appear as an extra alongside enough
 *    healthy relays, never as a list's backbone;
 *  - relay.nostr.band, relay.nostr.net and relay.nsec.app are gone (dead);
 *  - relay.snort.social isn't used: it's an in-memory relay (memlay) that
 *    serves nothing older than about an hour.
 * `./relayHealth` skips whichever of these is down at runtime.
 */

/**
 * General-purpose read + write relays: profiles, follow lists, DMs,
 * reactions, Marmot fallbacks. All accept writes from any key and keep
 * history. Order matters: `buildProfileRelayHints` embeds the first entries
 * as nprofile hints, so the most reliable relays go first.
 */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
  'wss://relay.coinos.io',
  'wss://nos.lol',
];

/**
 * Read-only lookups of profile metadata (kind 0), unioned with the user's
 * read relays. purplepag.es / user.kindpag.es index kind 0 / 3 / 10002 from
 * across the network. nostr.land isn't used: it's a paid relay that limits or
 * rejects reads from non-subscribers, so it only added connections and
 * timeouts. White Noise publishes its users' profiles to its own relays,
 * which the indexers don't always pick up, so Marmot group members who use
 * White Noise otherwise show as bare npubs.
 */
export const PROFILE_RELAYS = [
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://relay.eu.whitenoise.chat',
  'wss://relay.us.whitenoise.chat',
];

/**
 * Relays named in the `nostrconnect://` pairing URI (NIP-46). The bunker
 * replies on any of them, so one dead relay no longer breaks sign-in (#1198).
 * All three accept kind 24133 from unknown keys.
 */
export const NIP46_PAIRING_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
  'wss://nos.lol',
];

/**
 * Where Lightning Piggy's Marmot push servers (Transponder) listen and publish
 * their kind-10050 inbox list. Push records carry no relay hint, so a sender
 * finds a server's relays from that 10050 — these are queried first so the
 * lookup lands where the list lives. Server-side setting: keep in step with
 * the servers' config (no app release needed to move them; this list only
 * helps the lookup).
 */
export const MARMOT_PUSH_SERVER_RELAYS = [
  'wss://relay.eu.whitenoise.chat',
  'wss://relay.ditto.pub',
  'wss://relay.coinos.io',
  'wss://relay.primal.net',
];
