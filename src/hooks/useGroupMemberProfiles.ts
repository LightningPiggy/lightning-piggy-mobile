import { useEffect, useMemo, useRef, useState } from 'react';
import * as profileCache from '../services/zapSenderProfileStorage';
import type { NostrContact, NostrProfile } from '../types/nostr';
import type { GroupMessage } from '../services/groupMessagesStorageService';
import { membersNeedingProfiles, type MemberProfile } from '../utils/groupMemberRows';

const EMPTY_PROFILES: ReadonlyMap<string, MemberProfile> = new Map();
const EMPTY_MESSAGES: readonly Pick<GroupMessage, 'senderPubkey'>[] = [];

/** Upper bound on authors in the one kind-0 request a sheet open makes. */
export const MAX_MEMBER_PROFILE_FETCH = 100;

const toMemberProfile = (p: {
  name?: string | null;
  displayName?: string | null;
  picture?: string | null;
}): MemberProfile => ({
  name: p.name ?? null,
  displayName: p.displayName ?? null,
  picture: p.picture ?? null,
});

/** Merge `incoming` into `current`, returning `current` itself when nothing
 * changed. Runs once per cache read / batch fetch, never per relay event. */
function mergeProfiles(
  current: ReadonlyMap<string, MemberProfile>,
  incoming: Iterable<[string, MemberProfile]>,
): ReadonlyMap<string, MemberProfile> {
  let next: Map<string, MemberProfile> | null = null;
  for (const [pk, prof] of incoming) {
    const cur = current.get(pk);
    if (
      cur &&
      cur.name === prof.name &&
      cur.displayName === prof.displayName &&
      cur.picture === prof.picture
    ) {
      continue;
    }
    next ??= new Map(current);
    next.set(pk, prof);
  }
  return next ?? current;
}

interface Options {
  memberPubkeys: readonly string[];
  /** History may contain senders who are no longer in the current member list. */
  messages?: readonly Pick<GroupMessage, 'senderPubkey'>[];
  selfPubkey: string | null | undefined;
  contacts: readonly NostrContact[];
  /** Allow the relay fetch (the members sheet is open). Cache reads always run. */
  enabled: boolean;
  fetchProfilesForPubkeys: (pubkeys: string[]) => Promise<Map<string, NostrProfile>>;
}

/**
 * Names + avatars for group members the viewer doesn't follow (#1268).
 * `contacts` only carries kind-0s for follows, so everyone else used to render
 * as a hex key with a blank avatar.
 *
 * - Always reads the shared pubkey → profile cache (`zapSenderProfileStorage`,
 *   the same one `usePubkeyProfile` uses) — no network, so the thread's sender
 *   labels pick up anything already resolved.
 * - While `enabled`, the misses go out as ONE bounded `fetchProfilesForPubkeys`
 *   batch (≤ `MAX_MEMBER_PROFILE_FETCH` authors). Each pubkey is attempted once
 *   per mount; a failed batch is released for the next open to retry.
 * - Results are written back to the shared cache WITHOUT `lud16`: the batch
 *   path skips signature checks and strips payment fields, and leaving `lud16`
 *   undefined keeps `usePubkeyProfile`'s verified fetch (Zap button) intact.
 *
 * One instance per screen owns this; the sheet receives resolved rows via props.
 */
export function useGroupMemberProfiles({
  memberPubkeys,
  messages = EMPTY_MESSAGES,
  selfPubkey,
  contacts,
  enabled,
  fetchProfilesForPubkeys,
}: Options): ReadonlyMap<string, MemberProfile> {
  const candidates = useMemo(
    () =>
      // Use stored messages before timeline classification, which itself needs
      // the resolved member names. The helper normalizes and deduplicates keys.
      membersNeedingProfiles(
        [...memberPubkeys, ...messages.map((message) => message.senderPubkey)],
        selfPubkey,
        contacts,
      ),
    [memberPubkeys, messages, selfPubkey, contacts],
  );
  // Contacts / group objects re-emit with fresh identities on unrelated
  // updates; key the effect on the candidate set's content instead.
  const candidatesKey = candidates.join(',');

  const [profiles, setProfiles] = useState<ReadonlyMap<string, MemberProfile>>(() => {
    const seeded: [string, MemberProfile][] = [];
    for (const pk of candidates) {
      const hit = profileCache.peekSync(pk);
      if (hit) seeded.push([pk, toMemberProfile(hit)]);
    }
    return seeded.length ? new Map(seeded) : EMPTY_PROFILES;
  });

  const attempted = useRef<Set<string>>(new Set());
  const fetchRef = useRef(fetchProfilesForPubkeys);
  fetchRef.current = fetchProfilesForPubkeys;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const pubkeys = candidatesKey ? candidatesKey.split(',') : [];
    if (pubkeys.length === 0) return;
    // An in-flight batch is NOT dropped when the sheet closes — each pubkey
    // is attempted once per mount, so discarding it would strand the member.
    (async () => {
      const cached = await profileCache.getMany(pubkeys);
      if (!mounted.current) return;
      if (cached.size > 0) {
        setProfiles((prev) =>
          mergeProfiles(
            prev,
            [...cached].map(([pk, p]) => [pk, toMemberProfile(p)]),
          ),
        );
      }
      if (!enabled) return;
      const misses = pubkeys
        .filter((pk) => !cached.has(pk) && !attempted.current.has(pk))
        .slice(0, MAX_MEMBER_PROFILE_FETCH);
      if (misses.length === 0) return;
      misses.forEach((pk) => attempted.current.add(pk));
      let fetched: Map<string, NostrProfile>;
      try {
        fetched = await fetchRef.current(misses);
      } catch {
        misses.forEach((pk) => attempted.current.delete(pk));
        return;
      }
      if (fetched.size === 0) return;
      const resolved: [string, MemberProfile][] = [];
      const toCache = new Map<string, profileCache.CachedZapSenderProfile>();
      for (const [rawPk, p] of fetched) {
        const pk = rawPk.toLowerCase();
        resolved.push([pk, toMemberProfile(p)]);
        toCache.set(pk, {
          npub: p.npub,
          name: p.name ?? null,
          displayName: p.displayName ?? null,
          picture: p.picture ?? null,
          nip05: null,
        });
      }
      profileCache.setMany(toCache).catch(() => {});
      if (mounted.current) setProfiles((prev) => mergeProfiles(prev, resolved));
    })();
  }, [candidatesKey, enabled]);

  return profiles;
}
