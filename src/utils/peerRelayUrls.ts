import { isPublicRelayUrl } from './publicUrl';
import { normalizeRelayUrl } from './relayListKey';

// Sanitising for relay URLs SOMEONE ELSE published (#1570): a peer's kind-10050
// inbox list or kind-10002 relay list. The app connects to these automatically
// when it delivers a message, so they are attacker-controlled input — a hostile
// list could otherwise point the phone at the reader's own network or fan one
// send out to hundreds of sockets.
//
// Only credential-free public `wss://` relays survive (the strict parser in
// ./publicUrl: no `ws://`, no loopback / LAN / link-local / reserved hosts, no
// `localhost` / `.local`, no ambiguous numeric hosts), normalised and deduped
// the way the pool keys its sockets, and capped. Plain `ws://` is never
// accepted here: the LAN test relay is reached only through the test-relay
// lockdown (`lockRelays`), never because a list named it.

/** Most relays taken from one peer's list. */
export const MAX_RELAYS_PER_PEER = 4;

/** Entries examined per list, so an oversized list costs bounded work. */
export const MAX_PEER_RELAY_CANDIDATES = 32;

/** Longest relay URL accepted from a peer. */
export const MAX_PEER_RELAY_URL_LENGTH = 200;

/** The usable, deduped relays from an untrusted peer-supplied list. */
export function sanitizePeerRelayUrls(
  urls: readonly unknown[],
  max: number = MAX_RELAYS_PER_PEER,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls.slice(0, MAX_PEER_RELAY_CANDIDATES)) {
    if (out.length >= max) break;
    if (typeof raw !== 'string' || raw.length > MAX_PEER_RELAY_URL_LENGTH) continue;
    if (!isPublicRelayUrl(raw)) continue;
    const url = normalizeRelayUrl(raw);
    // Normalising must not turn an accepted URL into something else.
    if (!isPublicRelayUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
