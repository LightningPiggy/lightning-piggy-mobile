// Which 1:1 group a chat uses, and which relays a chat's group lives on.
//
// Two Marmot DM groups for one pair of people happen: two installs of one
// account (or both people) start the chat at once, or a Welcome lands late.
// Each install used to pick the group IT saw last (local create / join time),
// so the two sides could settle on different groups — and an install that
// isn't in the other side's group never sees their messages, while its own
// go to a group they no longer read (a 1.6.0 chat split exactly like that).
// Rank by relay activity instead: the newest kind-445 on a group's relays is
// the same for every member, so everyone in both groups agrees, and a later
// join of a stale group can't flip the choice. A group with no traffic seen
// yet ranks by when we made or joined it, so a freshly (re)started chat still
// takes over from a dead one — and the peer's device sync adds any of our
// installs it lacks, after which those agree too.
//
// Relays: a group used to get only its creator's NIP-65 write relays, so an
// account writing to one relay made single-relay chats: one dropped or
// pruned event and members can't catch up. New chats get at least
// MIN_GROUP_RELAYS (ours first, then the Marmot relays, then defaults), and
// an existing 1:1 below that is topped up by one admin commit that keeps
// every relay it already has, so members on older versions still hear it.

import { enabledAppRelays } from './appRelayPrefs';
import { MARMOT_KEY_PACKAGE_RELAYS } from './marmotKeyPackageRelays';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';

export const MIN_GROUP_RELAYS = 3;
export const MAX_GROUP_RELAYS = 6;

export interface DmCandidate {
  id: string;
  /** When this install made or joined the group (ms). */
  createdAt: number;
  /** Newest kind-445 seen on the group's relays (ms), if any. */
  activityAt?: number;
}

/** The 1:1 group to use among several with the same person (see above). */
export function pickDm<T extends DmCandidate>(dms: readonly T[]): T | undefined {
  const rank = (g: T) => g.activityAt ?? g.createdAt;
  return [...dms].sort(
    (a, b) =>
      rank(b) - rank(a) || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

/** A group's relay activity in ms, from the per-`h` kind-445 watermarks (seconds). */
export function groupActivityMs(
  watermarks: ReadonlyMap<string, number>,
  h: string | undefined,
): number | undefined {
  const secs = h ? watermarks.get(h) : undefined;
  return secs ? secs * 1000 : undefined;
}

/** Relays to fill a group up with, best first. Test accounts get the test relay only. */
export function groupRelayFallbacks(owner: string): string[] {
  return [
    ...enabledAppRelays('marmot', MARMOT_KEY_PACKAGE_RELAYS, owner),
    ...enabledAppRelays('default', DEFAULT_RELAYS, owner),
  ];
}

// Trimmed, no trailing slash, de-duplicated. No public-URL filter: the old
// path used write relays as-is, and a LAN test relay must survive.
const norm = (url: string) => url.trim().replace(/\/+$/, '');
function uniqueRelays(urls: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const url of urls.map(norm)) {
    if (url && !out.includes(url)) out.push(url);
    if (out.length === max) break;
  }
  return out;
}

/** A new chat's relays: our write relays, plus at least one more, MIN..MAX in all. */
export function groupRelaysFor(own: readonly string[], fallbacks: readonly string[]): string[] {
  const mine = uniqueRelays(own, MAX_GROUP_RELAYS - 1);
  const target = Math.min(MAX_GROUP_RELAYS, Math.max(MIN_GROUP_RELAYS, mine.length + 1));
  return uniqueRelays([...mine, ...fallbacks], target);
}

/** An existing group's relays topped up to MIN_GROUP_RELAYS (all kept), or null if it has enough. */
export function relayTopUp(current: readonly string[], fallbacks: readonly string[]) {
  if (current.length >= MIN_GROUP_RELAYS) return null;
  const have = new Set(current.map(norm));
  const extra = uniqueRelays(fallbacks, MAX_GROUP_RELAYS).filter((r) => !have.has(r));
  const added = extra.slice(0, MIN_GROUP_RELAYS - current.length);
  return added.length > 0 ? [...current, ...added] : null;
}
