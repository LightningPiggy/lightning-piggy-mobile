// Persistent settings for the web-of-trust cache/event/message filter.
// Single AsyncStorage key as JSON so future fields land here without proliferating keys.
//
// History: pre-#535 this stored a boolean `filterEnabled`. As of #535 the
// filter is a 3-tier picker (friends / fof / all). Old payloads with the
// boolean are migrated on load: `false` (off) → 'all', `true` (on) → 'friends'.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { perAccountKey } from './perAccountStorage';
import { ensureSafetySettingsMigrated, WOT_SETTINGS_KEY_BASE } from './safetySettingsMigration';
import { peekAccountSetting, rememberAccountSetting } from './accountSettingsCache';

// Stored PER ACCOUNT (`perAccountKey(base, pubkey)`): on a shared family phone
// each person picks their own "who can message me" tier.
export const WOT_STORAGE_KEY_BASE = WOT_SETTINGS_KEY_BASE;

// The 3 tiers from issue #535. Default 'all' — every signed event surfaces
// on Geo-caches + Events rails so a brand-new user (no follows yet) sees
// content on first launch. Issue #627: a 'friends' default on a fresh
// install means an empty rail / empty map, because the WoT set is just
// the user's own pubkey + seeds. 'fof' adds friends-of-follows (one hop).
//
// DMs are protected separately by `GroupsContext.effectiveWotTier`, which
// clamps `wotTier === 'all'` back to 'friends' for the Messages surface
// when secret mode is off — so this wider default does NOT widen DM
// visibility. The clamp is the deliberate safety boundary between
// "I want to discover content" and "I want to protect my inbox".
//
// Wider tiers are secret-mode-gated at the UI level (see WebOfTrustBottomSheet),
// not at the storage layer — the persisted value still has to round-trip even
// when secret mode is later disabled.
export type WotTier = 'friends' | 'fof' | 'all';

export interface WotSettings {
  wotTier: WotTier;
}

const DEFAULTS: WotSettings = { wotTier: 'all' };

// Validation predicate — any payload we can't strictly parse falls through
// to DEFAULTS (now 'all'). Pre-#627 we deliberately fell back to 'friends'
// for safety, but with the GroupsContext DM-clamp in place the wider
// fallback is the strictly better UX trade-off: a corrupted blob shouldn't
// silently re-introduce the empty-rail symptom #627 was filed to fix.
const isWotTier = (v: unknown): v is WotTier => v === 'friends' || v === 'fof' || v === 'all';

/** Parse a stored payload; anything unparseable falls through to DEFAULTS. */
const parseWotSettings = (raw: string | null): WotSettings => {
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw);
    // New shape — wotTier present and valid.
    if (parsed && typeof parsed === 'object' && isWotTier(parsed.wotTier)) {
      return { wotTier: parsed.wotTier };
    }
    // Legacy migration: pre-#535 stored `{ filterEnabled: boolean }`. Map
    // false → 'all' (filter explicitly off), true (or missing) → 'friends'.
    if (parsed && typeof parsed === 'object' && typeof parsed.filterEnabled === 'boolean') {
      return { wotTier: parsed.filterEnabled ? 'friends' : 'all' };
    }
  } catch {
    // fall through
  }
  return DEFAULTS;
};

/**
 * The account's tier if it is already known this session (prewarmed at
 * startup for every registered account, or loaded/saved since), else `null`
 * — meaning "unknown: stay gated". Synchronous, for the first render after an
 * account switch.
 */
export const peekWotSettings = (pubkey: string | null): WotSettings | null => {
  const raw = peekAccountSetting(WOT_STORAGE_KEY_BASE, pubkey);
  return raw === undefined ? null : parseWotSettings(raw);
};

export const loadWotSettings = async (pubkey: string | null): Promise<WotSettings> => {
  if (!pubkey) return DEFAULTS;
  try {
    await ensureSafetySettingsMigrated(pubkey);
    const raw = await AsyncStorage.getItem(perAccountKey(WOT_STORAGE_KEY_BASE, pubkey));
    // Once known (prewarm, or a save that landed while we awaited), the
    // session mirror is authoritative — never let this read roll it back.
    const known = peekAccountSetting(WOT_STORAGE_KEY_BASE, pubkey);
    if (known !== undefined) return parseWotSettings(known);
    rememberAccountSetting(WOT_STORAGE_KEY_BASE, pubkey, raw);
    return parseWotSettings(raw);
  } catch {
    return DEFAULTS;
  }
};

/**
 * The account's tier for a reader with no React tree (the background DM
 * watch). Unlike `loadWotSettings`, a storage failure returns `null` rather
 * than the wide 'all' default, so the caller can fail closed. A tier that was
 * never chosen is still 'all' — what the Messages list applies too.
 */
export const readStoredWotTier = async (pubkey: string): Promise<WotTier | null> => {
  try {
    await ensureSafetySettingsMigrated(pubkey);
    const known = peekAccountSetting(WOT_STORAGE_KEY_BASE, pubkey);
    if (known !== undefined) return parseWotSettings(known).wotTier;
    const raw = await AsyncStorage.getItem(perAccountKey(WOT_STORAGE_KEY_BASE, pubkey));
    return parseWotSettings(raw).wotTier;
  } catch {
    return null;
  }
};

export const saveWotSettings = async (
  settings: WotSettings,
  pubkey: string | null,
): Promise<void> => {
  if (!pubkey) return;
  const raw = JSON.stringify(settings);
  rememberAccountSetting(WOT_STORAGE_KEY_BASE, pubkey, raw);
  try {
    await ensureSafetySettingsMigrated(pubkey);
    await AsyncStorage.setItem(perAccountKey(WOT_STORAGE_KEY_BASE, pubkey), raw);
  } catch {
    // Best-effort; in-memory state still drives the session.
  }
};
