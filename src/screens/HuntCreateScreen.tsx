import BrandedSpinner from '../components/BrandedSpinner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
// SAF + base64 helpers live on the legacy expo-file-system module. The
// new class API (File/Paths) doesn't expose StorageAccessFramework yet,
// so we mix the two: class API for the cache copy, legacy for the SAF
// "save to Files" flow on Android.
import { StorageAccessFramework as SAF, readAsStringAsync } from 'expo-file-system/legacy';
import { stageStlInCache } from '../services/stageStlInCache';
import * as Sharing from 'expo-sharing';
import {
  Camera,
  Check,
  CheckCircle2,
  Info,
  ChevronLeft,
  Clipboard as ClipboardIcon,
  QrCode,
  Globe,
  ImagePlus,
  Copy,
  Eye,
  EyeOff,
  Lock,
  MapPin,
  Nfc,
  Unlock,
  PiggyBank,
  Printer,
  ShoppingBag,
  X,
} from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import {
  crossDevicePrizeLine as formatCrossDevicePrizeLine,
  validatedSatsLine as formatValidatedSatsLine,
} from '../utils/huntPrizeLines';
import { useNostr } from '../contexts/NostrContext';
import { createHuntCreateScreenStyles } from '../styles/HuntCreateScreen.styles';
import {
  LevelPicker,
  NfcSupportedTagsCard,
  OptionPicker,
  StepHeader,
  StepNavRow,
  StepProgressBar,
} from '../components/HuntCreateWizardChrome';
import type { RouteProp } from '@react-navigation/native';
import { ExploreNavigation, ExploreStackParamList } from '../navigation/types';
import { Alert } from '../components/BrandedAlert';
import Toast from '../components/BrandedToast';
import {
  LnurlWithdrawError,
  msatToSats,
  resolveLnurlWithdraw,
} from '../services/lnurlWithdrawService';
import { findPiggy, newPiggyId, savePiggy } from '../services/piggyStorageService';
import { stripImageMetadata, uploadImage } from '../services/imageUploadService';
import { encodeGeohash } from '../utils/geohash';
import { buildCacheListing, GC_LISTING_KIND, parseCache } from '../services/nostrPlacesService';
import { peekCachedCachesSync, saveCaches } from '../services/nostrPlacesStorage';
import * as nip19 from 'nostr-tools/nip19';
import { publishCacheEvent } from '../services/nostrPlacesPublisher';
import NfcWriteSheet from '../components/NfcWriteSheet';
import NfcUnlockSheet from '../components/NfcUnlockSheet';
import LocationPickerSheet from '../components/LocationPickerSheet';
import { LibreMiniMap } from '../components/LibreMiniMap';
import { useUserLocation } from '../contexts/UserLocationContext';
import { canWriteHuntTag } from './huntCreateNfcGate';
import {
  useHuntCreateHydration,
  type HuntCreateStage as Stage,
} from '../hooks/useHuntCreateHydration';

interface Props {
  navigation: ExploreNavigation;
  // Optional — when present, the wizard opens in edit mode for the
  // matching local HiddenPiggy. Same screen, pre-filled state, re-emits
  // the kind 37516 listing under the same `d` tag on save.
  route?: RouteProp<ExploreStackParamList, 'HuntCreate'>;
}

const HuntCreateScreen: React.FC<Props> = ({ navigation, route }) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createHuntCreateScreenStyles(colors), [colors]);
  const { signEvent, relays, pubkey } = useNostr();
  // Live user position for the hide-pin preview map. Map is centred on
  // the pin the user picked; the user dot follows them as they
  // potentially walk closer / further while finalising the hide.
  const { pos: livePos } = useUserLocation();

  // Edit-mode identity. When the route carries a `piggyId` we reuse it
  // (and the original createdAt) on save so `savePiggy` overwrites the
  // existing record AND the kind 37516 listing republished under the
  // same `d` tag replaces the previous one on relays via NIP-33.
  const editingId = route?.params?.piggyId ?? null;
  const fallbackCache = route?.params?.fallbackCache ?? null;
  const isEditMode = editingId !== null;
  // Cross-device edit (#596): the user opened Edit on a phone that
  // doesn't have the local HiddenPiggy record, but they ARE the event
  // author (proven by pubkey match in the hydration effect below). The
  // wizard hydrates from the published kind 37516 event instead of
  // SecureStore; LNURL stays blank until the user pastes a fresh one,
  // and step 6's NFC-write step becomes optional so they can update
  // the listing without re-writing a tag they may not be near.
  const [crossDeviceEdit, setCrossDeviceEdit] = useState(false);
  // Whether the listing being edited is a Lightning Piggy. Tracked
  // separately from the (possibly absent) LNURL bearer so a cross-device
  // edit re-stamps the LP label instead of downgrading the Piglet to a
  // plain NIP-GC cache (#596 / #681 review).
  const [isLpPiggyEdit, setIsLpPiggyEdit] = useState(false);
  // Original createdAt is preserved across edits — the unix-seconds
  // anchor for NIP-40 windows. Captured during the hydration effect
  // below; null until then (and forever when creating fresh).
  const originalCreatedAt = useRef<number | null>(null);
  // Piggy id is stable across NFC-write (step 4) and Save/publish
  // (step 6). Holding it in a ref means the kind 37516 `d` tag, the
  // local HiddenPiggy record, AND the NFC tag's nostr:naddr + LP-URL
  // records all reference the same identifier. Lazy-init: editing
  // mode hydrates from the existing id; fresh hides mint on first
  // access via `ensurePiggyId()` below.
  const piggyIdRef = useRef<string | null>(null);
  const ensurePiggyId = useCallback((): string => {
    if (piggyIdRef.current === null) {
      piggyIdRef.current = editingId ?? newPiggyId();
    }
    return piggyIdRef.current;
  }, [editingId]);
  // Tracks the LNURL we've already re-resolved on edit, so the prize-
  // recovery effect (#626) runs at most once per link.
  const prizeReresolvedFor = useRef<string | null>(null);

  const [lnurl, setLnurl] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  // Wizard pagination — 1 to 6. Each step renders its own page; Back
  // and Next live under each step's content. Top StepProgressBar pips
  // also let the user jump between steps directly.
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const [hintPhotoUrl, setHintPhotoUrl] = useState<string | null>(null);
  const [uploadingHint, setUploadingHint] = useState(false);
  const [waitMinutesText, setWaitMinutesText] = useState('');
  const [usesText, setUsesText] = useState('');
  // Editable prize amount (sats per claim). Pre-filled from the LNURL's
  // maxWithdrawable but overridable, so the hider can adjust the advertised
  // prize without re-pasting the link (#626).
  const [amountSatsText, setAmountSatsText] = useState('');
  // Flips true once the hider types in the prize field, so the LNURL-derived
  // auto-fill stops overwriting their value.
  const amountManuallyEdited = useRef(false);
  const [pin, setPin] = useState<{ lat: number; lon: number; geohash: string } | null>(null);
  const [pinning, setPinning] = useState(false);
  // Bottom-sheet visibility for the NFC-write flow (step 3) and the
  // map-based location picker (step 4).
  const [nfcSheetVisible, setNfcSheetVisible] = useState(false);
  // Whether to write a reversible PWD/PACK lock onto the tag alongside
  // the NDEF data (Android only). Default ON — issue #567 makes this
  // the recommended hider posture so a passer-by can't repoint the tag.
  // Toggle sits on step 6 next to the Write button.
  const [lockTag, setLockTag] = useState<boolean>(true);
  // Captured from `writeHuntTagToTag`'s return value on a successful
  // locked-write. Surfaces as the post-write PIN row on step 6 + drives
  // the Unlock-tag affordance. Persisted in parallel onto the
  // HiddenPiggy via `handleNfcWritten` so editing the Piglet later
  // re-hydrates the same value — and the in-memory copy is
  // deliberately kept across reopens of the write sheet so a rewrite
  // can PWD_AUTH with the existing PIN and the hider doesn't have to
  // track a fresh one. Only `handleNfcWritten` and the unlock-success
  // path update it.
  const [lastWrittenLock, setLastWrittenLock] = useState<{
    pwdHex: string;
    packHex: string;
    pin: string;
    tagUid: string;
  } | null>(null);
  const [pinRevealed, setPinRevealed] = useState(false);
  const [unlockSheetOpen, setUnlockSheetOpen] = useState(false);
  // Tracks whether the most recent unlock sheet open actually completed
  // the unlock. The sheet's success state can only render while
  // `lastWrittenLock` is truthy (the sheet is rendered conditionally on
  // it), so we delay clearing the in-memory PIN until the sheet has
  // closed — and only then if `onUnlocked` fired. Avoids the "Tag
  // unlocked" success state being unmounted before the hider sees it
  // (Copilot #572 review).
  const unlockSucceededRef = useRef(false);
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);
  // QR-scan modal for the LNURL input. Opened from the scan icon next
  // to the paste button on step 2. Permission state is held by
  // expo-camera's hook — null until first request resolves; we present
  // a Grant button when the user has denied or not yet asked.
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  // Geocache-info step (step 5) — finder-facing metadata that becomes
  // the kind 37516 listing. Everything has a NIP-GC default so the
  // step can be skipped through.
  const [cacheName, setCacheName] = useState('');
  const [cacheDescription, setCacheDescription] = useState('');
  // NIP-GC revealable hint — a light, opt-in clue for stuck hunters. Stored
  // ROT13-obfuscated on the relay (the publisher applies rot13 from
  // `piggy.hint`), so this state always holds the PLAINTEXT the hider typed.
  const [cacheHint, setCacheHint] = useState('');
  const [difficulty, setDifficulty] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [terrain, setTerrain] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [cacheSize, setCacheSize] = useState<'micro' | 'small' | 'regular' | 'large' | 'other'>(
    'micro',
  );
  const [cacheType, setCacheType] = useState<'traditional' | 'multi' | 'mystery' | 'virtual'>(
    'traditional',
  );
  // NIP-40 expiry window (in days) the listing will be stamped with at
  // publish time. 365d is the default — long enough that an active
  // hider isn't punished by a 4-week holiday, short enough that
  // genuinely abandoned caches fade out of relay searches. "Never"
  // omits the expiration tag entirely (the cache stays on-relay until
  // someone supersedes it).
  const [expiryDays, setExpiryDays] = useState<'30' | '90' | '180' | '365' | 'never'>('365');

  useHuntCreateHydration({
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
  });

  // Recover the live prize amount when editing (#626). The edit-load above
  // seeds the prize from the local record's `maxWithdrawableMsat`, which can
  // be 0/undefined for older or cross-device records — and republishing with
  // 0 would wipe the `amount` tag off the kind-37516 event (the ⚡ vanishes).
  // So re-resolve the already-stored LNURLw once (no re-paste) to pull its
  // real maxWithdrawable. Best-effort: if the link can't be reached we keep
  // whatever amount we already had rather than clobbering it.
  useEffect(() => {
    if (!isEditMode) return;
    const ln = lnurl.trim();
    if (!ln) return;
    // Already have a confirmed non-zero amount — nothing to recover.
    if (stage.kind === 'validated' && msatToSats(stage.params.maxWithdrawable) > 0) return;
    if (prizeReresolvedFor.current === ln) return;
    prizeReresolvedFor.current = ln;
    let cancelled = false;
    resolveLnurlWithdraw(ln)
      .then((params) => {
        if (!cancelled && msatToSats(params.maxWithdrawable) > 0)
          setStage({ kind: 'validated', params });
      })
      .catch(() => {
        // Link unreachable right now — leave the existing amount intact.
      });
    return () => {
      cancelled = true;
    };
  }, [isEditMode, lnurl, stage]);

  // Keep the editable prize field in sync with the LNURL's resolved amount
  // (on validate / re-resolve / edit-load — all of which set `stage`), unless
  // the hider has typed their own value.
  useEffect(() => {
    if (amountManuallyEdited.current) return;
    if (stage.kind === 'validated' && msatToSats(stage.params.maxWithdrawable) > 0) {
      setAmountSatsText(String(msatToSats(stage.params.maxWithdrawable)));
    }
  }, [stage]);

  // Single entry point for setting the LNURL from ANY source — typing,
  // paste or scan. Besides storing the value it drops a prior `validated`
  // or `noPrize` stage back to `idle`, so a changed link re-engages the
  // Validate affordance and is re-vetted before publish. Callers pre-shape
  // the value (trim / strip `lightning:`); the stage reset is shared here
  // so paste can't leave stale validation behind (#955 review). The
  // functional `setStage` keeps this correct without a `stage` dependency.
  const applyLnurl = useCallback((value: string) => {
    setLnurl(value);
    setStage((prev) =>
      prev.kind === 'validated' || prev.kind === 'noPrize' ? { kind: 'idle' } : prev,
    );
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const v = await Clipboard.getStringAsync();
      if (v) applyLnurl(v.trim());
    } catch {
      // Clipboard read can fail silently on cold start; nothing user-actionable.
    }
  }, [applyLnurl]);

  // Open the QR scanner — if permission was already granted we skip
  // straight to the camera; otherwise the modal shows a Grant button
  // and the user can request access in-context. The scanner self-
  // closes on the first successful read.
  const handleOpenScanner = useCallback(async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        // User denied — open the modal anyway so they can see the
        // "Camera access needed" copy + retry the prompt.
      }
    }
    setScannerOpen(true);
  }, [cameraPermission?.granted, requestCameraPermission]);

  // Camera scanner callback — fires once when the native barcode
  // detector recognises a QR. We strip an optional "lightning:"
  // prefix because LNURL QRs in the wild come both ways; the
  // validation step accepts either, but the input field reads
  // cleaner without the prefix.
  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (!scannerOpen) return;
      const trimmed = data.trim();
      const lnurlOnly = /^lightning:/i.test(trimmed)
        ? trimmed.slice('lightning:'.length).trim()
        : trimmed;
      applyLnurl(lnurlOnly);
      setScannerOpen(false);
    },
    [scannerOpen, applyLnurl],
  );

  const handleValidate = useCallback(async () => {
    if (!lnurl.trim()) {
      Alert.alert(
        t('huntCreateScreen.pasteLnurlFirst'),
        t('huntCreateScreen.pasteLnurlFirstBody'),
        [{ text: t('huntCreateScreen.ok') }],
      );
      return;
    }
    setStage({ kind: 'validating' });
    try {
      const params = await resolveLnurlWithdraw(lnurl);
      setStage({ kind: 'validated', params });
    } catch (e) {
      const msg =
        e instanceof LnurlWithdrawError
          ? e.message
          : t('huntCreateScreen.couldNotResolveLnurl', { message: (e as Error).message });
      setStage({ kind: 'idle' });
      Alert.alert(t('huntCreateScreen.notAWithdrawLink'), msg, [
        { text: t('huntCreateScreen.ok') },
      ]);
    }
  }, [lnurl, t]);

  const handleSave = useCallback(async () => {
    console.log(
      `[Publish] handleSave called — stage=${stage.kind} crossDeviceEdit=${crossDeviceEdit} isPublic=${isPublic} pubkey=${pubkey ? pubkey.slice(0, 8) + '…' : 'null'}`,
    );
    // Cross-device edit accepts an `idle` stage: the user can update
    // metadata (title, location, etc.) without re-validating an LNURL
    // they may not have on this device. A fresh hide publishes from
    // either `validated` (LNURL vetted) or `noPrize` (the hider opted
    // out of a reward) — the prize is genuinely optional.
    if (stage.kind !== 'validated' && stage.kind !== 'noPrize' && !crossDeviceEdit) {
      console.log(`[Publish] aborted: stage not publishable (was ${stage.kind})`);
      return;
    }
    const waitMinutes = parseInt(waitMinutesText.trim(), 10);
    const usesParsed = parseInt(usesText.trim(), 10);
    // Preserve identity across an edit so `savePiggy` overwrites the
    // existing record AND the relay-side kind 37516 listing replaces
    // itself under the same `d` tag (NIP-33 addressable). createdAt
    // stays anchored to the original hide moment so the My Piglets
    // sort order doesn't reshuffle on every edit.
    //
    // Pre-load the existing record so we can carry forward fields the
    // wizard doesn't surface — currently `nfcLock` (set by the NFC
    // write path, never reconstructed from wizard state). Without this
    // an edit-save wiped the stored PIN and the hider could no longer
    // unlock the tag (Copilot #572 review).
    const existing = editingId ? await findPiggy(pubkey, editingId) : undefined;
    // In cross-device mode the stage may still be `idle` — pick up
    // defaults from the wizard state instead of `stage.params`. The
    // user can still paste a fresh LNURL on step 2, which flips stage
    // to `validated` and the normal path applies. If they don't,
    // `lnurlw` saves as an empty string and the local stub still
    // registers in My Piglets — next edit on this device works the
    // normal hydration path.
    const lnurlDescription =
      stage.kind === 'validated' ? (stage.params.defaultDescription ?? undefined) : undefined;
    // Prize amount: prefer the editable "Sats per claim" field (the hider can
    // adjust the advertised prize without re-pasting the LNURL, #626); fall
    // back to the LNURL's resolved maxWithdrawable. A blank/0 field with no
    // resolved amount leaves it undefined so no `amount` tag is written.
    const editedSats = parseInt(amountSatsText.trim(), 10);
    // Cross-device fallback: the advertised prize carried from the
    // published listing, so a metadata-only edit (no LNURL on this
    // device, blank field) preserves the existing `amount` instead of
    // wiping it — the original #626 regression (#681 review).
    const carriedPayoutMsat =
      typeof fallbackCache?.payoutSats === 'number' && fallbackCache.payoutSats > 0
        ? fallbackCache.payoutSats * 1000
        : undefined;
    // LP-ness follows the listing, not the (possibly absent) bearer: a
    // fresh hide / local edit has the LNURL in hand; a cross-device edit
    // carries the flag from the published event. amount / wait / uses are
    // LP-only display hints, so for a plain NIP-GC cache we force them to
    // undefined — never write a "Prize" / cooldown chip onto a non-LP
    // listing, even if the fields somehow held a value (#681 review).
    const listingIsLp = isLpPiggyEdit || Boolean(lnurl.trim()) || existing?.isLpPiggy || false;
    const waitSecondsHint =
      listingIsLp && Number.isFinite(waitMinutes) && waitMinutes > 0 ? waitMinutes * 60 : undefined;
    const usesHint =
      listingIsLp && Number.isFinite(usesParsed) && usesParsed > 0 ? usesParsed : undefined;
    const maxWithdrawableMsat = !listingIsLp
      ? undefined
      : Number.isFinite(editedSats) && editedSats > 0
        ? editedSats * 1000
        : stage.kind === 'validated'
          ? stage.params.maxWithdrawable
          : (existing?.maxWithdrawableMsat ?? carriedPayoutMsat);
    const piggy = {
      ...(existing ?? {}),
      id: ensurePiggyId(),
      lnurlw: lnurl.trim(),
      lnurlDescription,
      createdAt: originalCreatedAt.current ?? Date.now(),
      // Last-write timestamp (ms), bumped on every save. Compared against
      // the published event's `created_at` on the next edit so a stale
      // local record can't shadow a newer cross-device edit (#596 / #681).
      updatedAt: Date.now(),
      isPublic,
      maxWithdrawableMsat,
      isLpPiggy: listingIsLp,
      hintPhotoUrl: hintPhotoUrl ?? undefined,
      waitSecondsHint,
      usesHint,
      lat: pin?.lat,
      lon: pin?.lon,
      geohash: pin?.geohash,
      // Geocache-info step — finder-facing metadata.
      name: cacheName.trim() || undefined,
      description: cacheDescription.trim() || undefined,
      // Plaintext hint — the publisher ROT13-obfuscates it onto the kind 37516
      // event (`['hint', rot13(piggy.hint)]`). Empty → undefined drops the tag.
      hint: cacheHint.trim() || undefined,
      difficulty,
      terrain,
      size: cacheSize,
      cacheType,
      // Mirror the NIP-40 expiry the publisher stamps onto the kind
      // 37516 listing so My Piglets can show "Expires in N days"
      // without needing a relay round-trip. `null` means "no
      // expiration tag" — set by the user via the "Never" picker
      // option. nostrPlacesService.buildCacheListing reads this
      // (passed through piggy.expiresAt) and omits the tag when null.
      expiresAt:
        expiryDays === 'never'
          ? undefined
          : Math.floor(Date.now() / 1000) + parseInt(expiryDays, 10) * 24 * 60 * 60,
    };
    console.log(`[Publish] savePiggy starting (id=${piggy.id})`);
    try {
      await savePiggy(pubkey, piggy);
    } catch (e) {
      console.log(`[Publish] savePiggy threw: ${(e as Error)?.message ?? e}`);
      Toast.show({
        type: 'error',
        text1: t('huntCreateScreen.couldNotSavePiggy'),
        text2: (e as Error).message,
      });
      return;
    }
    console.log(`[Publish] savePiggy ok`);
    setStage({ kind: 'saved', lnurlw: piggy.lnurlw });
    Toast.show({
      type: 'success',
      text1: isEditMode ? t('huntCreateScreen.piggyUpdated') : t('huntCreateScreen.piggyHidden'),
    });

    // If the hider opted into Public, build + sign + publish the kind
    // 37516 NIP-GC listing with the com.lightningpiggy.app label. The LNURL itself
    // does NOT go on the event (see buildCacheListing comments + the
    // unit test that asserts this invariant). Failures are non-fatal:
    // the local Piggy is saved either way, the user can retry publish
    // later from MyPiggies.
    if (piggy.isPublic) {
      try {
        if (typeof piggy.lat !== 'number' || typeof piggy.lon !== 'number') {
          console.log(`[Publish] aborted: no location pin`);
          Toast.show({
            type: 'info',
            text1: t('huntCreateScreen.savedLocallyDropPin'),
            text2: t('huntCreateScreen.savedLocallyDropPinBody'),
          });
          return;
        }
        console.log(`[Publish] buildCacheListing`);
        const unsigned = buildCacheListing(piggy);
        console.log(`[Publish] signEvent calling — signer pubkey known? ${pubkey ? 'yes' : 'NO'}`);
        const signed = await signEvent(unsigned);
        console.log(`[Publish] signEvent returned: ${signed ? 'signed' : 'null'}`);
        if (!signed) {
          Toast.show({
            type: 'error',
            text1: t('huntCreateScreen.couldNotSignListing'),
            text2: t('huntCreateScreen.couldNotSignListingBody'),
          });
          return;
        }
        const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
        console.log(`[Publish] publishCacheEvent → ${writeRelays.length || 'default'} relays`);
        await publishCacheEvent(signed, writeRelays.length > 0 ? writeRelays : undefined);
        console.log(`[Publish] publishCacheEvent ok`);
        // Mirror the just-published event into the local ParsedCache
        // cache that MyPiglets reads from. Otherwise the listing only
        // appears after the user's NIP-GC subscription echoes it back
        // — and that subscription is paused while the user is on this
        // wizard (per #557's tab-blur pause), so the event lands at
        // a dead subscriber. Parsing locally + writing to the same
        // store the subscriber would have written to bridges the gap.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parsedFromSigned = parseCache(signed as any);
          if (parsedFromSigned) {
            const current = peekCachedCachesSync();
            const existingIdx = current.findIndex((c) => c.coord === parsedFromSigned.coord);
            const next =
              existingIdx >= 0
                ? current.map((c, i) => (i === existingIdx ? parsedFromSigned : c))
                : [parsedFromSigned, ...current];
            saveCaches(next);
            console.log(`[Publish] mirrored to local cache (coord=${parsedFromSigned.coord})`);
          }
        } catch (mirrorErr) {
          console.warn(`[Publish] local-cache mirror failed: ${(mirrorErr as Error).message}`);
        }
        Toast.show({
          type: 'success',
          text1: isEditMode
            ? t('huntCreateScreen.piggyRepublished')
            : t('huntCreateScreen.piggyPublished'),
          text2: isEditMode
            ? t('huntCreateScreen.updatedListingLive')
            : t('huntCreateScreen.visibleOnDiscover'),
        });
      } catch (e) {
        console.log(`[Publish] publish path threw: ${(e as Error)?.message ?? e}`);
        Toast.show({
          type: 'error',
          text1: t('huntCreateScreen.couldNotPublish'),
          text2: (e as Error).message,
        });
      }
    }
    // After a successful edit we send the user back to where they came
    // from (typically the Piggy detail screen). For fresh hides we
    // stay on the saved-stage UI so the print/NFC steps remain
    // reachable — those don't apply on re-edit.
    if (isEditMode) {
      navigation.goBack();
    }
  }, [
    stage,
    lnurl,
    isPublic,
    hintPhotoUrl,
    waitMinutesText,
    usesText,
    amountSatsText,
    pin,
    cacheName,
    cacheDescription,
    cacheHint,
    difficulty,
    terrain,
    cacheSize,
    cacheType,
    expiryDays,
    crossDeviceEdit,
    isLpPiggyEdit,
    fallbackCache,
    ensurePiggyId,
    editingId,
    isEditMode,
    navigation,
    pubkey,
    signEvent,
    relays,
    t,
  ]);

  const handlePinHere = useCallback(async () => {
    if (pinning) return;
    setPinning(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert(
          t('huntCreateScreen.permissionNeeded'),
          t('huntCreateScreen.locationPermissionBody'),
          [{ text: t('huntCreateScreen.ok') }],
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      setPin({ lat, lon, geohash: encodeGeohash(lat, lon, 9) });
    } catch (e) {
      Alert.alert(t('huntCreateScreen.couldNotGetLocation'), (e as Error).message, [
        { text: t('huntCreateScreen.ok') },
      ]);
    } finally {
      setPinning(false);
    }
  }, [pinning, t]);

  const handleClearPin = useCallback(() => setPin(null), []);

  // ----- "Save STL" — share + save-to-Files --------------------------------
  // The 3D-printable Piggy Bag Charm ships bundled in /assets/3d. On iOS the
  // OS share sheet already includes "Save to Files" when the UTI is set, so
  // the existing shareAsync path is fine. On Android the share sheet only
  // lists apps that handle the MIME type — "Files" rarely appears — so we
  // surface an explicit "Save to Files" path via the Storage Access
  // Framework (SAF) alongside the share-to-app fallback. One button, prompt
  // on tap, no extra UI bloat.

  const shareStl = useCallback(async () => {
    const target = await stageStlInCache();
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(target.uri, {
        mimeType: 'model/stl',
        dialogTitle: t('huntCreateScreen.saveStlTitle'),
        UTI: 'public.standard-tesselated-geometry-format',
      });
    }
  }, [t]);

  const saveStlToFiles = useCallback(async () => {
    // SAF has no file:// copy primitive: pick a directory, create the STL,
    // then copy its bytes through JS. Base64 is fine for this small file;
    // larger files would need chunking.
    const target = await stageStlInCache();
    const perm = await SAF.requestDirectoryPermissionsAsync();
    if (!perm.granted) return;
    const destUri = await SAF.createFileAsync(
      perm.directoryUri,
      'piggy-bag-charm.stl',
      // application/octet-stream is the broadly-recognised fallback. The
      // .stl extension still drives most apps' handling on the read side.
      'application/octet-stream',
    );
    const base64 = await readAsStringAsync(target.uri, { encoding: 'base64' });
    await SAF.writeAsStringAsync(destUri, base64, { encoding: 'base64' });
    Toast.show({ type: 'success', text1: t('huntCreateScreen.savedStl') });
  }, [t]);

  const handleSaveStl = useCallback(async () => {
    try {
      if (Platform.OS === 'android') {
        // Two-option prompt — "Save to Files" first (recommended, matches
        // what most users want), "Share…" preserves the original flow.
        Alert.alert(t('huntCreateScreen.saveStlTitle'), t('huntCreateScreen.saveStlPrompt'), [
          { text: t('huntCreateScreen.saveToFiles'), onPress: () => void saveStlToFiles() },
          { text: t('huntCreateScreen.share'), onPress: () => void shareStl() },
          { text: t('huntCreateScreen.cancel'), style: 'cancel' },
        ]);
        return;
      }
      // iOS — share sheet already includes "Save to Files" via the UTI.
      await shareStl();
    } catch (e) {
      Toast.show({
        type: 'info',
        text1: t('huntCreateScreen.couldNotSaveStl'),
        text2: (e as Error).message,
      });
    }
  }, [saveStlToFiles, shareStl, t]);

  // ----- hint photo capture / library --------------------------------------

  const uploadHintPhoto = useCallback(
    async (uri: string, base64?: string | null) => {
      setUploadingHint(true);
      try {
        const scrubbed = await stripImageMetadata(uri, base64);
        const url = await uploadImage(scrubbed.uri, signEvent ?? null, scrubbed.base64);
        setHintPhotoUrl(url);
        Toast.show({ type: 'success', text1: t('huntCreateScreen.hintPhotoUploaded') });
      } catch (e) {
        Alert.alert(t('huntCreateScreen.uploadFailed'), (e as Error).message, [
          { text: t('huntCreateScreen.ok') },
        ]);
      } finally {
        setUploadingHint(false);
      }
    },
    [signEvent, t],
  );

  const handlePickHintFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        t('huntCreateScreen.permissionNeeded'),
        t('huntCreateScreen.libraryPermissionBody'),
        [{ text: t('huntCreateScreen.ok') }],
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    await uploadHintPhoto(result.assets[0].uri, result.assets[0].base64);
  }, [uploadHintPhoto, t]);

  const handleTakeHintPhoto = useCallback(async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        t('huntCreateScreen.permissionNeeded'),
        t('huntCreateScreen.cameraPermissionBody'),
        [{ text: t('huntCreateScreen.ok') }],
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 1,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    await uploadHintPhoto(result.assets[0].uri, result.assets[0].base64);
  }, [uploadHintPhoto, t]);

  const handleRemoveHintPhoto = useCallback(() => setHintPhotoUrl(null), []);

  // Open the NFC-write bottom sheet (step 3). The sheet owns the
  // write + locking flow and its own progress / error UI; on success
  // it calls `onWritten`, which advances the stage so the stepper +
  // step header flip to "done".
  const handleOpenNfcSheet = useCallback(() => {
    // A reward LNURL is enough on its own. A no-prize public cache has
    // an empty LNURL by design but still writes the 2-record hunt
    // payload (LP deep link + nostr:naddr) via `writeHuntTagToTag`, so
    // `isPublic && pubkey` opens the sheet too (#954/#955). Only the
    // private single-record path genuinely needs an LNURL.
    if (!canWriteHuntTag({ lnurl, isPublic, pubkey })) return;
    // We deliberately keep `lastWrittenLock` populated when reopening
    // the sheet so a rewrite of the same Piglet PWD_AUTHs the chip
    // with the previously-stored PIN and the hider doesn't have to
    // track a fresh one (#567). Only the post-write success path
    // updates this state — a failed rewrite leaves the original lock
    // intact on both the chip and in storage, so the PIN card keeps
    // showing the right secret.
    setPinRevealed(false);
    setNfcSheetVisible(true);
  }, [lnurl, isPublic, pubkey]);

  const handleOpenUnlockSheet = useCallback(() => {
    unlockSucceededRef.current = false;
    setUnlockSheetOpen(true);
  }, []);

  const handleUnlockSheetClose = useCallback(() => {
    setUnlockSheetOpen(false);
    // Only clear the in-memory PIN if the unlock actually completed —
    // otherwise the hider's cancel/error should leave the PIN card in
    // place so they can retry without losing the PIN. The sheet's own
    // success state has already played by this point (we render the
    // sheet conditional on `lastWrittenLock` being truthy, so it stays
    // mounted through the success animation up until this close).
    if (unlockSucceededRef.current) {
      setLastWrittenLock(null);
      setPinRevealed(false);
      Toast.show({ type: 'success', text1: t('huntCreateScreen.tagUnlocked') });
    }
    unlockSucceededRef.current = false;
  }, [t]);

  const handleUnlocked = useCallback(async () => {
    unlockSucceededRef.current = true;
    // Clear the on-disk lock immediately so a crash before the sheet
    // closes still leaves the storage in the right shape. The wizard
    // keeps showing the PIN card until the sheet calls onClose.
    const id = ensurePiggyId();
    try {
      const existing = await findPiggy(pubkey, id);
      if (existing && existing.nfcLock) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { nfcLock, ...rest } = existing;
        await savePiggy(pubkey, rest);
      }
    } catch (e) {
      console.warn(`[HuntCreate] clear nfcLock after unlock failed: ${(e as Error)?.message ?? e}`);
    }
  }, [ensurePiggyId, pubkey]);

  const handleNfcWritten = useCallback(
    async (result?: {
      locked: boolean;
      lock?: { pwdHex: string; packHex: string; pin: string; tagUid: string };
    }) => {
      // Persist the freshly-set NTAG21x PWD/PACK against the matching
      // HiddenPiggy so the My-Piglets PIN row + unlock flow can pick it
      // up later. The write sheet returns the secrets only when the
      // Android locked-write path ran; iOS / `lockTag=false` give us
      // `result.lock === undefined` and we leave the record alone.
      // Issue #567.
      if (result?.lock) {
        // Surface the PIN immediately on step 6 so the hider can copy /
        // photograph it before the screen rotates away. Persistence
        // below is the durable copy that survives wizard exit.
        setLastWrittenLock(result.lock);
        setPinRevealed(false);
        // Persist the secrets onto the matching HiddenPiggy. The
        // hider's tag is now physically locked with `result.lock.pwd`
        // — if we lose this record they can read the LNURL but never
        // unlock or rewrite the chip. Treat persist failure as a
        // top-level alert (Copilot #572 review) so the hider can copy
        // the PIN manually from the on-screen card before dismissing.
        try {
          const id = ensurePiggyId();
          const existing = await findPiggy(pubkey, id);
          if (existing) {
            const next = {
              ...existing,
              nfcLock: {
                tagUid: result.lock.tagUid,
                pwdHex: result.lock.pwdHex,
                packHex: result.lock.packHex,
                lockedAt: Math.floor(Date.now() / 1000),
              },
            };
            await savePiggy(pubkey, next);
            console.log(`[HuntCreate] persisted nfcLock for piggy=${id} uid=${result.lock.tagUid}`);
          } else {
            // The local HiddenPiggy hasn't been written yet (locked
            // write happened before Publish on step 5). Surface a
            // visible warning — the PIN is only on screen, not on
            // disk yet — and instruct the hider to copy it before
            // tapping Done.
            Alert.alert(t('huntCreateScreen.savePinNow'), t('huntCreateScreen.savePinNowBody'));
          }
        } catch (e) {
          console.warn(`[HuntCreate] persist nfcLock failed: ${(e as Error)?.message ?? e}`);
          Alert.alert(
            t('huntCreateScreen.pinNotSaved'),
            t('huntCreateScreen.pinNotSavedBody', { message: (e as Error).message }),
          );
        }
      } else {
        // No lock result returned — either lockTag was off (iOS / hider
        // chose unlocked) or the writer is a non-Piglet flow. Either
        // way, don't clobber any pre-existing `lastWrittenLock` from
        // edit mode: the previous PIN may still be valid on a tag
        // we didn't actually touch this round.
      }
      setStage({ kind: 'wrote-nfc' });
    },
    [ensurePiggyId, pubkey, t],
  );

  const handleDone = useCallback(() => navigation.goBack(), [navigation]);

  // ----- presentation helpers ------------------------------------------------

  const validatedSatsLine =
    stage.kind === 'validated'
      ? formatValidatedSatsLine(
          stage.params.minWithdrawable,
          stage.params.maxWithdrawable,
          t,
          formatLocale,
        )
      : null;
  const crossDevicePrizeLine = formatCrossDevicePrizeLine(amountSatsText, t, formatLocale);

  // True when the NFC step's primary button should be enabled. Step 5
  // (Publish) sets stage='saved' or 'wrote-nfc' in the fresh-hide
  // flow. In edit mode the listing was already published in a prior
  // session, so an existing local HiddenPiggy + validated LNURL is
  // enough — the relay-side event exists.
  const nfcReady =
    stage.kind === 'saved' ||
    stage.kind === 'wrote-nfc' ||
    (isEditMode && stage.kind === 'validated') ||
    // Cross-device edit without a fresh LNURL: the user is updating
    // the listing only, no NFC write. The Save button still appears
    // on step 6, but the Write-Tag affordance stays disabled until a
    // fresh LNURL is pasted on step 2.
    (crossDeviceEdit && stage.kind === 'idle');

  // Whether the listing being edited/created is a Lightning Piggy, for the
  // prize affordances. Edit mode synthesises a `validated` stage even for a
  // plain NIP-GC cache (so Save works), so `stage.kind === 'validated'`
  // alone would wrongly expose prize editing + a "Looks good" card on a
  // non-LP cache. LP-ness in the wizard = a withdraw link is present
  // (`lnurl`) OR the edited listing is flagged LP (#681 review).
  const listingIsLpInEdit = lnurl.trim().length > 0 || isLpPiggyEdit;

  // Whether the Step 6 NFC-write flow may proceed. See `canWriteHuntTag`
  // for the reasoning: a reward LNURL always works, a no-prize public
  // cache (#954/#955) writes the 2-record payload with no LNURL, and a
  // private no-LNURL listing stays gated.
  const canWriteNfcTag = canWriteHuntTag({ lnurl, isPublic, pubkey });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      testID="hunt-create-screen-root"
    >
      <View style={styles.container} testID="hunt-create-screen">
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            accessibilityLabel={t('huntCreateScreen.backToHunt')}
            testID="hunt-create-back-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <ChevronLeft size={24} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {isEditMode ? t('huntCreateScreen.editPiglet') : t('huntCreateScreen.hideAPiglet')}
          </Text>
          <View style={styles.headerRightSpacer} />
        </View>

        <StepProgressBar
          currentStep={currentStep}
          onPipPress={(n) => setCurrentStep(n)}
          styles={styles}
        />

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {currentStep === 1 && (
            <>
              <StepHeader
                n={1}
                title={t('huntCreateScreen.step1Title')}
                subtitle={t('huntCreateScreen.step1Subtitle')}
                status="active"
                styles={styles}
                colors={colors}
              />
              <View style={styles.getPiggyCard} testID="get-a-piggy-card">
                <Text style={styles.getPiggyTitle}>{t('huntCreateScreen.needAPhysicalPiggy')}</Text>
                <Text style={styles.getPiggyHelper}>
                  {t('huntCreateScreen.needAPhysicalPiggyHelper')}
                </Text>
                <Image
                  source={require('../../assets/images/piggy-bag-charm.jpg')}
                  style={styles.getPiggyPhoto}
                  resizeMode="cover"
                  accessibilityLabel={t('huntCreateScreen.bagCharmPhotoAlt')}
                />
                <View style={styles.getPiggyButtonsRow}>
                  <TouchableOpacity
                    style={[styles.getPiggyButton, styles.getPiggyButtonPrint]}
                    onPress={handleSaveStl}
                    testID="get-a-piggy-print-button"
                    accessibilityLabel={t('huntCreateScreen.saveStlTitle')}
                  >
                    <Printer size={18} color={colors.white} strokeWidth={2.5} />
                    <Text style={styles.getPiggyButtonText}>{t('huntCreateScreen.saveStl')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.getPiggyButton, styles.getPiggyButtonBuy]}
                    onPress={() =>
                      Linking.openURL(
                        // NIP-99 classified listing (kind 30402) for the Lightning
                        // Piggy Bag Charm at Robotechy. The naddr decodes to:
                        //   pubkey 211f325b…d46f, identifier product_1768341201209_bm83o.
                        'https://www.robotechy.com/naddr1qvzqqqrkcgpzqgglxfd4895k3tqv0xmupgps6a5zqmfj43slj0c58hs39wzeh4r0qqdhqun0v36kxazlxymnvwpnxscnyvp3xgcrjhmzd5urxmcxaljpu',
                      )
                    }
                    testID="get-a-piggy-buy-button"
                    accessibilityLabel={t('huntCreateScreen.buyFromRobotechy')}
                  >
                    <ShoppingBag size={18} color={colors.white} strokeWidth={2.5} />
                    <Image
                      source={require('../../assets/images/robotechy-logo.png')}
                      style={styles.robotechyLogo}
                      resizeMode="contain"
                      accessibilityLabel="Robotechy"
                    />
                  </TouchableOpacity>
                </View>
                {/* Quick tag-spec hint up front — surfaces what to buy before
                 * the user clicks Buy/Print, so they don't come back with a
                 * Mifare Classic and find out it can't lock at NFC-write
                 * time. The full Supported-NFC-tags card stays below after
                 * Validate for the deeper "I'm actually writing the tag now"
                 * moment. */}
                <View style={styles.getPiggyTagsHint}>
                  <Nfc size={12} color={colors.brandPink} strokeWidth={2.5} />
                  <Text style={styles.getPiggyTagsHintText}>
                    <Text style={styles.getPiggyTagsHintBold}>
                      {t('huntCreateScreen.tagChipsLabel')}
                    </Text>{' '}
                    {t('huntCreateScreen.tagChipsHint')}
                  </Text>
                </View>
              </View>
              <StepNavRow onNext={() => setCurrentStep(2)} styles={styles} colors={colors} />
            </>
          )}

          {currentStep === 2 && (
            <>
              <StepHeader
                n={2}
                title={t('huntCreateScreen.step2Title')}
                subtitle={t('huntCreateScreen.step2Subtitle')}
                status={
                  stage.kind === 'validated' ||
                  stage.kind === 'noPrize' ||
                  stage.kind === 'saved' ||
                  stage.kind === 'wrote-nfc'
                    ? 'done'
                    : 'active'
                }
                styles={styles}
                colors={colors}
              />
              {crossDeviceEdit && stage.kind !== 'validated' && (
                <View style={styles.crossDeviceBanner} testID="hunt-piggy-cross-device-banner">
                  <Text style={styles.crossDeviceBannerText}>
                    {t('huntCreateScreen.crossDeviceBanner')}
                  </Text>
                </View>
              )}
              <Text style={styles.helper}>{t('huntCreateScreen.createWithdrawLinkHelper')}</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  placeholder="lnurl1… or lightning:LNURL1…"
                  placeholderTextColor={colors.textSupplementary}
                  value={lnurl}
                  // Typing a link supersedes a "skip prize" choice and
                  // invalidates a prior validation — `applyLnurl` drops the
                  // stage back to idle so the Validate affordance re-engages
                  // (shared with paste + scan so all three behave the same).
                  onChangeText={applyLnurl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  // Single line — LNURLs are long but truncating visually
                  // is fine. Multi-line was wrapping the LNURL across 3-4
                  // lines on a Pixel, pushing the cooldown / uses inputs
                  // below the fold + behind the on-screen keyboard.
                  numberOfLines={1}
                  testID="hunt-piggy-lnurl-input"
                />
                <TouchableOpacity
                  onPress={handleOpenScanner}
                  style={styles.pasteButton}
                  accessibilityLabel={t('huntCreateScreen.scanLnurlQr')}
                  testID="hunt-piggy-scan-button"
                >
                  <QrCode size={18} color={colors.brandPink} strokeWidth={2} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handlePaste}
                  style={styles.pasteButton}
                  accessibilityLabel={t('huntCreateScreen.pasteFromClipboard')}
                  testID="hunt-piggy-paste-button"
                >
                  <ClipboardIcon size={18} color={colors.brandPink} strokeWidth={2} />
                </TouchableOpacity>
              </View>

              {stage.kind !== 'validated' &&
                stage.kind !== 'noPrize' &&
                stage.kind !== 'saved' &&
                stage.kind !== 'wrote-nfc' && (
                  <TouchableOpacity
                    style={[styles.primaryButton, !lnurl.trim() && styles.primaryButtonDisabled]}
                    disabled={!lnurl.trim() || stage.kind === 'validating'}
                    onPress={handleValidate}
                    testID="hunt-piggy-validate-button"
                  >
                    {stage.kind === 'validating' ? (
                      <BrandedSpinner onGradient />
                    ) : (
                      <Text style={styles.primaryButtonText}>{t('huntCreateScreen.validate')}</Text>
                    )}
                  </TouchableOpacity>
                )}

              {/* The prize is genuinely optional. On a fresh hide (no
                  cross-device edit), let the hider publish a no-reward
                  cache without pasting a withdraw link — flips the stage
                  to `noPrize`, a publishable state that writes a plain
                  NIP-GC listing with no `amount` tag. Hidden once an LNURL
                  is validated, while saving, or in an edit flow. */}
              {!crossDeviceEdit &&
                !isEditMode &&
                !lnurl.trim() &&
                stage.kind !== 'noPrize' &&
                stage.kind !== 'validated' &&
                stage.kind !== 'validating' &&
                stage.kind !== 'saved' &&
                stage.kind !== 'wrote-nfc' && (
                  <TouchableOpacity
                    style={styles.skipPrizeButton}
                    onPress={() => setStage({ kind: 'noPrize' })}
                    testID="hunt-create-skip-prize"
                    accessibilityLabel={t('huntCreateScreen.skipPrizeAccessibility')}
                  >
                    <Text style={styles.skipPrizeButtonText}>
                      {t('huntCreateScreen.skipPrizeButton')}
                    </Text>
                  </TouchableOpacity>
                )}

              {/* Confirmation that this will be a no-reward cache, with an
                  escape hatch back to add a prize. */}
              {stage.kind === 'noPrize' && (
                <View style={styles.validatedCard} testID="hunt-create-no-prize-card">
                  <Info size={20} color={colors.brandPink} strokeWidth={2.5} />
                  <View style={styles.validatedTextWrapper}>
                    <Text style={styles.validatedTitle}>{t('huntCreateScreen.noReward')}</Text>
                    <Text style={styles.validatedMeta}>{t('huntCreateScreen.noRewardBody')}</Text>
                    <TouchableOpacity
                      onPress={() => setStage({ kind: 'idle' })}
                      testID="hunt-create-add-prize-instead"
                      accessibilityLabel={t('huntCreateScreen.addPrizeInstead')}
                    >
                      <Text style={styles.addPrizeInsteadText}>
                        {t('huntCreateScreen.addPrizeInstead')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* A withdraw link is present + validated on THIS phone:
                  green "Looks good". */}
              {stage.kind === 'validated' && listingIsLpInEdit && lnurl.trim().length > 0 && (
                <View style={styles.validatedCard}>
                  <CheckCircle2 size={20} color={colors.green} strokeWidth={2.5} />
                  <View style={styles.validatedTextWrapper}>
                    <Text style={styles.validatedTitle}>{t('huntCreateScreen.looksGood')}</Text>
                    {validatedSatsLine && (
                      <Text style={styles.validatedMeta}>{validatedSatsLine}</Text>
                    )}
                    {stage.params.defaultDescription ? (
                      <Text style={styles.validatedDescription}>
                        &ldquo;{stage.params.defaultDescription}&rdquo;
                      </Text>
                    ) : null}
                  </View>
                </View>
              )}
              {/* The withdraw link lives on the device it was set up on
                  (cross-device edit). No green "validated" tick we didn't
                  earn, no "0 sats" — show the published prize if known and
                  let the hider edit the prize / cooldown / uses below. */}
              {crossDeviceEdit && listingIsLpInEdit && lnurl.trim().length === 0 && (
                <View style={styles.validatedCard}>
                  <Info size={20} color={colors.brandPink} strokeWidth={2.5} />
                  <View style={styles.validatedTextWrapper}>
                    <Text style={styles.validatedTitle}>
                      {t('huntCreateScreen.linkOnAnotherDevice')}
                    </Text>
                    <Text style={styles.validatedMeta}>
                      {t('huntCreateScreen.linkOnAnotherDeviceBody')}
                    </Text>
                    {crossDevicePrizeLine && (
                      <Text style={styles.validatedMeta}>{crossDevicePrizeLine}</Text>
                    )}
                  </View>
                </View>
              )}

              {/* Editable prize amount — pre-filled from the LNURL's
                maxWithdrawable (LUD-03) but overridable, so the hider can
                adjust the advertised sats without re-pasting the link (#626).
                Display hint only; the live LNURL stays authoritative for the
                actual payout. */}
              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.satsPerClaimLabel')}
              </Text>
              <View style={styles.hintField}>
                <TextInput
                  style={styles.input}
                  placeholder={t('huntCreateScreen.amountPlaceholder')}
                  placeholderTextColor={colors.textSupplementary}
                  keyboardType="number-pad"
                  value={amountSatsText}
                  onChangeText={(t) => {
                    amountManuallyEdited.current = true;
                    setAmountSatsText(t);
                  }}
                  editable={(stage.kind === 'validated' || crossDeviceEdit) && listingIsLpInEdit}
                  testID="hunt-piggy-amount-input"
                />
              </View>

              {/* Cooldown + total uses live with the prize — they're
                attributes of the LNURL-withdraw link, not the publish
                step. The LNURL-w protocol response (LUD-03) only carries
                the per-claim amount, so cooldown / uses can't be read
                back automatically — the hider re-enters them here as
                soft hints; the wallet still does the actual enforcement. */}
              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.cooldownUsesLabel')}
              </Text>
              <View style={styles.hintsRow}>
                <View style={styles.hintField}>
                  <Text style={styles.hintFieldLabel}>{t('huntCreateScreen.cooldownMins')}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder={t('huntCreateScreen.cooldownPlaceholder')}
                    placeholderTextColor={colors.textSupplementary}
                    keyboardType="number-pad"
                    value={waitMinutesText}
                    onChangeText={setWaitMinutesText}
                    editable={(stage.kind === 'validated' || crossDeviceEdit) && listingIsLpInEdit}
                    testID="hunt-piggy-wait-input"
                  />
                </View>
                <View style={styles.hintField}>
                  <Text style={styles.hintFieldLabel}>{t('huntCreateScreen.totalUses')}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder={t('huntCreateScreen.usesPlaceholder')}
                    placeholderTextColor={colors.textSupplementary}
                    keyboardType="number-pad"
                    value={usesText}
                    onChangeText={setUsesText}
                    editable={(stage.kind === 'validated' || crossDeviceEdit) && listingIsLpInEdit}
                    testID="hunt-piggy-uses-input"
                  />
                </View>
              </View>
              <Text style={styles.helper}>{t('huntCreateScreen.cooldownUsesHelper')}</Text>

              <StepNavRow
                onBack={() => setCurrentStep(1)}
                onNext={() => setCurrentStep(3)}
                styles={styles}
                colors={colors}
              />
            </>
          )}

          {currentStep === 6 && (
            <>
              <StepHeader
                n={6}
                title={t('huntCreateScreen.step6Title')}
                subtitle={t('huntCreateScreen.step6Subtitle')}
                status={stage.kind === 'wrote-nfc' ? 'done' : 'active'}
                styles={styles}
                colors={colors}
              />
              <NfcSupportedTagsCard colors={colors} styles={styles} />
              {/* Gate: NFC writes the kind 37516 listing's nostr:naddr,
                which only exists once the Piggy has been published. In
                a fresh-hide flow that means step 5 (Publish) has to
                run first. In edit mode the listing was already
                published, so stage.kind === 'validated' is fine too. */}
              {!nfcReady ? (
                <Text style={styles.helper}>{t('huntCreateScreen.publishFirst')}</Text>
              ) : null}
              {/* What we'll write, plain-text, so the hider can see the
                three records that go on the tag before the camera /
                NFC interaction starts (Ben's request). */}
              {nfcReady && pubkey ? (
                <View style={styles.payloadPreview}>
                  <Text style={styles.payloadPreviewLabel}>
                    {t('huntCreateScreen.tagWillCarry')}
                  </Text>
                  {/* Public hides emit three records (LP deep link +
                      Nostr naddr + LNURL bearer); private hides emit
                      only the LNURL because the cache isn't on relays
                      and the LP deep-link would route to a missing
                      kind 37516. The runtime matches via
                      writeHuntTagToTag (public) vs writeLnurlToTag
                      (private) below. */}
                  {isPublic ? (
                    <>
                      <Text style={styles.payloadPreviewLine} numberOfLines={1}>
                        • {process.env.EXPO_PUBLIC_HUNT_TAG_BASE_URL ?? 'lightningpiggy://hunt/'}
                        {ensurePiggyId().slice(0, 16)}…
                      </Text>
                      <Text style={styles.payloadPreviewLine} numberOfLines={1}>
                        • nostr:naddr1… ({GC_LISTING_KIND}:{pubkey.slice(0, 8)}…:
                        {ensurePiggyId().slice(0, 12)}…)
                      </Text>
                    </>
                  ) : null}
                  {lnurl.trim() ? (
                    <Text style={styles.payloadPreviewLine} numberOfLines={1}>
                      • lightning:{lnurl.trim().slice(0, 12).toUpperCase()}…
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {/* Lock toggle — default ON. When on, the Android write
                  path also burns a random PWD/PACK into the tag so a
                  passer-by can't repoint it. iOS ignores this (no
                  CoreNFC lock API in the lib today). The toggle stays
                  visible on iOS too so the hider knows the chip is
                  going out unlocked. Issue #567. */}
              {nfcReady ? (
                <TouchableOpacity
                  style={styles.lockToggleRow}
                  onPress={() => setLockTag((v) => !v)}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: lockTag }}
                  accessibilityLabel={
                    lockTag ? t('huntCreateScreen.lockTagOn') : t('huntCreateScreen.lockTagOff')
                  }
                  testID="hunt-write-lock-toggle"
                >
                  <View style={styles.lockToggleMain}>
                    <Text style={styles.lockToggleTitle}>{t('huntCreateScreen.lockTheTag')}</Text>
                    <Text style={styles.lockToggleHelper}>
                      {Platform.OS !== 'android'
                        ? t('huntCreateScreen.lockHelperIos')
                        : lockTag
                          ? t('huntCreateScreen.lockHelperOn')
                          : t('huntCreateScreen.lockHelperOff')}
                    </Text>
                  </View>
                  <View style={[styles.lockToggleSwitch, lockTag && styles.lockToggleSwitchOn]}>
                    <View style={[styles.lockToggleKnob, lockTag && styles.lockToggleKnobOn]} />
                  </View>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (!nfcReady || !canWriteNfcTag) && styles.primaryButtonDisabled,
                ]}
                onPress={handleOpenNfcSheet}
                // A no-prize public cache can write the 2-record hunt
                // payload with no LNURL, so `canWriteNfcTag` enables the
                // button via `isPublic && pubkey` (#954/#955). A private
                // listing-only edit (no LNURL, not public) still leaves
                // the affordance disabled so the user knows to paste an
                // LNURL on step 2 first.
                disabled={!nfcReady || !canWriteNfcTag}
                testID="hunt-write-nfc-button"
              >
                <Nfc size={18} color={colors.white} strokeWidth={2.5} />
                <Text style={styles.primaryButtonText}>
                  {stage.kind === 'wrote-nfc'
                    ? t('huntCreateScreen.writeAnotherTag')
                    : t('huntCreateScreen.writeToNfcTag')}
                </Text>
              </TouchableOpacity>
              {nfcReady && !canWriteNfcTag ? (
                <Text style={styles.helper}>{t('huntCreateScreen.noLnurlYetHelper')}</Text>
              ) : null}
              {/* Post-write PIN row — visible whenever we have lock
                  secrets in hand, either fresh from this session's
                  write or rehydrated from the saved HiddenPiggy in
                  edit mode. Dot-masked until the hider taps Reveal.
                  Issue #567. */}
              {lastWrittenLock ? (
                <View style={styles.pinCard} testID="hunt-write-pin-card">
                  <View style={styles.pinHeader}>
                    <Lock size={14} color={colors.brandPink} strokeWidth={2.5} />
                    <Text style={styles.pinHeaderText}>
                      {t('huntCreateScreen.tagLockedYourPin')}
                    </Text>
                  </View>
                  <Text style={styles.pinHelper}>{t('huntCreateScreen.pinHelper')}</Text>
                  <TouchableOpacity
                    style={styles.pinValueRow}
                    onPress={() => setPinRevealed((v) => !v)}
                    accessibilityLabel={
                      pinRevealed ? t('huntCreateScreen.hidePin') : t('huntCreateScreen.revealPin')
                    }
                    testID="hunt-write-pin-reveal"
                  >
                    <Text style={styles.pinValueText}>
                      {pinRevealed ? lastWrittenLock.pin : '••••••••'}
                    </Text>
                    {pinRevealed ? (
                      <EyeOff size={18} color={colors.textSupplementary} strokeWidth={2} />
                    ) : (
                      <Eye size={18} color={colors.textSupplementary} strokeWidth={2} />
                    )}
                  </TouchableOpacity>
                  <View style={styles.pinActionsRow}>
                    <TouchableOpacity
                      style={styles.pinActionSecondary}
                      onPress={async () => {
                        await Clipboard.setStringAsync(lastWrittenLock.pin);
                        Toast.show({ type: 'success', text1: t('huntCreateScreen.pinCopied') });
                      }}
                      accessibilityLabel={t('huntCreateScreen.copyPin')}
                      testID="hunt-write-pin-copy"
                    >
                      <Copy size={16} color={colors.brandPink} strokeWidth={2.5} />
                      <Text style={styles.pinActionSecondaryText}>
                        {t('huntCreateScreen.copy')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.pinActionSecondary}
                      onPress={handleOpenUnlockSheet}
                      accessibilityLabel={t('huntCreateScreen.unlockTag')}
                      testID="hunt-write-pin-unlock"
                    >
                      <Unlock size={16} color={colors.brandPink} strokeWidth={2.5} />
                      <Text style={styles.pinActionSecondaryText}>
                        {t('huntCreateScreen.unlockTag')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
              <StepNavRow
                onBack={() => setCurrentStep(5)}
                onNext={handleDone}
                nextLabel={t('huntCreateScreen.done')}
                nextIcon={Check}
                styles={styles}
                colors={colors}
              />
            </>
          )}

          {currentStep === 3 && (
            <>
              <StepHeader
                n={3}
                title={t('huntCreateScreen.step3Title')}
                subtitle={t('huntCreateScreen.step3Subtitle')}
                status={pin ? 'done' : 'active'}
                styles={styles}
                colors={colors}
              />
              {pin ? (
                <>
                  <View style={styles.pinMapPreview}>
                    <LibreMiniMap
                      lat={pin.lat}
                      lon={pin.lon}
                      userLat={livePos?.lat ?? null}
                      userLon={livePos?.lon ?? null}
                      userAccuracyMetres={livePos?.accuracy ?? null}
                      merchants={[]}
                      caches={[]}
                      events={[]}
                      pinMarker={{ lat: pin.lat, lon: pin.lon, isLpPiggy: listingIsLpInEdit }}
                      onTapMap={() => setLocationPickerVisible(true)}
                    />
                  </View>
                  <View style={styles.pinRow}>
                    <MapPin size={20} color={colors.brandPink} strokeWidth={2} />
                    <View style={styles.pinTextWrapper}>
                      <Text style={styles.pinTitle}>
                        {pin.lat.toFixed(5)}, {pin.lon.toFixed(5)}
                      </Text>
                      <Text style={styles.pinSub}>
                        {t('huntCreateScreen.geohashLabel', { geohash: pin.geohash })}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.pinClearButton}
                      onPress={handleClearPin}
                      testID="hunt-piggy-clear-pin-button"
                      accessibilityLabel={t('huntCreateScreen.clearPin')}
                    >
                      <X size={16} color={colors.white} strokeWidth={2.5} />
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity
                    style={styles.pinButton}
                    onPress={() => setLocationPickerVisible(true)}
                    testID="hunt-piggy-adjust-pin-button"
                  >
                    <MapPin size={18} color={colors.brandPink} strokeWidth={2} />
                    <Text style={styles.pinButtonText}>{t('huntCreateScreen.adjustOnMap')}</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <View style={styles.pinButtonsRow}>
                  <TouchableOpacity
                    style={[styles.pinButton, styles.pinButtonHalf]}
                    onPress={handlePinHere}
                    disabled={pinning}
                    testID="hunt-piggy-pin-here-button"
                  >
                    {pinning ? (
                      <BrandedSpinner />
                    ) : (
                      <>
                        <MapPin size={18} color={colors.brandPink} strokeWidth={2} />
                        <Text style={styles.pinButtonText}>
                          {t('huntCreateScreen.useMyLocation')}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.pinButton, styles.pinButtonHalf]}
                    onPress={() => setLocationPickerVisible(true)}
                    testID="hunt-piggy-pick-on-map-button"
                  >
                    <MapPin size={18} color={colors.brandPink} strokeWidth={2} />
                    <Text style={styles.pinButtonText}>{t('huntCreateScreen.pickOnMap')}</Text>
                  </TouchableOpacity>
                </View>
              )}
              <Text style={styles.helper}>{t('huntCreateScreen.locationHelper')}</Text>
              <StepNavRow
                onBack={() => setCurrentStep(2)}
                onNext={() => setCurrentStep(4)}
                styles={styles}
                colors={colors}
              />
            </>
          )}

          {currentStep === 4 && (
            <>
              <StepHeader
                n={4}
                title={t('huntCreateScreen.step4Title')}
                subtitle={t('huntCreateScreen.step4Subtitle')}
                status="active"
                styles={styles}
                colors={colors}
              />

              <Text style={styles.subSectionLabel}>{t('huntCreateScreen.photoOptional')}</Text>
              {hintPhotoUrl ? (
                <View style={styles.hintPreviewWrapper}>
                  <Image
                    source={{ uri: hintPhotoUrl }}
                    style={styles.hintPreview}
                    resizeMode="cover"
                  />
                  <TouchableOpacity
                    style={styles.hintRemoveButton}
                    onPress={handleRemoveHintPhoto}
                    accessibilityLabel={t('huntCreateScreen.removePhoto')}
                    testID="hunt-piggy-remove-hint-button"
                  >
                    <X size={16} color={colors.white} strokeWidth={2.5} />
                  </TouchableOpacity>
                </View>
              ) : uploadingHint ? (
                <View style={styles.hintUploadingWrapper}>
                  <BrandedSpinner />
                  <Text style={styles.helper}>{t('huntCreateScreen.strippingExif')}</Text>
                </View>
              ) : (
                <View style={styles.hintButtonsRow}>
                  <TouchableOpacity
                    style={styles.hintButton}
                    onPress={handleTakeHintPhoto}
                    testID="hunt-piggy-take-hint-button"
                  >
                    <Camera size={18} color={colors.brandPink} strokeWidth={2} />
                    <Text style={styles.hintButtonText}>{t('huntCreateScreen.takePhoto')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.hintButton}
                    onPress={handlePickHintFromLibrary}
                    testID="hunt-piggy-pick-hint-button"
                  >
                    <ImagePlus size={18} color={colors.brandPink} strokeWidth={2} />
                    <Text style={styles.hintButtonText}>{t('huntCreateScreen.fromLibrary')}</Text>
                  </TouchableOpacity>
                </View>
              )}
              <Text style={styles.helper}>{t('huntCreateScreen.exifHelper')}</Text>

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.titleLabel')}
              </Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  placeholder={t('huntCreateScreen.titlePlaceholder')}
                  placeholderTextColor={colors.textSupplementary}
                  value={cacheName}
                  onChangeText={setCacheName}
                  testID="hunt-piggy-name-input"
                />
              </View>

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.descriptionLabel')}
              </Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={[styles.input, styles.inputMultiline]}
                  placeholder={t('huntCreateScreen.descriptionPlaceholder')}
                  placeholderTextColor={colors.textSupplementary}
                  value={cacheDescription}
                  onChangeText={setCacheDescription}
                  multiline
                  testID="hunt-piggy-description-input"
                />
              </View>

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.hintLabel')}
              </Text>
              <Text style={styles.helper}>{t('huntCreateScreen.hintHelper')}</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={[styles.input, styles.inputMultiline]}
                  placeholder={t('huntCreateScreen.hintPlaceholder')}
                  placeholderTextColor={colors.textSupplementary}
                  value={cacheHint}
                  onChangeText={setCacheHint}
                  multiline
                  accessibilityLabel={t('huntCreateScreen.cacheHintAccessibility')}
                  testID="hunt-create-hint-input"
                />
              </View>

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.difficultyLabel', { level: difficulty })}
              </Text>
              <Text style={styles.helper}>{t('huntCreateScreen.difficultyHelper')}</Text>
              <LevelPicker
                value={difficulty}
                onChange={(v) => setDifficulty(v as 1 | 2 | 3 | 4 | 5)}
                styles={styles}
              />

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.terrainLabel', { level: terrain })}
              </Text>
              <Text style={styles.helper}>{t('huntCreateScreen.terrainHelper')}</Text>
              <LevelPicker
                value={terrain}
                onChange={(v) => setTerrain(v as 1 | 2 | 3 | 4 | 5)}
                styles={styles}
              />

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.sizeLabel')}
              </Text>
              <Text style={styles.helper}>{t('huntCreateScreen.sizeHelper')}</Text>
              <OptionPicker
                value={cacheSize}
                options={[
                  { v: 'micro', label: t('huntCreateScreen.sizeMicro') },
                  { v: 'small', label: t('huntCreateScreen.sizeSmall') },
                  { v: 'regular', label: t('huntCreateScreen.sizeRegular') },
                  { v: 'large', label: t('huntCreateScreen.sizeLarge') },
                  { v: 'other', label: t('huntCreateScreen.sizeOther') },
                ]}
                onChange={(v) =>
                  setCacheSize(v as 'micro' | 'small' | 'regular' | 'large' | 'other')
                }
                styles={styles}
              />

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.typeLabel')}
              </Text>
              <Text style={styles.helper}>{t('huntCreateScreen.typeHelper')}</Text>
              <OptionPicker
                value={cacheType}
                options={[
                  { v: 'traditional', label: t('huntCreateScreen.typeTraditional') },
                  { v: 'multi', label: t('huntCreateScreen.typeMulti') },
                  { v: 'mystery', label: t('huntCreateScreen.typeMystery') },
                  { v: 'virtual', label: t('huntCreateScreen.typeVirtual') },
                ]}
                onChange={(v) => setCacheType(v as 'traditional' | 'multi' | 'mystery' | 'virtual')}
                styles={styles}
              />

              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.expiresAfterLabel')}
              </Text>
              <Text style={styles.helper}>{t('huntCreateScreen.expiresAfterHelper')}</Text>
              <OptionPicker
                value={expiryDays}
                options={[
                  { v: '30', label: t('huntCreateScreen.expiry30days') },
                  { v: '90', label: t('huntCreateScreen.expiry90days') },
                  { v: '180', label: t('huntCreateScreen.expiry6months') },
                  { v: '365', label: t('huntCreateScreen.expiry1year') },
                  { v: 'never', label: t('huntCreateScreen.expiryNever') },
                ]}
                onChange={(v) => setExpiryDays(v as '30' | '90' | '180' | '365' | 'never')}
                styles={styles}
              />

              <StepNavRow
                onBack={() => setCurrentStep(3)}
                onNext={() => setCurrentStep(5)}
                styles={styles}
                colors={colors}
              />
            </>
          )}

          {currentStep === 5 && (
            <>
              <StepHeader
                n={5}
                title={t('huntCreateScreen.step5Title')}
                subtitle={t('huntCreateScreen.step5Subtitle')}
                status={stage.kind === 'saved' || stage.kind === 'wrote-nfc' ? 'done' : 'active'}
                styles={styles}
                colors={colors}
              />
              <Text style={[styles.subSectionLabel, styles.sectionGap]}>
                {t('huntCreateScreen.discoverability')}
              </Text>
              <TouchableOpacity
                style={styles.publicRow}
                onPress={() =>
                  (stage.kind === 'validated' || stage.kind === 'noPrize') && setIsPublic(!isPublic)
                }
                accessibilityRole="switch"
                accessibilityState={{ checked: isPublic }}
                testID="hunt-piggy-public-toggle"
                disabled={stage.kind !== 'validated' && stage.kind !== 'noPrize'}
              >
                <Globe size={20} color={colors.brandPink} strokeWidth={2} />
                <View style={styles.publicTextWrapper}>
                  <Text style={styles.publicTitle}>{t('huntCreateScreen.makePiggyPublic')}</Text>
                  <Text style={styles.publicSub}>
                    {isPublic
                      ? t('huntCreateScreen.publicSubOn')
                      : t('huntCreateScreen.publicSubOff')}
                  </Text>
                </View>
                <View style={[styles.toggleTrack, isPublic && styles.toggleTrackOn]}>
                  <View style={[styles.toggleThumb, isPublic && styles.toggleThumbOn]} />
                </View>
              </TouchableOpacity>

              {/* The bearer-token warning is only accurate when the listing
                  actually carries an LNURL — on the no-prize publish path
                  there's no reward URL to leak, so hide it (Copilot #955). */}
              {listingIsLpInEdit ? (
                <Text style={styles.warning}>{t('huntCreateScreen.bearerTokenWarning')}</Text>
              ) : null}

              {stage.kind === 'idle' || stage.kind === 'validating' ? (
                <Text style={styles.helper}>{t('huntCreateScreen.addPrizeOnStep2')}</Text>
              ) : null}
              {/* Publish / Save is the step's primary action — own
                button above the nav row so it reads as the *thing
                that publishes*, not a navigation step. Once the
                Piggy is saved the button flips to a green
                "Published" confirmation strip; the StepNavRow's
                Next then becomes the way forward to the NFC step. */}
              {stage.kind === 'saved' || stage.kind === 'wrote-nfc' ? (
                <View style={styles.publishedStrip} testID="hunt-piggy-published-strip">
                  <Check size={18} color={colors.green} strokeWidth={2.5} />
                  <Text style={styles.publishedText}>
                    {isPublic
                      ? t('huntCreateScreen.publishedToRelays')
                      : t('huntCreateScreen.savedLocally')}
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    // Disabled when: still validating, no signer hydrated,
                    // or stage is idle WITHOUT the cross-device-edit
                    // override (which allows metadata-only saves).
                    (stage.kind === 'validating' ||
                      !pubkey ||
                      (stage.kind === 'idle' && !crossDeviceEdit)) &&
                      styles.primaryButtonDisabled,
                  ]}
                  onPress={handleSave}
                  // Defensive — block tap while pubkey hasn't hydrated.
                  // Without this guard a tap mid-cold-start can fire
                  // SecureStore lookups with an empty per-account
                  // suffix and crash with "Invalid key" (#554-adjacent).
                  disabled={
                    stage.kind === 'validating' ||
                    !pubkey ||
                    (stage.kind === 'idle' && !crossDeviceEdit)
                  }
                  testID="hunt-piggy-publish-button"
                  accessibilityLabel={
                    isPublic
                      ? t('huntCreateScreen.publishPiggyAccessibility')
                      : t('huntCreateScreen.savePiggyAccessibility')
                  }
                >
                  {isPublic ? (
                    <Globe size={18} color={colors.white} strokeWidth={2.5} />
                  ) : (
                    <PiggyBank size={18} color={colors.white} strokeWidth={2.5} />
                  )}
                  <Text style={styles.primaryButtonText}>
                    {isPublic ? t('huntCreateScreen.publish') : t('huntCreateScreen.save')}
                  </Text>
                </TouchableOpacity>
              )}
              <StepNavRow
                onBack={() => setCurrentStep(4)}
                // Next only moves forward — it doesn't carry the publish
                // action any more. Gated on stage.kind so the user
                // can't skip publish for a fresh hide; in edit mode the
                // listing is already on relays from the prior session,
                // so a validated LNURL is enough to advance and rewrite
                // the NFC tag (no need to re-publish just to reach
                // step 6).
                onNext={async () => {
                  // In edit mode with a still-validated stage the user
                  // may have changed fields in steps 1-5 (LNURL, name,
                  // expiry, …) but not yet tapped the Publish button.
                  // Auto-save before advancing so those edits actually
                  // hit storage / relays — otherwise the NFC write on
                  // step 6 emits the new payload while the persisted
                  // record stays stale (Copilot #572 r4 catch).
                  // `handleSave` is the same handler the Publish
                  // button calls; it bails out cleanly on its own if
                  // the stage isn't validated.
                  if (
                    isEditMode &&
                    (stage.kind === 'validated' || (crossDeviceEdit && stage.kind === 'idle'))
                  ) {
                    await handleSave();
                  }
                  setCurrentStep(6);
                }}
                nextDisabled={
                  isEditMode
                    ? stage.kind !== 'validated' &&
                      stage.kind !== 'saved' &&
                      stage.kind !== 'wrote-nfc'
                    : stage.kind !== 'saved' && stage.kind !== 'wrote-nfc'
                }
                styles={styles}
                colors={colors}
              />
            </>
          )}
        </ScrollView>

        {/* Step 3 — NFC-write bottom sheet. Owns the write + lock flow and
          its own progress / error UI; advances the stage on success. */}
        <NfcWriteSheet
          visible={nfcSheetVisible}
          onClose={() => setNfcSheetVisible(false)}
          mode="piglet"
          lockTag={lockTag}
          existingLock={
            lastWrittenLock
              ? { pwdHex: lastWrittenLock.pwdHex, packHex: lastWrittenLock.packHex }
              : undefined
          }
          lnurl={lnurl.trim()}
          huntPayload={(() => {
            // Multi-record payload (#73). Only useful when we have the
            // hider's pubkey (logged-in user) AND the public toggle is
            // on — a private Piggy has no kind 37516 listing for the
            // nostr:naddr to reference, so we fall back to the legacy
            // single-record LNURL write via `lnurl` above.
            if (!pubkey || !isPublic) return undefined;
            const piggyId = ensurePiggyId();
            const naddr = nip19.naddrEncode({
              kind: GC_LISTING_KIND,
              pubkey,
              identifier: piggyId,
            });
            return {
              coord: `${GC_LISTING_KIND}:${pubkey}:${piggyId}`,
              naddr,
              lnurl: lnurl.trim() || undefined,
            };
          })()}
          onWritten={handleNfcWritten}
        />

        {/* Reversible-lock unlock sheet — opens from the PIN card's
          "Unlock tag" button above. On success, the sheet plays its
          own "Tag unlocked" state until the hider dismisses; only
          then do we clear `lastWrittenLock` and hide the wizard's PIN
          card. Pre-fix the clear ran inside `onUnlocked` and
          immediately unmounted the sheet, hiding the success state
          (Copilot #572 review). Issue #567. */}
        {lastWrittenLock ? (
          <NfcUnlockSheet
            visible={unlockSheetOpen}
            tagUid={lastWrittenLock.tagUid}
            pwdHex={lastWrittenLock.pwdHex}
            packHex={lastWrittenLock.packHex}
            onUnlocked={handleUnlocked}
            onClose={handleUnlockSheetClose}
          />
        ) : null}

        {/* Step 2 — QR scanner for the LNURL input. Full-screen modal
          (`Modal` from react-native, no extra dep) so the camera has
          unambiguous focus; closes on first scan via handleBarCodeScanned
          or on the X button. */}
        <Modal
          visible={scannerOpen}
          animationType="slide"
          onRequestClose={() => setScannerOpen(false)}
          statusBarTranslucent
          navigationBarTranslucent
        >
          <View style={styles.scannerRoot}>
            {!cameraPermission?.granted ? (
              <View style={styles.scannerPermission}>
                <Text style={styles.scannerPermissionText}>
                  {t('huntCreateScreen.cameraAccessNeeded')}
                </Text>
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={requestCameraPermission}
                  testID="hunt-piggy-scan-grant"
                >
                  <Text style={styles.primaryButtonText}>
                    {t('huntCreateScreen.grantPermission')}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <CameraView
                style={styles.scannerCamera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={handleBarCodeScanned}
              />
            )}
            <View style={styles.scannerHintBar}>
              <Text style={styles.scannerHint}>{t('huntCreateScreen.pointAtLnurlQr')}</Text>
            </View>
            <TouchableOpacity
              style={styles.scannerCloseButton}
              onPress={() => setScannerOpen(false)}
              accessibilityLabel={t('huntCreateScreen.closeScanner')}
              testID="hunt-piggy-scan-close"
            >
              <X size={22} color={colors.white} strokeWidth={2.5} />
            </TouchableOpacity>
          </View>
        </Modal>

        {/* Step 4 — interactive map location picker. */}
        <LocationPickerSheet
          visible={locationPickerVisible}
          onClose={() => setLocationPickerVisible(false)}
          initialLat={pin?.lat ?? null}
          initialLon={pin?.lon ?? null}
          onConfirm={(lat, lon) => setPin({ lat, lon, geohash: encodeGeohash(lat, lon, 9) })}
        />
      </View>
    </KeyboardAvoidingView>
  );
};

export default HuntCreateScreen;
