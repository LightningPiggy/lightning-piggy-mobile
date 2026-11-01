// Which 1:1 group a chat uses, and which relays a chat's group lives on.
//
// Two Marmot DM groups for one pair of people happen: two installs of one
// account (or both people) start the chat at once, a create whose Welcome
// went unacknowledged is retried, or a Welcome lands late. Each install used
// to pick the group IT saw last (local create / join time), so the two sides
// could settle on different groups — and an install that isn't in the other
// side's group never sees their messages, while its own go to a group they
// no longer read (a 1.6.0 chat split exactly like that).
//
// Rank by authenticated activity instead: the newest MLS message decrypted
// in the group (or sent / created there by us). Members of both groups see
// the same messages, so they agree; equal times break by group id, never by
// a local join order. Relay `created_at` alone is not used — anyone can post
// a kind-445 with a group's public `h` tag. A group with no activity yet
// (just joined, or a Welcome that landed late) never outranks one that has
// some: it takes over once a message is sent in it — the next message after
// a Repair or a retried create. Only when no group has activity does local
// create / join time decide.
//
// Relays: a group used to get only its creator's NIP-65 write relays, so an
// account writing to one relay made single-relay chats: one dropped or
// pruned event and members can't catch up. New chats get at least
// MIN_GROUP_RELAYS (ours first, then the Marmot relays, then defaults), and
// an existing 1:1 below that is topped up by one admin commit that keeps
// every relay it already has, so members on older versions still hear it.

import { enabledAppRelays } from './appRelayPrefs';
import { isMarmotMessageKind } from './marmotKinds';
import { MARMOT_KEY_PACKAGE_RELAYS } from './marmotKeyPackageRelays';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';

export const MIN_GROUP_RELAYS = 3;
export const MAX_GROUP_RELAYS = 6;

export interface DmCandidate {
  id: string;
  /** When this install made or joined the group (ms). */
  createdAt: number;
  /** Newest authenticated activity in the group (ms), if any (GroupActivity). */
  activityAt?: number;
}

const byId = (a: DmCandidate, b: DmCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The 1:1 group to use among several with the same person (see above). */
export function pickDm<T extends DmCandidate>(dms: readonly T[]): T | undefined {
  return [...dms].sort((a, b) => {
    if (a.activityAt === undefined && b.activityAt === undefined)
      return b.createdAt - a.createdAt || byId(a, b);
    if (a.activityAt === undefined) return 1;
    if (b.activityAt === undefined) return -1;
    return b.activityAt - a.activityAt || byId(a, b);
  })[0];
}

/** Sender-controlled times are trusted at most this far ahead of our clock. */
export const MAX_ACTIVITY_SKEW_MS = 5 * 60_000;

/**
 * Newest authenticated activity per MLS group (ms): messages that decrypted,
 * and our own sends and creates. Only moves forward; `persist` stores each
 * advance (load it back into `map` on start).
 */
export class GroupActivity {
  readonly map = new Map<string, number>();
  constructor(
    private readonly persist: (idStr: string, ms: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get(idStr: string): number | undefined {
    return this.map.get(idStr);
  }

  note(idStr: string, ms: number): void {
    const at = Math.min(ms, this.now() + MAX_ACTIVITY_SKEW_MS);
    if (!Number.isFinite(at) || at <= (this.map.get(idStr) ?? 0)) return;
    this.map.set(idStr, at);
    this.persist(idStr, at);
  }
}

/** Only chat messages count — never push tokens, reactions, edits, deletes or
 *  live-location ticks, which clients also send into superseded groups. */
export function noteRumor(
  activity: GroupActivity,
  idStr: string,
  rumor: { kind: number; created_at: number },
): void {
  if (isMarmotMessageKind(rumor.kind)) activity.note(idStr, rumor.created_at * 1000);
}

/**
 * First start with activity tracking (or a group with none yet): seed it from
 * the stored history. Only messages FROM others — they decrypted, so a member
 * sent them; our own are stored before publishing, so a failed send would
 * look like activity.
 */
export function seedActivity(
  activity: GroupActivity,
  idStr: string,
  stored: readonly { pubkey: string; kind: number; created_at: number }[],
  me: string,
): void {
  const self = me.toLowerCase();
  for (const rumor of stored) {
    if (rumor.pubkey.toLowerCase() !== self) noteRumor(activity, idStr, rumor);
  }
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

/** Thrown inside a top-up commit's builder when the group already has enough relays. */
export class RelaysAlreadyTopped extends Error {
  constructor() {
    super('marmot: group already has enough relays');
    this.name = 'RelaysAlreadyTopped';
  }
}
