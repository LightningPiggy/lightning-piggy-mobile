// A kind-30200 that would CREATE a group the viewer isn't in yet is accepted
// only from a creator who may start a room (`services/roomStartGate`, #1830).
// Updates to a known group keep their member-publisher check.
//
// Group state often lands before the follow list does, so a creator who isn't
// trusted yet is HELD here rather than dropped, and re-tried when follows, the
// tier or the replied-to list change. Held events are never persisted: a
// stranger can't plant groups on disk, and the in-memory set is capped (in
// total and per creator) and cleared per account.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildFollowSet } from '../utils/followPubkeys';
import { loadRepliedPartners } from '../services/dmRepliedPartners';
import { mayStartRoom } from '../services/roomStartGate';
import type { WotTier } from '../services/wotSettingsService';

export interface GroupStateInput {
  senderPubkey: string;
  groupId: string;
  name: string;
  memberPubkeys: string[];
  createdAt: number;
}

export const HELD_GROUP_STATES_CAP = 50;
/** One creator can't crowd out everyone else's held groups. */
export const HELD_GROUP_STATES_PER_CREATOR = 5;

export interface HeldGroupStates {
  /** Hold (or replace, latest-wins per creator + group) a new-group event. */
  hold: (input: GroupStateInput) => void;
  /** Remove and return the held events whose creator `admits` now accepts. */
  release: (admits: (creator: string) => boolean) => GroupStateInput[];
  clear: () => void;
  readonly size: number;
}

export function createHeldGroupStates(
  cap: number = HELD_GROUP_STATES_CAP,
  perCreator: number = HELD_GROUP_STATES_PER_CREATOR,
): HeldGroupStates {
  // Keyed by creator AND group id: a d-tag is the creator's own namespace, so
  // a stranger reusing a friend's d-tag can't replace the friend's event.
  const held = new Map<string, GroupStateInput>();
  const evictOldest = (match: (input: GroupStateInput) => boolean) => {
    for (const [key, input] of held) {
      if (!match(input)) continue;
      held.delete(key);
      return;
    }
  };
  return {
    hold(input) {
      const creator = input.senderPubkey.toLowerCase();
      const key = `${creator}:${input.groupId}`;
      const prev = held.get(key);
      if (prev && prev.createdAt >= input.createdAt) return;
      held.delete(key);
      const fromCreator = (i: GroupStateInput) => i.senderPubkey.toLowerCase() === creator;
      let mine = 0;
      for (const i of held.values()) if (fromCreator(i)) mine++;
      if (mine >= perCreator) evictOldest(fromCreator);
      else if (held.size >= cap) evictOldest(() => true);
      held.set(key, input);
    },
    release(admits) {
      const out: GroupStateInput[] = [];
      for (const [key, input] of held) {
        if (!admits(input.senderPubkey)) continue;
        held.delete(key);
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

/** The account's creator gate and its held new-group events (cleared on switch). */
export function useGroupCreatorGate(
  viewer: string | null,
  contacts: readonly { pubkey: string }[],
  tier: WotTier,
): { admits: (creator: string) => boolean; held: HeldGroupStates } {
  const [held] = useState(() => createHeldGroupStates());
  // Bumped once the replied-to list is read, so held events are re-tried.
  const [repliedLoaded, setRepliedLoaded] = useState<string | null>(null);
  const follows = useMemo(() => buildFollowSet(contacts.map((c) => c.pubkey)), [contacts]);
  const admits = useCallback(
    (creator: string) => !!viewer && mayStartRoom(viewer, creator, (pk) => follows.has(pk), tier),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repliedLoaded: new identity once replies load
    [viewer, follows, tier, repliedLoaded],
  );
  useEffect(() => {
    if (!viewer) return;
    let active = true;
    void loadRepliedPartners(viewer).then(() => {
      if (active) setRepliedLoaded(viewer);
    });
    return () => {
      active = false;
      held.clear();
    };
  }, [viewer, held]);
  return useMemo(() => ({ admits, held }), [admits, held]);
}
