import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { perAccountKey } from './perAccountStorage';

/**
 * Local registry of LNURL-withdraw "Piggies" the user has hidden. Stored
 * in SecureStore because the LNURL string is a bearer token: anyone who
 * gets it can claim until the issuer-side cap is hit. Keeping it out of
 * AsyncStorage limits exposure to other apps + adb pulls on rooted dev
 * devices.
 *
 * Used by the Hunt feature (#468). The user creates the LNURL-w in
 * their wallet of choice (LNbits, Alby, Mutiny, …) and pastes it here
 * — see project memory `No LNbits-specific APIs`.
 *
 * Published as a **NIP-GC kind 37516** geocache listing marked with a
 * NIP-32 label (`["L","com.lightningpiggy.app"]` +
 * `["l","payout-lnurl-w","com.lightningpiggy.app"]`) — generic NIP-GC
 * clients (treasures.to, etc.) ignore the label and render the cache
 * as a standard listing, while LP recognises it and routes the finder
 * through HuntFoundScreen. **The LNURL bearer token is deliberately
 * NEVER on the wire** — it lives only on the physical NFC tag / QR
 * and in this SecureStore. See `feedback_lnurl_never_on_relays.md` and
 * `buildCacheListing` in `nostrPlacesService.ts` (which has a
 * security unit test asserting the absence). The `wait` / `uses`
 * fields below are local-only at present (used by the M5/M6 UI for
 * cooldown estimation) — the matching extension tags were considered
 * during design but dropped to avoid side-channel discoverability of
 * the cache's economics. Smart defaults: D=1, T=1, S=micro,
 * t=traditional — matching an NFC-tag Piggy anyone can find.
 */

// SecureStore on Android rejects keys containing characters outside
// `[A-Za-z0-9._-]` — the previous `'hunt-piggies:v1'` key threw
// "Invalid key provided to SecureStore" at every savePiggy call on
// Android. iOS keychain was more lenient and silently accepted the
// colon, which is why this bug only surfaced once Ben tested the
// publish flow on the Pixel. Renamed to a dash-delimited form.
//
// The old key never wrote successfully on Android, so Android users
// have nothing under it; iOS users may still have records there.
//
// Both keys below are the LEGACY device-wide blobs: every account on
// the phone read and wrote the same list, so a shared phone showed one
// account's bearer links and tag PINs to the next (#1781). Records now
// live under one key per account (`piggyStorageKey`). The legacy blobs
// carry no owner, so `claimLegacyPiggies` hands them — once, then
// deletes them — to the first account that becomes active on this
// build: on an upgrade that is the account restored at cold start, i.e.
// the one that was signed in when the app was last used.
const LEGACY_STORAGE_KEY = 'hunt-piggies-v1';
const LEGACY_STORAGE_KEY_IOS = 'hunt-piggies:v1';

/** SecureStore key holding `owner`'s Piglets (`[A-Za-z0-9._-]` only). */
export const piggyStorageKey = (owner: string): string =>
  perAccountKey(LEGACY_STORAGE_KEY, owner.toLowerCase());

export interface HiddenPiggy {
  id: string;
  /** The bech32-encoded LNURL string the user pasted (or scanned). */
  lnurlw: string;
  /** LNURL-withdraw link title (LUD-03 defaultDescription) captured at validation — used as the kind 37516 listing name + content. */
  lnurlDescription?: string;
  createdAt: number;
  /** When true, the hider has opted into publishing this Piggy as a
   * NIP-GC kind 37516 Nostr event (with the LP `lnurl` extension tag)
   * so strangers can find it via the Discover tab — and so generic
   * geocaching clients like treasures.to render it as a standard
   * cache. The publish itself happens in milestone 6; the flag is
   * stored here from the create flow. */
  isPublic: boolean;
  /** Last-edit timestamp (ms epoch), bumped on every save. The edit wizard
   * compares it against the published kind-37516 event's `created_at` to
   * decide which side is fresher — so a stale local record can't shadow a
   * newer cross-device edit (#596 / #681). Absent on pre-#681 records, in
   * which case the wizard falls back to `createdAt` and lets a present
   * event win. */
  updatedAt?: number;
  /** Snapshot of the LNURL-w endpoint's max-withdrawable (millisats) at
   * create time — purely informational; the live value is queried on
   * each finder claim. Optional because old / unreachable LNURLs may
   * have been resolved before but failed at re-validation. */
  maxWithdrawableMsat?: number;
  /** True when this listing is a Lightning Piggy (carries the NIP-32
   * `L`/`l` label on-relay), independent of whether the LNURL bearer is
   * present on THIS device. Cross-device edits (#596) hydrate from the
   * published event with `lnurlw: ''` but must still re-stamp the LP
   * label — so LP-ness follows this flag, not the local bearer string. */
  isLpPiggy?: boolean;
  /** Optional EXIF-stripped Blossom / nostr.build URL of a hint photo
   * uploaded at create time ("look near this bench"). Surfaces on the
   * finder celebration screen and on the public Piggy detail page when
   * isPublic. Stored as a URL only — the bytes themselves live with
   * the user's chosen Blossom server, not in SecureStore. */
  hintPhotoUrl?: string;
  /** Optional hider-published cooldown hint in seconds — mirrors the
   * `wait_time` setting in the hider's wallet (LNbits etc). Self-
   * reported; the LUD-03 metadata response itself is stateless and
   * doesn't expose this. Published as an LP `["wait", seconds]`
   * extension tag on the kind 37516 listing. Used by
   * HuntPiggyDetailScreen to render "next-available-in" estimates
   * alongside the latest claim timestamp from the kind 7516 found-log
   * thread. */
  waitSecondsHint?: number;
  /** Optional hider-published lifetime-uses hint — mirrors the
   * `uses` (a.k.a. "amount of uses") cap in the hider's wallet. Same
   * stateless-LUD-03 caveat: not in metadata, not protocol-enforced
   * here. Published as an LP `["uses", count]` extension tag. We
   * surface it on the detail screen alongside the count of kind 7516
   * found-logs so finders see "12/100 claims used" as a soft
   * availability hint. */
  usesHint?: number;
  /** Optional GPS pin captured at hide-time. Stored locally so the
   * hider can recall "where did I stash this?" later. ONLY published
   * to Nostr (as multi-precision `g` geohash tags on the kind 37516
   * listing) when the Piggy is marked public — private Piggies keep
   * their pin on-device. */
  lat?: number;
  lon?: number;
  /** Pre-computed 7-char geohash of (lat, lon). Convenience cache so
   * we don't re-encode on every render. Always derivable from
   * lat/lon via `encodeGeohash`. */
  geohash?: string;
  /** NIP-GC required field — short human-readable cache name. If
   * unset at publish time we fall back to the first ~50 chars of
   * memo. */
  name?: string;
  /** Finder-facing description — becomes the kind 37516 event
   * content. Falls back to `lnurlDescription` when the hider leaves
   * it blank in the Hide-a-Piglet wizard. */
  description?: string;
  /** NIP-GC required `D` field — finding difficulty 1-5. Defaults to
   * 1 (just-find-the-tag). User can override for caches that hide
   * the tag in a tricky place. */
  difficulty?: 1 | 2 | 3 | 4 | 5;
  /** NIP-GC required `T` field — physical terrain 1-5. Defaults to 1
   * (urban / accessible). Bump for hilltop / hike-required caches. */
  terrain?: 1 | 2 | 3 | 4 | 5;
  /** NIP-GC required `S` field. Defaults to `micro` since an NFC
   * sticker is small. */
  size?: 'micro' | 'small' | 'regular' | 'large' | 'other';
  /** NIP-GC optional `t` field (cache type). Defaults to
   * `traditional`. */
  cacheType?: 'traditional' | 'multi' | 'mystery' | 'virtual';
  /** NIP-40 expiration timestamp (seconds) — mirrors the `expiration`
   * tag persisted on the published kind 37516 listing. Recorded locally
   * so the My Piglets list can show "Expires in N days" / "Expired"
   * without needing a relay round-trip. Optional because pre-#21
   * Piggies didn't carry this; renderers should fall back to
   * `createdAt + 365 days` (the current default expiry) when missing. */
  expiresAt?: number;
  /** NIP-GC optional `hint` field — short prose clue. Stored
   * plaintext locally; ROT13-encoded on publish per the NIP-GC
   * client guidance to prevent inline spoilers. */
  hint?: string;
  /** Reversible NTAG21x PWD/PACK lock secrets, captured at write time
   * when the Hide-a-Piglet wizard's "Lock tag" toggle is on (default).
   * The 8-hex-char PWD becomes the hider-visible PIN on **step 6 of
   * the Hide-a-Piglet wizard** (the screen that owns the NFC write +
   * Edit re-entry), which is where the PIN card lives end-to-end. An
   * earlier design surfaced the PIN from My Piglets → Piglet detail;
   * that was dropped on user feedback ("doesn't need to be on the
   * actual Geocache page") and re-routed entirely through the wizard,
   * so the hider re-opens this record via the Edit affordance.
   *
   * Verification fields: `tagUid` is checked before any PWD_AUTH on
   * unlock so we never talk to a tag we didn't lock; `packHex` gates
   * the AUTH0=0xFF disable write so a PWD collision against an
   * unrelated tag can't silently open it. See `unlockHuntTag` for the
   * runtime checks. Issue #567. */
  nfcLock?: {
    /** Tag UID this lock was set on, hex-encoded as Android reports it. */
    tagUid: string;
    /** 8 uppercase hex chars — the NTAG215 4-byte PWD. Surfaced as the
     * hider's PIN. */
    pwdHex: string;
    /** 4 uppercase hex chars — the 2-byte PACK the chip returns on
     * PWD_AUTH. Used by the unlock flow to verify we're talking to the
     * right tag before disabling protection. */
    packHex: string;
    /** Wall-clock unix-seconds the tag was locked. Reserved for a
     * future "Locked on …" caption on the PIN card — the current UI
     * shows only the PIN + helper copy. Kept on the record so when
     * we do surface it, no migration is needed. */
    lockedAt: number;
  };
}

// `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` mirrors `identitiesStore` and
// `walletStorageService`: ensures the LNURL bearer tokens never end
// up in iCloud / device-migration backups, and are unreadable until
// the user has unlocked the device at least once since boot. Per
// Copilot review on PR #488 (was implicit before).
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const parsePiggies = (raw: string | null): HiddenPiggy[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isValidPiggy) : [];
  } catch {
    return [];
  }
};

const readOwnPiggies = async (owner: string): Promise<HiddenPiggy[]> => {
  try {
    return parsePiggies(await SecureStore.getItemAsync(piggyStorageKey(owner), SECURE_OPTIONS));
  } catch {
    return [];
  }
};

// Signed-out accounts: a save that read before the sign-out wipe and writes
// after it must not recreate the account's bearer links (#1781). Revived when
// the account becomes active again (same pattern as retireBuyerOrderTitles).
const retiredOwners = new Set<string>();
const pendingWrites = new Set<Promise<unknown>>();

const persist = async (owner: string, next: HiddenPiggy[]): Promise<void> => {
  if (retiredOwners.has(owner.toLowerCase())) {
    throw new Error('Signed out — Piglet not saved.');
  }
  const write = SecureStore.setItemAsync(
    piggyStorageKey(owner),
    JSON.stringify(next),
    SECURE_OPTIONS,
  );
  pendingWrites.add(write);
  try {
    await write;
  } finally {
    pendingWrites.delete(write);
  }
};

/** Account activation: `owner` may store Piglets again after a sign-out. */
export const revivePiggyOwner = (owner: string): void => {
  retiredOwners.delete(owner.toLowerCase());
};

// Who is mid-claim, persisted so a restart can't hand the same legacy bearer
// links to a second account: `pending:<owner>` before the copy is written,
// `done:<owner>` once it is, removed with the legacy blobs.
const LEGACY_CLAIM_MARKER_KEY = 'hunt-piggies-legacy-claim';

const deleteLegacyBlobs = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(LEGACY_STORAGE_KEY);
  if (Platform.OS === 'ios') await SecureStore.deleteItemAsync(LEGACY_STORAGE_KEY_IOS);
  await SecureStore.deleteItemAsync(LEGACY_CLAIM_MARKER_KEY);
};

/** Resolves true once the legacy blobs are gone (claimed by someone, or absent). */
const runLegacyClaim = async (owner: string): Promise<boolean> => {
  const me = owner.toLowerCase();
  const raw = await SecureStore.getItemAsync(LEGACY_STORAGE_KEY, SECURE_OPTIONS);
  // Android rejects the colon key outright, so only iOS can hold it; an
  // unreadable iOS entry is dropped rather than blocking the main claim.
  const rawIos =
    Platform.OS === 'ios'
      ? await SecureStore.getItemAsync(LEGACY_STORAGE_KEY_IOS, SECURE_OPTIONS).catch(() => null)
      : null;
  if (raw === null && rawIos === null) {
    await SecureStore.deleteItemAsync(LEGACY_CLAIM_MARKER_KEY).catch(() => undefined);
    return true;
  }
  const marker = await SecureStore.getItemAsync(LEGACY_CLAIM_MARKER_KEY, SECURE_OPTIONS);
  // Already copied to its owner: only the cleanup is left, safe for anyone.
  if (marker?.startsWith('done:')) {
    await deleteLegacyBlobs();
    return true;
  }
  // Another account started the claim and may not have its copy yet: leave
  // the blobs for that account to finish, and give this one nothing.
  if (marker && marker !== `pending:${me}`) return false;
  await SecureStore.setItemAsync(LEGACY_CLAIM_MARKER_KEY, `pending:${me}`, SECURE_OPTIONS);
  const legacy = [...parsePiggies(raw), ...parsePiggies(rawIos)];
  if (legacy.length > 0) {
    // The account's own records win an id clash, then the newer legacy key.
    const merged = new Map<string, HiddenPiggy>();
    for (const p of [...(await readOwnPiggies(owner)), ...legacy]) {
      if (!merged.has(p.id)) merged.set(p.id, p);
    }
    await persist(owner, [...merged.values()]);
  }
  await SecureStore.setItemAsync(LEGACY_CLAIM_MARKER_KEY, `done:${me}`, SECURE_OPTIONS);
  await deleteLegacyBlobs();
  return true;
};

// One claim at a time; concurrent callers (another account included) wait on
// it. Until the blobs are gone, later calls retry: a failed delete is redone
// by anyone, an unfinished copy only by the account that started it.
let legacyClaim: Promise<void> | null = null;
let legacyClaimed = false;

/**
 * Move the pre-#1781 device-wide Piglets to `owner`, once per device (see
 * LEGACY_STORAGE_KEY). Runs whenever an account becomes active and before
 * every read, so the blobs go to the first active account, never to whichever
 * account happens to open My Piglets later. Never rejects.
 */
export const claimLegacyPiggies = (owner: string | null | undefined): Promise<void> => {
  if (legacyClaimed) return Promise.resolve();
  if (!legacyClaim) {
    if (!owner) return Promise.resolve();
    legacyClaim = runLegacyClaim(owner).then(
      (settled) => {
        legacyClaimed = settled;
        if (!settled) legacyClaim = null;
      },
      () => {
        legacyClaim = null;
      },
    );
  }
  return legacyClaim;
};

/** `owner`'s Piglets; none without a signed-in account. */
export const loadPiggies = async (owner: string | null | undefined): Promise<HiddenPiggy[]> => {
  if (!owner) return [];
  await claimLegacyPiggies(owner);
  return readOwnPiggies(owner);
};

/** `owner`'s Piglet with this id, if any. */
export const findPiggy = async (
  owner: string | null | undefined,
  id: string,
): Promise<HiddenPiggy | undefined> => (await loadPiggies(owner)).find((p) => p.id === id);

export const savePiggy = async (
  owner: string | null | undefined,
  piggy: HiddenPiggy,
): Promise<HiddenPiggy[]> => {
  if (!owner) throw new Error('No signed-in account — Piglet not saved.');
  const list = await loadPiggies(owner);
  // Replace by id if a record with the same id already exists, otherwise
  // prepend so the newest sits at the top of the user's list.
  const idx = list.findIndex((p) => p.id === piggy.id);
  const next = idx >= 0 ? list.map((p, i) => (i === idx ? piggy : p)) : [piggy, ...list];
  await persist(owner, next);
  return next;
};

export const removePiggy = async (
  owner: string | null | undefined,
  id: string,
): Promise<HiddenPiggy[]> => {
  if (!owner) return [];
  const list = await loadPiggies(owner);
  const next = list.filter((p) => p.id !== id);
  await persist(owner, next);
  return next;
};

/** Sign-out wipe: delete every Piglet (bearer links, tag PINs) of `owner`. */
export const deletePiggiesForOwner = async (owner: string): Promise<void> => {
  const me = owner.toLowerCase();
  // No later save may land; one already writing (or a claim copying this
  // account's records) must finish before the delete.
  retiredOwners.add(me);
  await legacyClaim;
  await Promise.allSettled([...pendingWrites]);
  await SecureStore.deleteItemAsync(piggyStorageKey(owner));
  // Legacy blobs this account had started claiming are its records too.
  const marker = await SecureStore.getItemAsync(LEGACY_CLAIM_MARKER_KEY, SECURE_OPTIONS);
  if (marker === `pending:${me}` || marker === `done:${me}`) await deleteLegacyBlobs();
};

/** True when `owner` has Piglets stored here (or the read failed: warn anyway). */
export const hasStoredPiggies = async (owner: string): Promise<boolean> => {
  try {
    const raw = await SecureStore.getItemAsync(piggyStorageKey(owner), SECURE_OPTIONS);
    return parsePiggies(raw).length > 0;
  } catch {
    return true;
  }
};

/** Test-only: forget this run's legacy claim and retired owners. */
export const __resetLegacyPiggyClaimForTests = (): void => {
  legacyClaim = null;
  legacyClaimed = false;
  retiredOwners.clear();
};

/**
 * Generate a short stable id for a fresh Piggy. We don't need
 * cryptographic uniqueness — the LNURL string itself is the bearer
 * token — so a millis + suffix is plenty.
 */
export const newPiggyId = (): string =>
  `piggy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const isValidPiggy = (v: unknown): v is HiddenPiggy => {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (
    typeof p.id !== 'string' ||
    typeof p.lnurlw !== 'string' ||
    typeof p.createdAt !== 'number' ||
    typeof p.isPublic !== 'boolean'
  ) {
    return false;
  }
  // Optional fields — accept absent or correctly-typed; reject wrong-typed.
  if (p.hintPhotoUrl !== undefined && typeof p.hintPhotoUrl !== 'string') return false;
  if (p.waitSecondsHint !== undefined && typeof p.waitSecondsHint !== 'number') return false;
  if (p.usesHint !== undefined && typeof p.usesHint !== 'number') return false;
  if (p.maxWithdrawableMsat !== undefined && typeof p.maxWithdrawableMsat !== 'number')
    return false;
  if (p.isLpPiggy !== undefined && typeof p.isLpPiggy !== 'boolean') return false;
  if (p.updatedAt !== undefined && typeof p.updatedAt !== 'number') return false;
  if (p.lat !== undefined && typeof p.lat !== 'number') return false;
  if (p.lon !== undefined && typeof p.lon !== 'number') return false;
  if (p.geohash !== undefined && typeof p.geohash !== 'string') return false;
  if (p.name !== undefined && typeof p.name !== 'string') return false;
  if (p.description !== undefined && typeof p.description !== 'string') return false;
  if (
    p.difficulty !== undefined &&
    (typeof p.difficulty !== 'number' || p.difficulty < 1 || p.difficulty > 5)
  )
    return false;
  if (p.terrain !== undefined && (typeof p.terrain !== 'number' || p.terrain < 1 || p.terrain > 5))
    return false;
  if (
    p.size !== undefined &&
    !['micro', 'small', 'regular', 'large', 'other'].includes(p.size as string)
  )
    return false;
  if (
    p.cacheType !== undefined &&
    !['traditional', 'multi', 'mystery', 'virtual'].includes(p.cacheType as string)
  )
    return false;
  if (p.hint !== undefined && typeof p.hint !== 'string') return false;
  // expiresAt — Unix seconds when the published listing's NIP-40
  // expiration stamps. undefined = 'Never' picker option (no expiration
  // tag emitted). Pre-fix a corrupted 'soon' string would pass and
  // produce "expiration", "NaN" on the wire.
  if (p.expiresAt !== undefined && typeof p.expiresAt !== 'number') return false;
  // nfcLock — added in #567. Optional, but if present every field is
  // required (a half-written lock record would mean we can't authenticate
  // the unlock and the tag is effectively bricked from this app's POV).
  if (p.nfcLock !== undefined) {
    const lock = p.nfcLock as Record<string, unknown> | null;
    if (
      !lock ||
      typeof lock !== 'object' ||
      typeof lock.tagUid !== 'string' ||
      // Non-empty hex required — pre-fix any string (including empty)
      // passed the type check, but unlockHuntTag skips the UID guard
      // when expectedUid is falsy, so an empty UID would silently
      // disable wrong-tag protection for that record (Copilot #572
      // r4 catch). NTAG21x UIDs are 7 bytes = 14 hex chars; Android
      // typically lowercases them but case-insensitive comparison
      // happens at unlock time.
      !/^[0-9A-Fa-f]+$/.test(lock.tagUid) ||
      typeof lock.pwdHex !== 'string' ||
      !/^[0-9A-Fa-f]{8}$/.test(lock.pwdHex) ||
      typeof lock.packHex !== 'string' ||
      !/^[0-9A-Fa-f]{4}$/.test(lock.packHex) ||
      typeof lock.lockedAt !== 'number'
    ) {
      return false;
    }
  }
  return true;
};
