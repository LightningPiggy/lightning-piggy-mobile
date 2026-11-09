import { useEffect, type Dispatch, type SetStateAction, type RefObject } from 'react';
import type { ExploreNavigation, HuntCacheFallback } from '../navigation/types';
import type { LnurlWithdrawParams } from '../services/lnurlWithdrawService';
import { loadPiggies } from '../services/piggyStorageService';
import { decodeGeohash } from '../utils/geohash';
import Toast from '../components/BrandedToast';
import { t } from '../i18n';

export type HuntCreateStage =
  | { kind: 'idle' }
  | { kind: 'validating' }
  | { kind: 'validated'; params: LnurlWithdrawParams }
  // Hider chose to publish a no-reward cache: no LNURL, no prize. A
  // publishable state like 'validated', but yields a plain NIP-GC
  // listing (no `amount` tag) because there is no withdraw link.
  | { kind: 'noPrize' }
  | { kind: 'saved'; lnurlw: string }
  | { kind: 'writing-nfc' }
  | { kind: 'wrote-nfc' };

interface HydrationOptions {
  editingId: string | null;
  fallbackCache: HuntCacheFallback | null;
  navigation: ExploreNavigation;
  pubkey: string | null;
  originalCreatedAt: RefObject<number | null>;
  piggyIdRef: RefObject<string | null>;
  amountManuallyEdited: RefObject<boolean>;
  setAmountSatsText: Dispatch<SetStateAction<string>>;
  setCrossDeviceEdit: Dispatch<SetStateAction<boolean>>;
  setIsLpPiggyEdit: Dispatch<SetStateAction<boolean>>;
  setLnurl: Dispatch<SetStateAction<string>>;
  setIsPublic: Dispatch<SetStateAction<boolean>>;
  setStage: Dispatch<SetStateAction<HuntCreateStage>>;
  setLastWrittenLock: Dispatch<
    SetStateAction<{ pwdHex: string; packHex: string; pin: string; tagUid: string } | null>
  >;
  setHintPhotoUrl: Dispatch<SetStateAction<string | null>>;
  setWaitMinutesText: Dispatch<SetStateAction<string>>;
  setUsesText: Dispatch<SetStateAction<string>>;
  setPin: Dispatch<SetStateAction<{ lat: number; lon: number; geohash: string } | null>>;
  setCacheName: Dispatch<SetStateAction<string>>;
  setCacheDescription: Dispatch<SetStateAction<string>>;
  setCacheHint: Dispatch<SetStateAction<string>>;
  setDifficulty: Dispatch<SetStateAction<1 | 2 | 3 | 4 | 5>>;
  setTerrain: Dispatch<SetStateAction<1 | 2 | 3 | 4 | 5>>;
  setCacheSize: Dispatch<SetStateAction<'micro' | 'small' | 'regular' | 'large' | 'other'>>;
  setCacheType: Dispatch<SetStateAction<'traditional' | 'multi' | 'mystery' | 'virtual'>>;
  setExpiryDays: Dispatch<SetStateAction<'30' | '90' | '180' | '365' | 'never'>>;
}

// Locale changes must not reload saved values over the draft. Imperative toast
// messages use the shared translator to read the current locale at call time.
export function useHuntCreateHydration({
  editingId,
  fallbackCache,
  navigation,
  pubkey,
  originalCreatedAt,
  piggyIdRef,
  amountManuallyEdited,
  setAmountSatsText,
  setCrossDeviceEdit,
  setIsLpPiggyEdit,
  setLnurl,
  setIsPublic,
  setStage,
  setLastWrittenLock,
  setHintPhotoUrl,
  setWaitMinutesText,
  setUsesText,
  setPin,
  setCacheName,
  setCacheDescription,
  setCacheHint,
  setDifficulty,
  setTerrain,
  setCacheSize,
  setCacheType,
  setExpiryDays,
}: HydrationOptions) {
  // Edit-mode hydration: load the matching HiddenPiggy on mount and
  // seed every wizard field. We synthesise a `validated` Stage too so
  // the LNURL step renders its "looks good" affordance straight away —
  // editors don't need to re-paste the link they already vetted. The
  // expiryDays picker is reverse-engineered from the saved window so
  // the chip selection lines up with what the user originally picked.
  useEffect(() => {
    // Local records belong to an account (#1781), so wait for the signer:
    // `pubkey` is in the deps and the effect re-runs once it resolves. Showing
    // the error toast before then would flash a false "Local record missing".
    if (!editingId || !pubkey) return;
    let cancelled = false;
    loadPiggies(pubkey).then((all) => {
      if (cancelled) return;
      // Shared hydration for the published-event fields (the cross-device
      // source of truth). Used by BOTH the no-local-record path and the
      // local-record-is-stale path below, so the two can't drift. Sets only
      // the public / finder-facing fields — the LNURL bearer, prize stage,
      // NFC lock, and isPublic are decided per-branch (the event never
      // carries the bearer, so that stays local-only).
      const hydratePublicFieldsFromEvent = (fc: HuntCacheFallback) => {
        if (typeof fc.geohash === 'string' && fc.geohash.length > 0) {
          const { lat, lng } = decodeGeohash(fc.geohash);
          setPin({ lat, lon: lng, geohash: fc.geohash });
        }
        setCacheName(fc.name ?? '');
        setCacheDescription(fc.description ?? '');
        // fc.hint is already ROT13-DECODED plaintext (ParsedCache.hint) — pre-fill
        // it raw so the publisher's re-rot13 round-trips it, no double-encode.
        setCacheHint(fc.hint ?? '');
        if (typeof fc.difficulty === 'number')
          setDifficulty(Math.min(5, Math.max(1, fc.difficulty)) as 1 | 2 | 3 | 4 | 5);
        if (typeof fc.terrain === 'number')
          setTerrain(Math.min(5, Math.max(1, fc.terrain)) as 1 | 2 | 3 | 4 | 5);
        if (
          fc.size === 'micro' ||
          fc.size === 'small' ||
          fc.size === 'regular' ||
          fc.size === 'large' ||
          fc.size === 'other'
        ) {
          setCacheSize(fc.size);
        }
        if (
          fc.cacheType === 'traditional' ||
          fc.cacheType === 'multi' ||
          fc.cacheType === 'mystery' ||
          fc.cacheType === 'virtual'
        ) {
          setCacheType(fc.cacheType);
        }
        if (fc.imageUrl) setHintPhotoUrl(fc.imageUrl);
        if (typeof fc.waitSeconds === 'number')
          setWaitMinutesText(String(Math.round(fc.waitSeconds / 60)));
        if (typeof fc.uses === 'number') setUsesText(String(fc.uses));
        // Reverse-map the event's NIP-40 expiry back onto a picker chip so a
        // metadata-only save doesn't silently change the listing's expiry.
        if (typeof fc.expiresAt !== 'number' || fc.expiresAt === null) {
          setExpiryDays('never');
        } else {
          const windowSec = fc.expiresAt - fc.createdAt;
          const day = 24 * 60 * 60;
          const closest = [
            { key: '30' as const, sec: 30 * day },
            { key: '90' as const, sec: 90 * day },
            { key: '180' as const, sec: 180 * day },
            { key: '365' as const, sec: 365 * day },
          ].reduce((best, opt) =>
            Math.abs(opt.sec - windowSec) < Math.abs(best.sec - windowSec) ? opt : best,
          ).key;
          setExpiryDays(closest);
        }
      };
      const piggy = all.find((p) => p.id === editingId);
      if (!piggy) {
        // Cross-device edit fallback (#596): local record is missing
        // (the Piggy was created on another phone), but the active
        // identity might still own the Nostr event. If the caller
        // supplied a fallbackCache AND its author matches the current
        // pubkey, hydrate the wizard from the published event instead
        // of bailing. LNURL stays empty — the user will paste a fresh
        // one if they want to re-write the tag, otherwise step 6 is
        // skippable and the save updates the listing only.
        if (fallbackCache && fallbackCache.hiderPubkey.toLowerCase() === pubkey.toLowerCase()) {
          setCrossDeviceEdit(true);
          setIsLpPiggyEdit(fallbackCache.isLpPiggy);
          // Seed the editable "Sats per claim" field from the published
          // advertised prize so a cross-device edit shows the current
          // value (and preserves it on save) even though the LNURL bearer
          // isn't on this device (#626 / #681 review). Skipped if the
          // hider already typed a value.
          if (
            !amountManuallyEdited.current &&
            typeof fallbackCache.payoutSats === 'number' &&
            fallbackCache.payoutSats > 0
          ) {
            setAmountSatsText(String(fallbackCache.payoutSats));
          }
          piggyIdRef.current = editingId;
          // Anchor createdAt to the on-relay event so the NIP-40 expiry
          // window we restamp at save time aligns with the original
          // hide. The event stores unix-seconds; HiddenPiggy.createdAt
          // is ms, so multiply to match.
          originalCreatedAt.current = fallbackCache.createdAt * 1000;
          // LNURL deliberately stays empty. Stage stays `idle` so step
          // 2's validate-affordance is what the user sees if they want
          // to paste a fresh link.
          hydratePublicFieldsFromEvent(fallbackCache);
          // The cache is on-relay, so it must have been published —
          // default isPublic on. The user can flip it off on step 6
          // before save if they want to convert it to a private Piggy.
          setIsPublic(true);
          return;
        }
        Toast.show({
          type: 'error',
          text1: t('huntCreateScreen.cantEditPiglet'),
          text2: t('huntCreateScreen.localRecordMissing'),
        });
        navigation.goBack();
        return;
      }
      originalCreatedAt.current = piggy.createdAt;
      piggyIdRef.current = piggy.id;
      setLnurl(piggy.lnurlw);
      setIsPublic(piggy.isPublic);
      // LP-ness for the prize/cooldown/uses affordances. Take it from the
      // local record OR the published event (fallbackCache) — whichever
      // says LP, since the published event is the source of truth. A stale
      // local *stub* (blank `lnurlw`, and `isLpPiggy` unset on an old
      // record or saved `false` by a prior reward-dropping edit) would
      // otherwise read as non-LP and wrongly lock the fields even though
      // the listing carries the LP label on relays (Hawthorn case, #692;
      // follows the #681 edit-Piglet work).
      setIsLpPiggyEdit(
        (piggy.isLpPiggy ?? Boolean(piggy.lnurlw)) || (fallbackCache?.isLpPiggy ?? false),
      );
      // Re-hydrate the post-write PIN row so the hider returning via Edit
      // can recover the PIN they wrote earlier. The NFC lock is local-only
      // (never on the event), so it always comes from the local record —
      // whichever side wins for the public fields below.
      if (piggy.nfcLock) {
        setLastWrittenLock({
          pwdHex: piggy.nfcLock.pwdHex,
          packHex: piggy.nfcLock.packHex,
          pin: piggy.nfcLock.pwdHex.toUpperCase(),
          tagUid: piggy.nfcLock.tagUid,
        });
      }
      // Cross-device source of truth: when the published event is newer
      // than this device's local record, the listing was edited on another
      // device — trust the event for the public fields AND the advertised
      // prize, keeping only the LNURL bearer (local-only) from this record.
      // A missing local `updatedAt` (pre-#681 records) falls back to the
      // original hide time, so any present event wins — the safe default
      // when the event is canonical (#596 / #681).
      const eventIsFresher =
        !!fallbackCache && fallbackCache.createdAt * 1000 > (piggy.updatedAt ?? piggy.createdAt);
      const eventPayoutMsat =
        eventIsFresher &&
        fallbackCache &&
        typeof fallbackCache.payoutSats === 'number' &&
        fallbackCache.payoutSats > 0
          ? fallbackCache.payoutSats * 1000
          : undefined;
      setStage({
        kind: 'validated',
        params: {
          // Synthesise the minimum LnurlWithdrawParams shape — only the
          // two fields read by the save handler are required, and the
          // editor isn't re-validating the LNURL unless they paste a
          // new one (which resets stage back through `handleValidate`).
          defaultDescription: piggy.lnurlDescription ?? '',
          // Prize: the event's published amount when it is the fresher
          // source, else the local record's. The sync effect mirrors this
          // into the editable "Sats per claim" field.
          maxWithdrawable: eventPayoutMsat ?? piggy.maxWithdrawableMsat ?? 0,
          minWithdrawable: 0,
          callback: '',
          k1: '',
        },
      });
      if (eventIsFresher && fallbackCache) {
        hydratePublicFieldsFromEvent(fallbackCache);
        return;
      }
      setHintPhotoUrl(piggy.hintPhotoUrl ?? null);
      setWaitMinutesText(
        typeof piggy.waitSecondsHint === 'number'
          ? String(Math.round(piggy.waitSecondsHint / 60))
          : '',
      );
      setUsesText(typeof piggy.usesHint === 'number' ? String(piggy.usesHint) : '');
      if (
        typeof piggy.lat === 'number' &&
        typeof piggy.lon === 'number' &&
        typeof piggy.geohash === 'string'
      ) {
        setPin({ lat: piggy.lat, lon: piggy.lon, geohash: piggy.geohash });
      } else if (typeof fallbackCache?.geohash === 'string' && fallbackCache.geohash.length > 0) {
        // Local record predates location capture (no lat/lon) but the
        // published listing carries a geohash — seed the pin from it so
        // the map centres on where the Piglet was actually hidden instead
        // of falling through to "Use my location" (#681 location fix).
        const { lat, lng } = decodeGeohash(fallbackCache.geohash);
        setPin({ lat, lon: lng, geohash: fallbackCache.geohash });
      }
      setCacheName(piggy.name ?? '');
      setCacheDescription(piggy.description ?? '');
      // piggy.hint is stored as decoded plaintext (the publisher applies rot13
      // on write) — pre-fill as-is so re-publishing round-trips it unchanged.
      setCacheHint(piggy.hint ?? '');
      setDifficulty(piggy.difficulty ?? 1);
      setTerrain(piggy.terrain ?? 1);
      setCacheSize(piggy.size ?? 'micro');
      setCacheType(piggy.cacheType ?? 'traditional');
      // Reverse-map expiresAt back to one of the picker chips. Falls
      // back to 365d when the saved window doesn't match a preset.
      if (typeof piggy.expiresAt !== 'number') {
        // Pre-#21 records didn't persist expiresAt locally, but the
        // publisher still stamped a 1y NIP-40 tag on the wire. Default
        // the picker to 365d so re-save preserves the original
        // intent; the user can flip to Never if they want to drop it.
        setExpiryDays('365');
      } else {
        // Normalise units: createdAt is ms (Date.now()), expiresAt is
        // unix-seconds. Same unit-mismatch trap as in republishPiggyService.
        const window = piggy.expiresAt - Math.floor(piggy.createdAt / 1000);
        const day = 24 * 60 * 60;
        const closest = [
          { key: '30' as const, sec: 30 * day },
          { key: '90' as const, sec: 90 * day },
          { key: '180' as const, sec: 180 * day },
          { key: '365' as const, sec: 365 * day },
        ].reduce((best, opt) =>
          Math.abs(opt.sec - window) < Math.abs(best.sec - window) ? opt : best,
        ).key;
        setExpiryDays(closest);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    editingId,
    fallbackCache,
    navigation,
    pubkey,
    originalCreatedAt,
    piggyIdRef,
    amountManuallyEdited,
    setAmountSatsText,
    setCrossDeviceEdit,
    setIsLpPiggyEdit,
    setLnurl,
    setIsPublic,
    setStage,
    setLastWrittenLock,
    setHintPhotoUrl,
    setWaitMinutesText,
    setUsesText,
    setPin,
    setCacheName,
    setCacheDescription,
    setCacheHint,
    setDifficulty,
    setTerrain,
    setCacheSize,
    setCacheType,
    setExpiryDays,
  ]);
}
