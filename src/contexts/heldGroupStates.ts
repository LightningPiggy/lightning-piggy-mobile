// A kind-30200 that would CREATE a group the viewer isn't in yet is accepted
// only from a creator the Messages follow gate would store (#1830): the viewer,
// a follow, someone the viewer has replied to, or anyone when the list shows
// everyone ('all'). Updates to a known group keep their member-publisher check.
//
// Group state often lands before the follow list does, so a creator who isn't
// trusted yet is HELD here rather than dropped, and re-tried when follows or
// the tier change. Held events are never persisted: a stranger can't plant
// groups on disk, and the in-memory set is capped and cleared per account.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildFollowSet } from '../utils/followPubkeys';
import { hasRepliedTo } from '../services/dmRepliedPartners';
import type { WotTier } from '../services/wotSettingsService';

export interface GroupStateInput {
  senderPubkey: string;
  groupId: string;
  name: string;
  memberPubkeys: string[];
  createdAt: number;
}

export const HELD_GROUP_STATES_CAP = 50;

export interface HeldGroupStates {
  /** Hold (or replace, latest-wins per group) a new-group event. */
  hold: (input: GroupStateInput) => void;
  /** Remove and return the held events whose creator `admits` now accepts. */
  release: (admits: (creator: string) => boolean) => GroupStateInput[];
  clear: () => void;
  readonly size: number;
}

export function createHeldGroupStates(cap: number = HELD_GROUP_STATES_CAP): HeldGroupStates {
  const held = new Map<string, GroupStateInput>();
  return {
    hold(input) {
      const prev = held.get(input.groupId);
      if (prev && prev.createdAt >= input.createdAt) return;
      held.delete(input.groupId);
      if (held.size >= cap) {
        const oldest = held.keys().next().value;
        if (oldest !== undefined) held.delete(oldest);
      }
      held.set(input.groupId, input);
    },
    release(admits) {
      const out: GroupStateInput[] = [];
      for (const [id, input] of held) {
        if (!admits(input.senderPubkey)) continue;
        held.delete(id);
        out.push(input);
      }
      return out;
    },
    clear() {
      held.clear();
    },
    get size() {
      return held.size;
    },
  };
}

/** The Messages follow gate, applied to a group's creator. */
export function admitsGroupCreator(
  creator: string,
  trust: {
    viewer: string | null;
    follows: ReadonlySet<string>;
    showsEveryone: boolean;
    replied: (pk: string) => boolean;
  },
): boolean {
  const pk = creator.toLowerCase();
  return (
    trust.showsEveryone ||
    pk === trust.viewer?.toLowerCase() ||
    trust.follows.has(pk) ||
    trust.replied(pk)
  );
}

/** The account's creator gate and its held new-group events (cleared on switch). */
export function useGroupCreatorGate(
  viewer: string | null,
  contacts: readonly { pubkey: string }[],
  tier: WotTier,
): { admits: (creator: string) => boolean; held: HeldGroupStates } {
  const [held] = useState(createHeldGroupStates);
  const follows = useMemo(() => buildFollowSet(contacts.map((c) => c.pubkey)), [contacts]);
  const admits = useCallback(
    (creator: string) =>
      admitsGroupCreator(creator, {
        viewer,
        follows,
        showsEveryone: tier === 'all',
        replied: (pk) => !!viewer && hasRepliedTo(viewer, pk),
      }),
    [viewer, follows, tier],
  );
  useEffect(() => () => held.clear(), [viewer, held]);
  return useMemo(() => ({ admits, held }), [admits, held]);
}
