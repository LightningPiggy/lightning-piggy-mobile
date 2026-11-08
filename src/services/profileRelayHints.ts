import { normalizeRelayUrl } from '../utils/relayListKey';
import { enabledAppRelays } from './appRelayPrefs';
import { cachedAuthorWriteRelays } from './authorOutboxRelays';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';

/** Most hints in one outgoing nprofile: keeps URIs compact. */
const MAX_PROFILE_HINTS = 3;
/** Most of the target's own write relays among them, leaving room for a fallback. */
const MAX_TARGET_WRITE_HINTS = 2;

/** First `max` non-empty URLs, deduped on the normalised URL (first spelling kept). */
function firstDistinct(urls: readonly (string | null | undefined)[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (out.length >= max) break;
    if (!url) continue;
    const key = normalizeRelayUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

// Best-effort relay hints to embed in an outgoing nprofile. Prefers the
// target's own NIP-65 write relays when they're already cached (#1390 F8:
// where they actually publish — no lookup is made here), then the contact's
// kind-3 relay (where the user's follow entry suggests they publish), then
// the viewer's NIP-65 read relays (the places we already trust for profile
// fetches), and finally a small default slice so the nprofile never carries
// zero hints — an empty hint list defeats the purpose of nprofile vs. npub.
// Dedupes and caps at 3 to keep URIs compact; receiving clients still search
// their own relays on top.
export function buildProfileRelayHints(
  targetPubkey: string,
  viewerContacts: { pubkey: string; relay: string | null }[],
  viewerReadRelays: string[],
): string[] {
  const contactRelay = viewerContacts.find((c) => c.pubkey === targetPubkey)?.relay;
  return firstDistinct(
    [
      ...cachedAuthorWriteRelays(targetPubkey).slice(0, MAX_TARGET_WRITE_HINTS),
      contactRelay,
      ...viewerReadRelays,
      ...enabledAppRelays('default', DEFAULT_RELAYS),
    ],
    MAX_PROFILE_HINTS,
  );
}

// Relay hints to embed in the user's OWN nprofile when sharing it to an
// NFC tag / QR for first contact (#755). A conference badge is a cold
// first-contact medium: the scanner doesn't follow us yet, so the hints
// must point at our NIP-65 *write* (outbox) relays — the places we
// actually publish kind-0 + notes — so their client resolves us even on
// niche relays. Capped at `max` (default 2) to keep the payload inside an
// NTAG213's ~144 B and limit staleness if we later migrate relays. Falls
// back to the app defaults when the user has published no write relays,
// since a hint (even a generic one) still beats a bare npub. The bare
// pubkey is always in the nprofile, so a reader can fall back to outbox
// discovery if these hints go dead.
export function buildOwnProfileRelayHints(ownWriteRelays: string[], max = 2): string[] {
  const deduped: string[] = [];
  for (const r of [...ownWriteRelays, ...enabledAppRelays('default', DEFAULT_RELAYS)]) {
    if (!r) continue;
    if (deduped.includes(r)) continue;
    deduped.push(r);
    if (deduped.length >= max) break;
  }
  return deduped;
}
