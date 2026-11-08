import type { ConversationSummary } from './conversationSummaries';
import type { GroupSummary } from '../types/groups';

/** How many recent chats the share picker lists above the friends (#1692). */
export const RECENT_SHARE_TARGETS = 8;

export type ShareRecent =
  | { kind: 'dm'; key: string; summary: ConversationSummary; at: number }
  | { kind: 'group'; key: string; summary: GroupSummary; at: number };

/**
 * The "Recent chats" section of the share picker: 1:1 threads (NIP-17 and
 * Marmot, each its own row as in the Messages tab) and groups, most recently
 * active first, filtered by the search text. Rows that can't take a message —
 * anonymous zaps, a Marmot invite that couldn't be opened — are left out.
 */
export function recentShareTargets(
  dms: readonly ConversationSummary[],
  groups: readonly GroupSummary[],
  query: string,
  limit = RECENT_SHARE_TARGETS,
): ShareRecent[] {
  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  const rows: ShareRecent[] = [];
  for (const summary of dms) {
    if (!summary.pubkey || summary.anonymous || summary.marmotInviteFailed) continue;
    if (!matches(summary.name)) continue;
    rows.push({ kind: 'dm', key: `dm:${summary.id}`, summary, at: summary.lastActivityAt });
  }
  for (const summary of groups) {
    if (!matches(summary.group.name)) continue;
    rows.push({
      kind: 'group',
      key: `group:${summary.group.id}`,
      summary,
      at: summary.activity.lastActivityAt,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}
