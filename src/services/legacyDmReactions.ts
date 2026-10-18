// Our own public DM reactions from older Lightning Piggy builds (before
// #1319 gift-wrapped them). Reading them is a 500-limit relay query to every
// write relay, so it runs once per account per app session, shared by every
// NIP-17 thread, rather than on each thread open. An account whose read came
// back empty from every relay asked gets a marker, and later sessions skip the query for a week:
// new accounts never had public DM reactions, and this build makes none.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { perAccountKey } from './perAccountStorage';
import type { ChatReactionEvent } from '../utils/nip17Reactions';

export const LEGACY_DM_REACTIONS_NONE_KEY_BASE = 'legacy_dm_reactions_none_v1';
export const LEGACY_DM_REACTIONS_NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Our public DM reactions as read, and whether every intended relay answered. */
export interface OwnDmReactionsRead {
  events: ChatReactionEvent[];
  complete: boolean;
}

const session = new Map<string, Promise<ChatReactionEvent[] | null>>();

const markerKey = (pubkey: string) => perAccountKey(LEGACY_DM_REACTIONS_NONE_KEY_BASE, pubkey);

async function hasFreshNoneMarker(pubkey: string): Promise<boolean> {
  const raw = await AsyncStorage.getItem(markerKey(pubkey)).catch(() => null);
  const at = raw === null ? NaN : Number(raw);
  return Number.isFinite(at) && Date.now() - at < LEGACY_DM_REACTIONS_NONE_TTL_MS;
}

/**
 * `pubkey`'s own legacy public DM reactions, read through `fetch` at most
 * once per session. Never rejects: null means the read failed, and that isn't
 * kept, so the next caller tries again.
 */
export function readOwnLegacyDmReactions(
  pubkey: string,
  fetch: () => Promise<OwnDmReactionsRead>,
): Promise<ChatReactionEvent[] | null> {
  const me = pubkey.toLowerCase();
  const cached = session.get(me);
  if (cached) return cached;
  // Assigned before either closure below reads it (both run after an await).
  let read: Promise<ChatReactionEvent[] | null> | undefined = undefined;
  read = (async () => {
    if (await hasFreshNoneMarker(me)) return [];
    const result = await fetch();
    const events = result.events.filter((e) => e.pubkey.toLowerCase() === me);
    // Still this session's read (not wiped meanwhile): remember an empty one,
    // but only when every relay answered (a partial read can miss some).
    if (events.length === 0 && result.complete && session.get(me) === read) {
      await AsyncStorage.setItem(markerKey(me), String(Date.now())).catch(() => undefined);
    }
    return events;
  })().catch(() => {
    if (session.get(me) === read) session.delete(me);
    return null;
  });
  session.set(me, read);
  return read;
}

/** Drops `pubkey`'s cached read and its empty-read marker (account wipe). */
export async function forgetOwnLegacyDmReactions(pubkey: string): Promise<void> {
  const me = pubkey.toLowerCase();
  session.delete(me);
  await AsyncStorage.removeItem(markerKey(me)).catch(() => undefined);
}
