import { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheMessageDisplayProfiles } from '../services/cachedDisplayProfiles';
import type { ContactInfo } from '../components/GroupAvatar';
import type { NostrContact, NostrProfile } from '../types/nostr';
import type { DmInboxEntry } from '../utils/conversationSummaries';

const EMPTY_PROFILES: Map<string, NostrProfile> = new Map();

export const nonFollowProfilesKey = (pubkey: string): string => `nonfollow_profiles_${pubkey}`;

interface OwnedProfiles {
  owner: string | null;
  profiles: Map<string, NostrProfile>;
}

/** Merge `incoming` into `owner`'s profiles; another owner's map is discarded.
 * Runs once per kind-0 batch fetch / disk read, never per relay event. */
function mergeOwnedProfiles(
  current: OwnedProfiles,
  owner: string,
  incoming: Iterable<[string, NostrProfile]>,
  { keepExisting }: { keepExisting: boolean },
): OwnedProfiles {
  const base = current.owner === owner ? current.profiles : EMPTY_PROFILES;
  const next = new Map(base);
  for (const [pk, prof] of incoming) {
    const key = pk.toLowerCase();
    if (keepExisting && next.has(key)) continue;
    next.set(key, prof);
  }
  return { owner, profiles: next };
}

const NO_EXTRA: readonly string[] = [];

interface UseNonFollowProfilesOptions {
  pubkey: string | null;
  dmInbox: DmInboxEntry[];
  contacts: NostrContact[];
  fetchProfilesForPubkeys: (pubkeys: string[]) => Promise<Map<string, NostrProfile>>;
  /** More people to name (group senders, people mentioned in previews). */
  extraPubkeys?: readonly string[];
}

/**
 * Names + avatars for the Messages list (#664): follows come from `contacts`;
 * DM partners (and `extraPubkeys`) the viewer doesn't follow get their kind-0
 * fetched on demand,
 * cached per account on disk, and layered in (never overriding a contact).
 *
 * Everything is scoped to the active account: the map is tagged with its
 * owner (a previous account's profiles are never shown or persisted under the
 * next), and a fetch is only discarded when the account changes — not when
 * the inbox / contacts re-render mid-flight. Each partner is attempted once
 * per account per session, so dropping an in-flight result on unrelated churn
 * would leave that partner as a raw npub for the rest of the session.
 */
export function useNonFollowProfiles({
  pubkey,
  dmInbox,
  contacts,
  fetchProfilesForPubkeys,
  extraPubkeys = NO_EXTRA,
}: UseNonFollowProfilesOptions): {
  nonFollowProfiles: Map<string, NostrProfile>;
  contactInfoMap: Map<string, ContactInfo>;
} {
  const [owned, setOwned] = useState<OwnedProfiles>({ owner: null, profiles: EMPTY_PROFILES });
  const nonFollowProfiles = owned.owner === pubkey ? owned.profiles : EMPTY_PROFILES;
  const ownerRef = useRef(pubkey);
  const attempted = useRef<Set<string>>(new Set());

  // Hydrate the per-account disk cache on mount / identity change.
  useEffect(() => {
    ownerRef.current = pubkey;
    attempted.current = new Set();
    if (!pubkey) return;
    let cancelled = false;
    AsyncStorage.getItem(nonFollowProfilesKey(pubkey))
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const cached = Object.entries(JSON.parse(raw) as Record<string, NostrProfile>);
          // Fresh fetches that landed before the disk read win.
          setOwned((prev) => mergeOwnedProfiles(prev, pubkey, cached, { keepExisting: true }));
        } catch {
          // Corrupt cache — ignore; the fetch effect repopulates.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  const contactInfoMap = useMemo(() => {
    const map = new Map<string, ContactInfo>();
    for (const c of contacts) {
      map.set(c.pubkey.toLowerCase(), {
        picture: c.profile?.picture ?? null,
        name: (c.profile?.displayName || c.profile?.name || c.petname || '').trim() || null,
        lightningAddress: c.profile?.lud16 ?? null,
      });
    }
    for (const [pk, prof] of nonFollowProfiles) {
      if (map.has(pk)) continue;
      map.set(pk, {
        picture: prof.picture ?? null,
        name: (prof.displayName || prof.name || '').trim() || null,
        lightningAddress: prof.lud16 ?? null,
      });
    }
    return map;
  }, [contacts, nonFollowProfiles]);

  // Fetch kind-0 for DM partners with no resolved profile yet.
  useEffect(() => {
    if (!pubkey) return;
    const missingSet = new Set<string>();
    const candidates = [...dmInbox.map((entry) => entry.partnerPubkey), ...extraPubkeys];
    for (const raw of candidates) {
      const pk = raw?.toLowerCase();
      if (!pk || pk === pubkey.toLowerCase()) continue;
      if (contactInfoMap.has(pk) || attempted.current.has(pk)) continue;
      missingSet.add(pk);
    }
    if (missingSet.size === 0) return;
    const missing = [...missingSet];
    const attemptedForOwner = attempted.current;
    missing.forEach((pk) => attemptedForOwner.add(pk));
    const owner = pubkey;
    fetchProfilesForPubkeys(missing)
      .then((fetched) => {
        if (ownerRef.current !== owner || fetched.size === 0) return;
        setOwned((prev) => mergeOwnedProfiles(prev, owner, fetched, { keepExisting: false }));
      })
      .catch(() => {
        // Transient failure — let the next inbox change retry these.
        missing.forEach((pk) => attemptedForOwner.delete(pk));
      });
  }, [dmInbox, extraPubkeys, contactInfoMap, pubkey, fetchProfilesForPubkeys]);

  // Persist under the map's OWN owner (never the newly-active pubkey), kept
  // out of the state updater so Strict Mode's double-invocation can't
  // duplicate the write.
  useEffect(() => {
    if (!owned.owner || owned.profiles.size === 0) return;
    // Mirror the merged result, so a delayed disk read cannot replace a
    // fresher fetched name for already-subscribed mention/sender consumers.
    void cacheMessageDisplayProfiles(owned.profiles).catch(() => {});
    AsyncStorage.setItem(
      nonFollowProfilesKey(owned.owner),
      JSON.stringify(Object.fromEntries(owned.profiles)),
    ).catch(() => {});
  }, [owned]);

  return { nonFollowProfiles, contactInfoMap };
}
