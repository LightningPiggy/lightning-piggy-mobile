import AsyncStorage from '@react-native-async-storage/async-storage';
import { perAccountKey } from '../services/perAccountStorage';
import {
  DM_INBOX_DEFAULT_BACKOFF_KEY_BASE,
  DM_INBOX_DEFAULT_STATE_KEY_BASE,
  DM_INBOX_RELAYS_CACHE_KEY_BASE,
} from './nostrCacheKeys';
import { readAdoptedCreatedAt } from './useNip65Relays';

/**
 * Per-account persistence for the default DM inbox list (`defaultDmInbox.ts`):
 * the settled state, the backoff after inconclusive checks, and whether the
 * app already knows an inbox list.
 *
 * Every read FAILS CLOSED: storage that can't be read (or holds garbage) is
 * `'unreadable'`, never "nothing there" — and then callers write nothing.
 *
 * States:
 * - `exists`    a list was found (here or in the app's cache) — nothing to do.
 * - `published` the app published the default (onboarding, or the user tapped).
 * - `suggest`   provably none: Settings → Messages offers to publish one.
 * - `dismissed` the user chose "Not now" on that suggestion.
 */
export type DefaultDmInboxState = 'exists' | 'published' | 'suggest' | 'dismissed';
export type Unreadable = 'unreadable';

const STATES: readonly string[] = ['exists', 'published', 'suggest', 'dismissed'];
/** Inconclusive checks in a row before backing off, and for how long. */
export const UNKNOWN_BACKOFF_AFTER = 3;
export const UNKNOWN_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;

const key = (base: string, pk: string) => perAccountKey(base, pk);
/** Parsed JSON, `null` when absent; rejects on a read error or garbage. */
const readJson = async (k: string): Promise<unknown> => {
  const raw = await AsyncStorage.getItem(k);
  return raw === null ? null : (JSON.parse(raw) as unknown);
};

export async function readDefaultDmInboxState(
  pk: string,
): Promise<DefaultDmInboxState | null | Unreadable> {
  try {
    const value = await AsyncStorage.getItem(key(DM_INBOX_DEFAULT_STATE_KEY_BASE, pk));
    if (value === null) return null;
    return STATES.includes(value) ? (value as DefaultDmInboxState) : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

export async function writeDefaultDmInboxState(pk: string, state: DefaultDmInboxState) {
  await AsyncStorage.setItem(key(DM_INBOX_DEFAULT_STATE_KEY_BASE, pk), state).catch(() => {});
}

/**
 * Whether ANY DM inbox list is known for `pk`: in memory (list or adopted
 * created_at), cached (even an empty list), or ever adopted.
 */
export async function knownDmInbox(
  pk: string,
  live: string[],
  liveCreatedAt = 0,
): Promise<'known' | 'none' | Unreadable> {
  if (live.length > 0 || liveCreatedAt > 0) return 'known';
  try {
    // A cached list — even an intentionally empty one — is a list.
    if ((await readJson(key(DM_INBOX_RELAYS_CACHE_KEY_BASE, pk))) !== null) return 'known';
    return (await readAdoptedCreatedAt(pk, 10050)) > 0 ? 'known' : 'none';
  } catch {
    return 'unreadable';
  }
}

interface Backoff {
  unknowns: number;
  until: number;
}

async function readBackoff(pk: string): Promise<Backoff | Unreadable> {
  try {
    const v = (await readJson(key(DM_INBOX_DEFAULT_BACKOFF_KEY_BASE, pk))) as Backoff | null;
    if (v === null) return { unknowns: 0, until: 0 };
    const unknowns = Number(v.unknowns);
    const until = Number(v.until);
    return Number.isFinite(unknowns) && Number.isFinite(until) ? { unknowns, until } : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Waiting out a run of inconclusive checks (AUTH-gated write relay, indexers off, …)? */
export async function isBackedOff(pk: string, now = Date.now()): Promise<boolean | Unreadable> {
  const backoff = await readBackoff(pk);
  return backoff === 'unreadable' ? backoff : backoff.until > now;
}

/** One more inconclusive check: after `UNKNOWN_BACKOFF_AFTER` in a row, wait a week. */
export async function recordUnknown(pk: string, now = Date.now()) {
  const backoff = await readBackoff(pk);
  if (backoff === 'unreadable') return; // fail closed: write nothing
  const unknowns = backoff.unknowns + 1;
  const until = unknowns >= UNKNOWN_BACKOFF_AFTER ? now + UNKNOWN_BACKOFF_MS : 0;
  await AsyncStorage.setItem(
    key(DM_INBOX_DEFAULT_BACKOFF_KEY_BASE, pk),
    JSON.stringify({ unknowns, until }),
  ).catch(() => {});
}

export async function clearBackoff(pk: string) {
  await AsyncStorage.removeItem(key(DM_INBOX_DEFAULT_BACKOFF_KEY_BASE, pk)).catch(() => {});
}
