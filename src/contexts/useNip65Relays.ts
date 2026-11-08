import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useMemo, useRef, useState } from 'react';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nostrService from '../services/nostrService';
import { perAccountKey } from '../services/perAccountStorage';
import type { RelayConfig } from '../types/nostr';
import { fetchLatestReplaceable } from '../services/nostrRelayLists';
import { rearmBackgroundDmWatchForActiveIdentity } from '../services/backgroundDmService';
import { dmInboxRelaysFromTags, RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { sameRelayConfigs, sameRelayUrls } from '../utils/relayListKey';

import {
  RELAY_LIST_CACHE_KEY_BASE,
  RELAY_LIST_TIMESTAMP_KEY_BASE,
  DM_INBOX_RELAYS_CACHE_KEY_BASE,
  DM_INBOX_CREATED_AT_KEY_BASE,
  RELAY_LIST_CREATED_AT_KEY_BASE,
  CACHE_MAX_AGE_MS,
  readCachedWithTtl,
} from './nostrCacheKeys';

/**
 * The user's published NIP-65 (kind-10002) relay list: hydrate from the
 * per-account cache, refresh from relays, and adopt a list the user just
 * published in-app. Extracted from NostrContext, which composes it.
 */
/** Result of adopting a list: whether it was taken, and the newest created_at
 * the app now holds for that list (sign the next update strictly after it). */
export interface AdoptResult {
  adopted: boolean;
  baseline: number;
}

const createdAtKeyOf = (pk: string) => perAccountKey(DM_INBOX_CREATED_AT_KEY_BASE, pk);
const readCreatedAt = async (key: string): Promise<number> =>
  Number((await AsyncStorage.getItem(key).catch(() => null)) ?? 0) || 0;

/** created_at of the list (kind 10002 or 10050) the app last adopted for `pk`;
 * 0 when none. Sign the next update strictly after it. REJECTS when storage
 * can't be read (or holds garbage), so no caller mistakes that for "none". */
export const readAdoptedCreatedAt = async (pk: string, kind: 10002 | 10050): Promise<number> => {
  const raw = await AsyncStorage.getItem(
    perAccountKey(
      kind === 10002 ? RELAY_LIST_CREATED_AT_KEY_BASE : DM_INBOX_CREATED_AT_KEY_BASE,
      pk,
    ),
  );
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`unreadable created_at for kind ${kind}`);
  return value;
};

// State updaters that keep the current array when the new list has the same
// entries. Cold start sets each list several times (cache, then network) with
// fresh, identical arrays; a new identity would re-arm every relay sub.
const keepIfSameConfigs = (next: RelayConfig[]) => (prev: RelayConfig[]) =>
  sameRelayConfigs(prev, next) ? prev : next;
const keepIfSameUrls = (next: string[]) => (prev: string[]) =>
  sameRelayUrls(prev, next) ? prev : next;

export function useNip65Relays() {
  const [nip65Relays, setNip65Relays] = useState<RelayConfig[]>([]);
  // The user's own DM inbox relays: others deliver NIP-17 DMs there, so the
  // app must READ them too (merged into getReadRelays by NostrContext).
  const [dmInboxRelaysState, setDmInboxRelaysState] = useState<string[]>([]);
  // The same list, readable synchronously (state lags a render): a background
  // check must see a list adopted a moment ago before publishing a default.
  const dmInboxNowRef = useRef<string[]>([]);
  const setDmInboxRelays = useCallback((list: string[]) => {
    dmInboxNowRef.current = list;
    setDmInboxRelaysState(keepIfSameUrls(list));
  }, []);
  const dmInboxRelays = dmInboxRelaysState;
  // Whether each of this identity's lists is known-good (its own cache or
  // relays, or an adoption) rather than the defaults used before then — each
  // set ONLY by its own list's paths. Outbox reads (#1390) never lease a relay
  // until BOTH are known (`relayListsHydrated`). Cleared by resetRelayLists.
  const [nip65Known, setNip65Known] = useState(false);
  const [dmInboxKnown, setDmInboxKnown] = useState(false);
  const relayListsHydrated = nip65Known && dmInboxKnown;
  // Bumped ONLY by resetRelayLists (logout / identity switch) — unlike the
  // load generations below, which an in-app adoption also bumps.
  const identityRef = useRef(0);
  const markNip65Known = useCallback((identity: number) => {
    if (identity === identityRef.current) setNip65Known(true);
  }, []);
  const markDmInboxKnown = useCallback((identity: number) => {
    if (identity === identityRef.current) setDmInboxKnown(true);
  }, []);

  // Bumped by resetRelayLists (logout / identity switch): a background load
  // started for the previous identity must not restore its relays afterwards.
  const generationRef = useRef(0);
  // Same guard for NIP-65 loads: bumped on reset AND when a just-published
  // list is adopted, so a slower, older load can't overwrite it.
  const nip65GenerationRef = useRef(0);
  // created_at of each adopted list, by cache key — also in memory, so a failed
  // storage write can't let an older relay copy replace a newer list.
  const adoptedAtRef = useRef(new Map<string, number>());
  const baselineOf = useCallback(
    async (key: string) => Math.max(await readCreatedAt(key), adoptedAtRef.current.get(key) ?? 0),
    [],
  );
  const remember = (key: string, createdAt: number) =>
    adoptedAtRef.current.set(key, Math.max(adoptedAtRef.current.get(key) ?? 0, createdAt));

  /** Adopt a DM inbox list (in memory first; caching is best-effort so a
   * full device can't break the caller) and re-arm the background watch. */
  const adoptDmInbox = useCallback(
    async (pk: string, list: string[], createdAt?: number): Promise<boolean> => {
      const createdAtKey = perAccountKey(DM_INBOX_CREATED_AT_KEY_BASE, pk);
      // Two loads can race (e.g. a late NIP-65 reply starts a second one): the
      // older list must never land after the newer one, live or cached.
      // Checked synchronously, and again before writing the cache.
      const newerHeld = () =>
        createdAt !== undefined && (adoptedAtRef.current.get(createdAtKey) ?? 0) > createdAt;
      if (newerHeld()) return false;
      if (createdAt) remember(createdAtKey, createdAt);
      setDmInboxRelays(list);
      // Callers only adopt for the current identity (generation-checked).
      markDmInboxKnown(identityRef.current);
      const key = perAccountKey(DM_INBOX_RELAYS_CACHE_KEY_BASE, pk);
      const before = await AsyncStorage.getItem(key).catch(() => null);
      if (newerHeld()) return false;
      await AsyncStorage.setItem(key, JSON.stringify(list)).catch(() => {});
      if (createdAt) await AsyncStorage.setItem(createdAtKey, String(createdAt)).catch(() => {});
      // The background DM watch reads this cache; re-arm it when it changed.
      if (before !== JSON.stringify(list)) void rearmBackgroundDmWatchForActiveIdentity();
      return true;
    },
    [setDmInboxRelays, markDmInboxKnown],
  );

  const loadDmInboxRelays = useCallback(
    async (pk: string, nip65WriteRelays: string[] = [], generation = generationRef.current) => {
      const current = () => generation === generationRef.current;
      const identity = identityRef.current;
      let cached: string[] = [];
      let cacheKnown = false;
      try {
        const raw = await AsyncStorage.getItem(perAccountKey(DM_INBOX_RELAYS_CACHE_KEY_BASE, pk));
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (Array.isArray(parsed)) {
          cached = parsed.filter((u): u is string => typeof u === 'string');
          cacheKnown = true;
        }
        if (current() && cached.length > 0) setDmInboxRelays(cached);
      } catch {
        /* corrupt cache — the network read below replaces it */
      }
      // A stored list (even an empty one) is this identity's inbox for now.
      // Never cached, or corrupt: unknown until the relays have been asked.
      // Same identity is enough: an adoption meanwhile only made it newer.
      if (cacheKnown) markDmInboxKnown(identity);
      const cachedAt = await baselineOf(perAccountKey(DM_INBOX_CREATED_AT_KEY_BASE, pk));
      // The NEWEST published list across relays, not the first reply — also on
      // the user's NIP-65 write relays and the inbox relays themselves, where
      // other clients (or our own last publish) put it.
      const event = await fetchLatestReplaceable(pk, 10050, [
        ...new Set([
          ...nip65WriteRelays,
          ...cached,
          ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS),
          ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS),
        ]),
      ]);
      // Never let an older relay copy replace a newer cached list.
      if (!event || !current() || event.created_at < cachedAt) {
        // The relays were asked: what's cached (possibly nothing) is the
        // inbox. (A throw above leaves it unknown; outbox reads wait.)
        markDmInboxKnown(identity);
        return;
      }
      await adoptDmInbox(pk, dmInboxRelaysFromTags(event.tags), event.created_at);
    },
    [adoptDmInbox, baselineOf, markDmInboxKnown, setDmInboxRelays],
  );

  /** Adopt DM inbox relays the user just published (or the editor found).
   * Refuses a list older than the one already adopted, and one whose identity
   * was reset mid-call, so neither a stale copy nor a previous account's list
   * can replace the current one. `session` (from `dmInboxLive.session`, taken when
   * a longer task started) binds it to that moment: after any reset or other
   * adoption since, it is refused. */
  const applyPublishedDmInbox = useCallback(
    async (
      pk: string,
      list: string[],
      createdAt?: number,
      session?: number,
    ): Promise<AdoptResult> => {
      const generation = session ?? generationRef.current;
      const adoptedAt = await baselineOf(perAccountKey(DM_INBOX_CREATED_AT_KEY_BASE, pk));
      if (generation !== generationRef.current || (createdAt ?? Infinity) < adoptedAt)
        return { adopted: false, baseline: adoptedAt };
      // The newest list; invalidate any in-flight load that could still land
      // an older copy on top of it.
      generationRef.current += 1;
      const adopted = await adoptDmInbox(pk, list, createdAt);
      const baseline = Math.max(adoptedAt, adoptedAtRef.current.get(createdAtKeyOf(pk)) ?? 0);
      return adopted
        ? { adopted, baseline: Math.max(baseline, createdAt ?? 0) }
        : { adopted, baseline };
    },
    [adoptDmInbox, baselineOf],
  );

  /** Forget both lists (logout / identity switch). */
  const resetRelayLists = useCallback(() => {
    generationRef.current += 1;
    nip65GenerationRef.current += 1;
    setNip65Relays(keepIfSameConfigs([]));
    setDmInboxRelays([]);
    identityRef.current += 1;
    setNip65Known(false);
    setDmInboxKnown(false);
  }, [setDmInboxRelays]);

  /** The DM inbox as held right now, without render lag: its relays, the
   * created_at adopted in memory for `pk` (0: none), and a token for
   * `applyPublishedDmInbox(…, session)` that changes on reset / adoption. */
  const dmInboxLive = useMemo(
    () => ({
      relays: () => dmInboxNowRef.current,
      createdAt: (pk: string) =>
        adoptedAtRef.current.get(perAccountKey(DM_INBOX_CREATED_AT_KEY_BASE, pk)) ?? 0,
      session: () => generationRef.current,
    }),
    [],
  );

  /** Eagerly hydrate `relays` state from the per-account cache so
   * relay-dependent fan-out (kind-0 publish, NIP-17 send) uses the
   * user's actual relays from the very first action instead of
   * defaulting to `DEFAULT_RELAYS`. Same pattern as
   * `loadProfileFromCache`. */
  const loadRelaysFromCache = useCallback(async (pk: string) => {
    try {
      const raw = await AsyncStorage.getItem(perAccountKey(RELAY_LIST_CACHE_KEY_BASE, pk));
      if (!raw) return false;
      const cached = JSON.parse(raw) as RelayConfig[];
      if (!Array.isArray(cached)) return false;
      // Cached relay-list is the NIP-65 slice; the user overrides are
      // hydrated separately by the `getUserRelays()` effect.
      setNip65Relays(keepIfSameConfigs(cached));
      return true;
    } catch (error) {
      console.warn('Failed to load relays cache:', error);
      return false;
    }
  }, []);

  /** Adopt a relay list the user just published (and cache it), so the app
   * uses it straight away instead of waiting for the cache TTL. */
  const applyPublishedRelayList = useCallback(
    async (pk: string, list: RelayConfig[], createdAt?: number): Promise<AdoptResult> => {
      const generation = nip65GenerationRef.current;
      const createdAtKey = perAccountKey(RELAY_LIST_CREATED_AT_KEY_BASE, pk);
      const adoptedAt = await baselineOf(createdAtKey);
      // Never let an older relay copy (or a reset identity's list) win.
      if (generation !== nip65GenerationRef.current || (createdAt ?? Infinity) < adoptedAt)
        return { adopted: false, baseline: adoptedAt };
      nip65GenerationRef.current += 1;
      setNip65Relays(keepIfSameConfigs(list));
      markNip65Known(identityRef.current);
      const key = perAccountKey(RELAY_LIST_CACHE_KEY_BASE, pk);
      const before = await AsyncStorage.getItem(key).catch(() => null);
      // Best-effort: the list is already adopted in memory.
      await AsyncStorage.setItem(key, JSON.stringify(list)).catch(() => {});
      await AsyncStorage.setItem(
        perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, pk),
        Date.now().toString(),
      ).catch(() => {});
      if (createdAt) {
        remember(createdAtKey, createdAt);
        await AsyncStorage.setItem(createdAtKey, String(createdAt)).catch(() => {});
      }
      // The background DM watch subscribes to the NIP-65 read relays; re-arm it
      // when the list changed.
      if (before !== JSON.stringify(list)) void rearmBackgroundDmWatchForActiveIdentity();
      return { adopted: true, baseline: Math.max(adoptedAt, createdAt ?? 0) };
    },
    [baselineOf, markNip65Known],
  );

  const loadRelaysOnce = useCallback(
    async (pk: string): Promise<string[]> => {
      const t0 = Date.now();
      const generation = nip65GenerationRef.current;
      const current = () => generation === nip65GenerationRef.current;
      // Inbox hydration below belongs to THIS load: capture its generation now,
      // and only start it while this identity is still current — a NIP-65
      // adoption mid-load must not skip it, or the inbox would never be known
      // (its own generation still stops it adopting a superseded copy).
      const inboxGeneration = generationRef.current;
      const identity = identityRef.current;
      const hydrateInbox = (list: RelayConfig[]) => {
        if (identity === identityRef.current)
          void loadDmInboxRelays(pk, writeRelaysOf(list), inboxGeneration);
      };
      const writeRelaysOf = (list: RelayConfig[]) => list.filter((r) => r.write).map((r) => r.url);
      // Cache-fresh fast path — NIP-65 relay lists rarely change, so serve
      // from cache when under the TTL and skip the ~3s relay round trip.
      const { value: cached, ageMs } = await readCachedWithTtl<RelayConfig[]>(
        perAccountKey(RELAY_LIST_CACHE_KEY_BASE, pk),
        perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, pk),
      );
      if (cached && ageMs < CACHE_MAX_AGE_MS) {
        if (current()) setNip65Relays(keepIfSameConfigs(cached));
        // Background: own DM inbox relays (cache first, then network).
        hydrateInbox(cached);
        if (__DEV__) console.log(`[Nostr] fetchRelayList: skipped (cache fresh)`);
        const readRelays = cached.filter((r) => r.read).map((r) => r.url);
        return readRelays.length > 0
          ? readRelays
          : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
      }
      // Also the user's write relays and the indexers, where other clients
      // publish the list; a copy newer than the first reply is adopted when
      // it arrives (through the same older-copy guard as a publish).
      const lookup = [
        ...new Set([
          ...writeRelaysOf(cached ?? []),
          ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS),
          ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS),
        ]),
      ];
      const fetched = await nostrService.fetchRelayListEvent(pk, lookup, {
        onLatest: (newer) => {
          if (!current()) return;
          void applyPublishedRelayList(pk, newer.list, newer.createdAt).then((result) => {
            if (result.adopted)
              void loadDmInboxRelays(pk, writeRelaysOf(newer.list), inboxGeneration);
          });
        },
      });
      if (fetched === null) {
        // Network couldn't produce a kind-10002 — fall back to defaults
        // and DON'T persist (so we don't poison the cache with a blip).
        if (__DEV__) console.log(`[Nostr] fetchRelayList: timed out, using defaults`);
        // The (expired) cached list is still this identity's best-known list:
        // restore it before the list counts as known, so its relays are in the
        // viewer's own set (#1390) — unless an adoption meanwhile superseded it.
        if (cached && current()) setNip65Relays(keepIfSameConfigs(cached));
        hydrateInbox(cached ?? []);
        return enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
      }
      const createdAtKey = perAccountKey(RELAY_LIST_CREATED_AT_KEY_BASE, pk);
      // A relay that missed the user's last in-app publish can still serve an
      // older copy: keep the newer cached list rather than restore it.
      if (fetched.createdAt < (await baselineOf(createdAtKey))) {
        if (cached && current()) setNip65Relays(keepIfSameConfigs(cached));
        hydrateInbox(cached ?? []);
        const read = (cached ?? []).filter((r) => r.read).map((r) => r.url);
        return read.length > 0 ? read : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
      }
      const relayList = fetched.list;
      if (__DEV__)
        console.log(`[Nostr] fetchRelayList: ${Date.now() - t0}ms, ${relayList.length} relays`);
      hydrateInbox(relayList);
      // A list published in-app while this load was in flight wins.
      if (!current()) {
        const read = relayList.filter((r) => r.read).map((r) => r.url);
        return read.length > 0 ? read : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
      }
      setNip65Relays(keepIfSameConfigs(relayList));
      remember(createdAtKey, fetched.createdAt);
      InteractionManager.runAfterInteractions(() => {
        if (!current()) return;
        AsyncStorage.setItem(
          perAccountKey(RELAY_LIST_CACHE_KEY_BASE, pk),
          JSON.stringify(relayList),
        ).catch(() => {});
        AsyncStorage.setItem(
          perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, pk),
          Date.now().toString(),
        ).catch(() => {});
        AsyncStorage.setItem(createdAtKey, String(fetched.createdAt)).catch(() => {});
      });
      const readRelays = relayList.filter((r) => r.read).map((r) => r.url);
      return readRelays.length > 0
        ? readRelays
        : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
    },
    [loadDmInboxRelays, baselineOf, applyPublishedRelayList],
  );

  // The NIP-65 list is known once this identity's load settles, whichever
  // path it took — even when an in-app adoption meanwhile superseded its
  // result. (The DM inbox has its own flag, set by its own read.)
  const loadRelays = useCallback(
    async (pk: string): Promise<string[]> => {
      const identity = identityRef.current;
      const read = await loadRelaysOnce(pk);
      markNip65Known(identity);
      return read;
    },
    [loadRelaysOnce, markNip65Known],
  );

  return {
    nip65Relays,
    dmInboxRelays,
    relayListsHydrated,
    resetRelayLists,
    applyPublishedDmInbox,
    dmInboxLive,
    loadRelaysFromCache,
    loadRelays,
    applyPublishedRelayList,
  };
}
