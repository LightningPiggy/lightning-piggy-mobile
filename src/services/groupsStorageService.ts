import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Group, GroupActivity } from '../types/groups';
import { ensureGroupMessagesMigrated, GROUP_ACTIVITY_RESET_KEY } from './groupMessagesMigration';
import { perAccountKey } from './perAccountStorage';

// Account scoping: per-account namespaced under `nostr_groups_${pubkey}`
// since the multi-account switcher landed (#288). The legacy global
// `nostr_groups` key is migrated on first launch by
// `migrateToPerAccountStorage`; the post-migration source of truth is
// the namespaced key. When pubkey is null (rare race during boot before
// auto-login completes) we fall back to the bare key for backwards
// compatibility — the next save with a real pubkey will land in the
// namespaced slot.
const GROUPS_KEY_BASE = 'nostr_groups';

export async function loadGroups(
  pubkey: string | null,
  options: { strict?: boolean } = {},
): Promise<Group[]> {
  try {
    const raw = await AsyncStorage.getItem(perAccountKey(GROUPS_KEY_BASE, pubkey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Group[];
    if (!Array.isArray(parsed) && options.strict) throw new Error('Invalid stored groups');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (options.strict) throw error;
    return [];
  }
}

export async function saveGroups(pubkey: string | null, groups: Group[]): Promise<void> {
  await AsyncStorage.setItem(perAccountKey(GROUPS_KEY_BASE, pubkey), JSON.stringify(groups));
}

export function createGroupId(): string {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Per-pubkey rollup of last-activity per group. Persisted so a cold app
// start can render the Messages tab's group rows with their last
// preview / timestamp immediately, instead of placeholder activity until
// each per-group `loadGroupMessages()` resolves. Mirrors the dmInbox
// eager-hydration pattern from PR #253. The cache is overwritten on
// every change to `activityByGroup`, so it stays roughly in sync with
// the in-memory state — stale by at most one app session.
const GROUP_ACTIVITY_KEY = (pubkey: string) => `nostr_group_activity_${pubkey}`;

/** Type-guard for a single GroupActivity entry. Rejects anything that
 * would crash downstream consumers — `formatConversationTimestamp`
 * throws `RangeError: Invalid time value` if `lastActivityAt` isn't a
 * finite number, so the cache must filter on shape, not just type. */
function isValidGroupActivity(v: unknown): v is GroupActivity {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.lastActivityAt === 'number' &&
    Number.isFinite(a.lastActivityAt) &&
    typeof a.lastText === 'string' &&
    (a.lastSenderPubkey === null || typeof a.lastSenderPubkey === 'string') &&
    Array.isArray(a.recentSenderPubkeys) &&
    (a.lastMentionAt === undefined ||
      (typeof a.lastMentionAt === 'number' && Number.isFinite(a.lastMentionAt)))
  );
}

export async function loadGroupActivity(pubkey: string): Promise<Record<string, GroupActivity>> {
  // The #1240 migration deletes every pre-#1240 rollup once (they could hold
  // previews leaked from other accounts) — read only after it, and treat the
  // cache as empty until that reset has succeeded, or a stale copy would be
  // hydrated and saved back. It's a rebuildable cache: the per-group loads
  // repopulate it from this account's own history.
  await ensureGroupMessagesMigrated();
  try {
    if ((await AsyncStorage.getItem(GROUP_ACTIVITY_RESET_KEY)) === null) return {};
    const raw = await AsyncStorage.getItem(GROUP_ACTIVITY_KEY(pubkey));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Reject arrays + non-plain values + entries that fail the shape check.
    // Stale / partial / older-schema caches are silently dropped rather
    // than crashing the Messages tab on next mount.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const valid: Record<string, GroupActivity> = {};
    for (const [groupId, entry] of Object.entries(parsed)) {
      if (isValidGroupActivity(entry)) valid[groupId] = entry;
    }
    return valid;
  } catch {
    return {};
  }
}

export async function saveGroupActivity(
  pubkey: string,
  activity: Record<string, GroupActivity>,
): Promise<void> {
  await AsyncStorage.setItem(GROUP_ACTIVITY_KEY(pubkey), JSON.stringify(activity));
}
