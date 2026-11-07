// CRITICAL: Polyfills must be imported FIRST, before any other imports
import './src/polyfills';

import React, { useEffect, useState } from 'react';
import { AppState, InteractionManager, Linking, StyleSheet } from 'react-native';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { WalletProvider, useWalletLive } from './src/contexts/WalletContext';
import { NostrProvider } from './src/contexts/NostrContext';
import { TrustGraphProvider } from './src/contexts/TrustGraphContext';
import { GroupsProvider } from './src/contexts/GroupsContext';
import { MarmotBridge } from './src/contexts/MarmotBridge';
import { WatcherPushBridge } from './src/contexts/WatcherPushBridge';
import { watcherCategoryOf, watcherTapData } from './src/services/watcherPushReceive';
import { LiveLocationProvider } from './src/contexts/LiveLocationContext';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { LocaleProvider } from './src/contexts/LocaleContext';
import { SendingAnimationProvider } from './src/contexts/SendingAnimationContext';
import { UserLocationProvider } from './src/contexts/UserLocationContext';
import AppNavigator, {
  navigateToHuntPiggyDetail,
  navigateToContactProfile,
  navigateToUnsupportedEntity,
  navigateToSend,
  navigateFromNotification,
  dismissNotificationsForFocusedRoute,
} from './src/navigation/AppNavigator';
import { openLnurlWithdrawSheet, LnurlWithdrawHost } from './src/components/LnurlWithdrawSheet';
import { fetchProfile, decodeProfileReference } from './src/services/nostrService';
import {
  isProfileReferenceUri,
  profileToContactBody,
  pubkeyToContactBodyStub,
} from './src/utils/nostrProfileLink';
import { confirmLinkAction } from './src/utils/confirmLinkAction';
import { whenLinkActionSheetReady } from './src/utils/linkActionSheet';
import { resolveLnurlDirection } from './src/services/lnurlService';
import {
  ensureNotificationsInitialised,
  setNotificationsForeground,
  markHistoryEntryRead,
  isRemotePush,
} from './src/services/notificationService';
import { registerBackgroundSync } from './src/services/backgroundTask';
import { setSubmarineRefundHandler } from './src/services/swapRecoveryService';
import { getAppFormatLocale } from './src/utils/appFormatLocale';
import { recoverSubmarineRefund } from './src/utils/submarineRefund';
import { syncBackgroundDmWatchFromPreference } from './src/services/backgroundDmService';
import { kickPlacesHydration } from './src/services/btcMapService';
import PaymentNotifier from './src/components/PaymentNotifier';
import * as nip19 from 'nostr-tools/nip19';
import { wasRecentlyRead, initNfc } from './src/services/nfcService';
import PaymentProgressOverlay from './src/components/PaymentProgressOverlay';
import { isStaleReceipt } from './src/utils/incomingReceipts';
import BootSplash from './src/components/BootSplash';
import { LinkActionSheetHost } from './src/components/LinkActionSheet';
import { BrandedAlertHost } from './src/components/BrandedAlert';
import { BrandedToast, Toast } from './src/components/BrandedToast';
import OfflineBanner from './src/components/OfflineBanner';
import { isLiveShareStopResponse } from './src/services/liveLocationNotification';

// Renders the global incoming-payment celebration on top of the nav
// stack. Lives inside the WalletProvider so it can subscribe to the
// context's incoming-payment event bus, and above any screen so the
// confetti pops no matter where the user is when a payment lands.
function GlobalIncomingPaymentOverlay() {
  const { lastIncomingPayment, clearLastIncomingPayment } = useWalletLive();
  // A catch-up receipt (settled well before we noticed it, e.g. found on app
  // open) gets a quiet notification instead of a celebration.
  const celebrate =
    !!lastIncomingPayment && !isStaleReceipt(lastIncomingPayment.settledAt, lastIncomingPayment.at);
  // Key on the event timestamp so a second payment arriving while the
  // overlay is still visible remounts the component and re-arms the
  // confetti animation. Without this, a second `success` in a row
  // wouldn't retrigger the burst (state stays 'success', no transition).
  return (
    <PaymentProgressOverlay
      key={lastIncomingPayment?.at ?? 'idle'}
      state={celebrate ? 'success' : 'hidden'}
      direction="receive"
      amountSats={lastIncomingPayment?.amountSats}
      // Forwarded so the overlay can render an on-chain-specific
      // subtitle hint (mempool / unconfirmed) — see #134.
      receiveSource={lastIncomingPayment?.source}
      onDismiss={clearLastIncomingPayment}
    />
  );
}

// StatusBar needs to live inside ThemeProvider so its style flips with the
// active scheme; splitting it out keeps the provider tree readable.
function ThemedStatusBar() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

export default function App() {
  // Boot splash — keeps the pig on screen from JS-mount for a minimum
  // 600 ms so the user never sees the plain-pink native-splash-to-JS
  // handoff. 600 ms is well under the observed cold-launch time on
  // Pixel/cellular (55+ s) but long enough that the splash doesn't
  // feel like a flash. Home renders behind the splash during this
  // window; when we fade the splash out, Home is usually ready.
  const [bootDone, setBootDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setBootDone(true), 600);
    return () => clearTimeout(t);
  }, []);

  // Pre-warm NfcManager.start() at app mount so the first NfcReadSheet
  // / NfcWriteSheet open can call requestTechnology immediately
  // (reader-mode active within ms) instead of waiting on the native
  // bridge. Without this warm-up there's a ~150–300 ms window after
  // tapping "Try prize" where reader-mode hasn't activated yet — fast
  // hiders bring the tag to the phone in that window and the OS
  // dispatches a "Open with…" chooser instead of routing through our
  // in-app reader. Fire-and-forget; failure is non-fatal (each sheet
  // re-tries via `ensureNfcStarted` on its own).
  useEffect(() => {
    void initNfc();
  }, []);

  // Hydrate the BTC-Map merchant cache AFTER first paint, not at
  // btcMapService module-import time (audit HIGH 1). The hydration does a
  // synchronous `JSON.parse` of a 100s-of-KB cache file; firing it at
  // import dropped it onto the cold-start critical path before the first
  // frame. `runAfterInteractions` defers it past the initial render +
  // navigation animation so the Explore hub's first `peekCachedPlacesSync`
  // still resolves quickly without blocking boot. Idempotent + memoised.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      void kickPlacesHydration();
    });
    return () => task.cancel();
  }, []);

  // OS notifications (#279): create the Android channels up-front, track
  // foreground state for the suppress-when-viewing-this-thread gate, and
  // route notification taps to the right screen.
  useEffect(() => {
    // Keep the local notification fixture out of the production startup path.
    const stopDevNotifications = __DEV__
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./src/services/devMessageNotification').registerDevMessageNotifications()
      : undefined;
    void ensureNotificationsInitialised();
    // Wallets requests permission after sign-in when resolving notification defaults.
    // Register the periodic background detect-and-ping (#279). Idempotent;
    // OS schedules it (~15 min floor on Android, usage-based on iOS).
    void registerBackgroundSync();
    // Re-arm the Amethyst-style realtime background DM watch if the user
    // enabled it last session (#279 realtime upgrade). Android-only; no-op
    // when the preference is OFF or on iOS.
    void syncBackgroundDmWatchFromPreference();

    // Wire the submarine-swap refund recovery: the recovery pass detects a
    // failed on-chain→LN swap and calls this to surface the refund prompt
    // (needs BDK + the branded Alert, which the leaf service can't import).
    setSubmarineRefundHandler((swap) => recoverSubmarineRefund(swap, getAppFormatLocale()));

    // Foreground signal — notificationService suppresses a message
    // notification only when the app is active AND the user is on that
    // exact thread.
    setNotificationsForeground(AppState.currentState === 'active');
    // On resume, clear notifications for the screen that was left open
    // (#1142) — staggered ~3 s like other non-urgent resume work (#554).
    let resumeDismissTimer: ReturnType<typeof setTimeout> | null = null;
    const appStateSub = AppState.addEventListener('change', (state) => {
      setNotificationsForeground(state === 'active');
      if (resumeDismissTimer) clearTimeout(resumeDismissTimer);
      resumeDismissTimer =
        state === 'active' ? setTimeout(dismissNotificationsForFocusedRoute, 3000) : null;
    });

    // Tap routing. Retry briefly so a cold-start tap that races the nav
    // tree's mount still lands (mirrors the deep-link tryNav pattern).
    // Each tap supersedes earlier ones still retrying (e.g. waiting for the
    // identity to hydrate), so an older tap can't override a newer one.
    let latestTap = 0;
    const routeFromResponse = (response: Notifications.NotificationResponse | null) => {
      // "Stop sharing" on the live-location notification is handled by the
      // LiveLocationProvider and must not navigate (#1300).
      if (isLiveShareStopResponse(response)) return;
      const raw = response?.notification?.request?.content?.data as
        | (import('./src/services/notificationService').NotificationData & { kind?: string })
        | undefined;
      // The notification watcher's alert routes by its category; a Marmot
      // push alert (iOS, shown by the OS) carries no data: it means "a
      // message arrived" → the Messages list.
      const watcher = watcherCategoryOf(response?.notification?.request);
      const data = watcher
        ? watcherTapData(watcher)
        : response && isRemotePush(response.notification) && !raw?.kind
          ? { kind: 'dm' }
          : raw;
      if (!data) return;
      // The tapped notification's in-app history row is now read (#1143).
      const { historyId, owner } = data as { historyId?: string; owner?: string };
      void markHistoryEntryRead(historyId, owner);
      const tap = ++latestTap;
      const tryNav = (attempt: number) => {
        if (tap !== latestTap) return;
        if (navigateFromNotification(data)) return;
        // ~10 s: also covers identity hydration on a cold start (#1154).
        if (attempt >= 100) {
          if ('groupId' in data && data.groupId) navigateFromNotification({ kind: 'dm', owner });
          return;
        }
        setTimeout(() => tryNav(attempt + 1), 100);
      };
      tryNav(0);
    };
    // Cold start: the app may have been launched by a notification tap.
    // Clear the stored launch response once routed, so a later effect
    // re-run / remount doesn't re-handle the same cold-start tap.
    // A warm tap handled before this lookup resolves is newer than the launch
    // tap, so the launch tap must not supersede it (#1154).
    let warmTapSeen = false;
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!warmTapSeen) routeFromResponse(response);
      void Notifications.clearLastNotificationResponseAsync?.();
    });
    // Warm taps while the app is already running.
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      warmTapSeen = true;
      routeFromResponse(response);
    });

    return () => {
      appStateSub.remove();
      if (resumeDismissTimer) clearTimeout(resumeDismissTimer);
      responseSub.remove();
      stopDevNotifications?.();
    };
  }, []);

  // `lightning:` deep-link listener — the NFC tag-tap / deep-link entry
  // point for BOTH directions of the tag-tap story:
  //   - claim  (money IN):  withdrawRequest → HuntFoundScreen      (#341/#468)
  //   - pay    (money OUT):  bolt11 / Lightning Address / payRequest
  //                          → SendSheet on the Home tab            (#756)
  // LP registers the scheme in app.config.ts so an NFC tag tap or a
  // Linking call wakes the app. Direction is decided by the RESOLVED
  // LNURL `tag` (payRequest vs withdrawRequest), NOT the bech32 prefix —
  // a `lnurl1…` can be either kind, so we resolve once and route on the
  // answer (see `resolveLnurlDirection`). bolt11 invoices and Lightning
  // Addresses are unambiguously pay → straight to SendSheet, which
  // already decodes them in `processInput`. Cold-start case races the
  // navigation tree's mount, so every route retries briefly until
  // `navigationRef.isReady()` (mirrors the withdraw / notification paths).
  useEffect(() => {
    let cancelled = false;
    // Very short in-memory dedupe to absorb the cold-start race where
    // both `getInitialURL()` and `addEventListener('url')` deliver the
    // SAME URL within a few hundred ms of JS init. Tens of seconds
    // would be safer, but persistent dedupe (across JS restarts via
    // AsyncStorage) turned out to over-fire when the user re-scans
    // the same tag in the same hour — stale storage swallowed
    // genuine fresh taps. The "Explore tab takes you to the cached
    // detail" bug was actually a different problem (deep-link
    // navigator didn't seed ExploreHome / Hunt below HuntPiggyDetail,
    // see `navigateToHuntPiggyDetail`); now that's fixed, 2 seconds
    // is plenty to catch the cold-start double-fire without
    // mis-blocking deliberate re-scans.
    const ROUTE_DEDUPE_MS = 2_000;
    let lastRouted: { url: string; at: number } | null = null;
    const route = (raw: string | null | undefined) => {
      if (cancelled || !raw) return;
      const trimmed = raw.trim();
      if (
        lastRouted &&
        lastRouted.url === trimmed &&
        Date.now() - lastRouted.at < ROUTE_DEDUPE_MS
      ) {
        console.log(`[Link] de-duped cold-start double-fire within ${ROUTE_DEDUPE_MS}ms`);
        return;
      }
      lastRouted = { url: trimmed, at: Date.now() };
      // Consent before any network work (#1500). Bare `lnurlw://` / `lnurl://`
      // are exempt here only because they route straight to LnurlWithdrawSheet,
      // whose first stage IS the "Withdraw from <host>" consent — nothing is
      // fetched until that tap, and a second identical prompt would just be
      // friction. Every other external payload confirms first.
      const needsConsent =
        (/^(lightning:|lnurl|bitcoin:|nostr:)/i.test(trimmed) || isProfileReferenceUri(trimmed)) &&
        !/^lnurlw?:\/\//i.test(trimmed);
      if (needsConsent) {
        // On a cold start the launch URL arrives before the consent sheet's
        // host has mounted, so wait for it rather than drop the prompt.
        whenLinkActionSheetReady(() => {
          if (cancelled) return;
          confirmLinkAction(trimmed, () => {
            if (!cancelled) routeFresh(trimmed);
          });
        });
      } else {
        routeFresh(trimmed);
      }
    };
    const routeFresh = (trimmed: string) => {
      // Truncate noisy URIs so the log doesn't blow past logcat's
      // line limit but keep enough head + tail to identify them.
      const peek = trimmed.length > 96 ? trimmed.slice(0, 60) + '…' + trimmed.slice(-20) : trimmed;
      console.log(`[Link] received: ${peek}`);

      // `https://www.lightningpiggy.com/hunt/<coord>` (the canonical
      // form written as record 1 of an NFC tag) OR the legacy custom
      // `lightningpiggy://hunt/<coord>` scheme. Both decode the same
      // way. Coord is `kind:pubkey:d` percent-encoded.
      const lpHuntMatch = trimmed.match(
        /^(?:https?:\/\/(?:www\.)?lightningpiggy\.com\/hunt\/(.+)|lightningpiggy:\/\/hunt\/(.+))$/i,
      );
      if (lpHuntMatch) {
        const captured = lpHuntMatch[1] ?? lpHuntMatch[2];
        let coord: string;
        try {
          coord = decodeURIComponent(captured);
        } catch {
          console.warn(`[Link] hunt-URL coord decode failed: ${captured}`);
          return;
        }
        // Suppress the delayed system NDEF dispatch that fires ~600ms
        // after our in-app NfcReadSheet closes when the tag stays near
        // the antenna. Without this, the user gets yanked out of
        // HuntFoundScreen mid-claim back to HuntPiggyDetail.
        if (wasRecentlyRead(coord)) {
          console.log(`[Link] skipped — coord just read by foreground NFC: ${coord}`);
          return;
        }
        console.log(
          `[Link] → HuntPiggyDetail via ${trimmed.startsWith('https') ? 'https' : 'lightningpiggy://'} coord=${coord}`,
        );
        const tryNav = (attempt: number) => {
          if (navigateToHuntPiggyDetail(coord)) return;
          if (attempt >= 20 || cancelled) return;
          setTimeout(() => tryNav(attempt + 1), 100);
        };
        tryNav(0);
        return;
      }

      // `nostr:npub1…` / `nostr:nprofile1…` — a profile reference, the
      // conference-badge / contact-tap case (#754). Distinct from the
      // Hunt `naddr` branch below and the `lightning:` withdraw branch.
      // We decode the pubkey (+ relay hints for nprofile), fetch the
      // kind-0 metadata off those hints so a stranger on niche relays
      // still resolves, then open the full-page ContactProfile. The
      // fetch is best-effort: if it fails we still navigate with a
      // pubkey-only stub and let ContactProfileScreen retry on the
      // viewer's own relays. Cold-start races the nav tree → retry like
      // the Hunt/withdraw paths.
      if (isProfileReferenceUri(trimmed)) {
        const decoded = decodeProfileReference(trimmed);
        if (!decoded) {
          console.warn(`[Link] nostr: profile ref failed to decode — friendly fallback`);
          const tryFail = (attempt: number) => {
            if (navigateToUnsupportedEntity('this Nostr link', trimmed)) return;
            if (attempt >= 20 || cancelled) return;
            setTimeout(() => tryFail(attempt + 1), 100);
          };
          tryFail(0);
          return;
        }
        const { pubkey, relays: hints } = decoded;
        console.log(`[Link] → ContactProfile pubkey=${pubkey.slice(0, 12)}… hints=${hints.length}`);
        const openWith = (contact: ReturnType<typeof pubkeyToContactBodyStub>) => {
          const tryNav = (attempt: number) => {
            if (navigateToContactProfile(contact)) return;
            if (attempt >= 20 || cancelled) return;
            setTimeout(() => tryNav(attempt + 1), 100);
          };
          tryNav(0);
        };
        // Fetch kind-0 off the EMBEDDED relay hints (nprofile) so a
        // not-yet-followed contact on niche relays resolves — that's the
        // whole point of nprofile over a bare npub. A bare npub carries
        // no hints, so fetchProfile falls back to the app's PROFILE_RELAYS.
        // Race the fetch against a 2.5s budget so a dead relay never
        // strands the user on a blank screen: whichever resolves first
        // navigates, and the pubkey-only stub lets ContactProfileScreen
        // retry the metadata on the viewer's own relays. The screen is
        // reused on a same-pubkey re-nav (its re-sync is pubkey-gated),
        // so we navigate exactly once with the best data we have.
        const stub = pubkeyToContactBodyStub(pubkey);
        let navigated = false;
        const navOnce = (contact: ReturnType<typeof pubkeyToContactBodyStub>) => {
          if (navigated || cancelled) return;
          navigated = true;
          openWith(contact);
        };
        const budget = setTimeout(() => navOnce(stub), 2_500);
        fetchProfile(pubkey, hints)
          .then((profile) => {
            clearTimeout(budget);
            navOnce(profile ? profileToContactBody(profile) : stub);
          })
          .catch(() => {
            clearTimeout(budget);
            navOnce(stub);
          });
        return;
      }

      // `nostr:naddr1...` — record 2 of a Hunt tag, or a manual
      // share from a generic Nostr client. We decode the naddr to
      // recover { kind, pubkey, identifier } and assemble the same
      // `kind:pubkey:d` coord HuntPiggyDetail consumes. Non-Hunt
      // naddrs (other kinds) are ignored — no other screen handles
      // them yet, so silently dropping is better than hijacking.
      const nostrMatch = trimmed.match(/^nostr:(naddr1[0-9a-z]+)$/i);
      if (nostrMatch) {
        try {
          const decoded = nip19.decode(nostrMatch[1]);
          if (decoded.type === 'naddr' && decoded.data) {
            const { kind, pubkey: hex, identifier } = decoded.data;
            const coord = `${kind}:${hex}:${identifier}`;
            console.log(`[Link] → HuntPiggyDetail via nostr:naddr coord=${coord}`);
            const tryNav = (attempt: number) => {
              if (navigateToHuntPiggyDetail(coord)) return;
              if (attempt >= 20 || cancelled) return;
              setTimeout(() => tryNav(attempt + 1), 100);
            };
            tryNav(0);
            return;
          }
          console.warn(`[Link] nostr: URI decoded but not naddr — ignored (type=${decoded.type})`);
        } catch (err) {
          console.warn(`[Link] nostr: naddr decode failed: ${(err as Error)?.message ?? err}`);
          // Fall through to the lightning: path if the naddr is
          // garbage; otherwise the URI is ignored.
        }
      }

      // Standalone LNURL-withdraw tag / deep link — a bare `lnurlw://…` (or
      // `lnurl://…`) URI, i.e. record 1 of a standalone withdraw / gift-card
      // tag, NOT wrapped in `lightning:`. Open the generic withdraw bottom
      // sheet (NOT the Hunt/Piglet full screen — a plain voucher needn't be a
      // geo-cache). #341. Piglet tags are unaffected — their first record is
      // `lightningpiggy://hunt/…`, handled above. Retry while the sheet host
      // mounts on a cold launch.
      if (/^lnurlw:\/\//i.test(trimmed) || /^lnurl:\/\//i.test(trimmed)) {
        const tryOpen = (attempt: number) => {
          if (openLnurlWithdrawSheet(trimmed, undefined, true)) return;
          if (attempt >= 20 || cancelled) return;
          setTimeout(() => tryOpen(attempt + 1), 100);
        };
        tryOpen(0);
        return;
      }

      if (/^(lnurl1|lnurlp:\/\/)/i.test(trimmed)) {
        trimmed = 'lightning:' + trimmed;
      }
      if (!/^(lightning:|bitcoin:)/i.test(trimmed)) {
        console.log(`[Link] ignored: no handler for scheme`);
        return;
      }
      const lnurl = /^bitcoin:/i.test(trimmed)
        ? trimmed
        : trimmed.slice('lightning:'.length).trim();
      if (!lnurl) return;

      // Retry helper for the cold-start race — the nav tree may not be
      // mounted yet when the launch URL arrives. Each route returns a
      // boolean "did it land"; we retry ~2s before giving up.
      const tryNav = (nav: () => boolean) => {
        const attempt = (n: number) => {
          if (nav()) return;
          if (n >= 20 || cancelled) return;
          setTimeout(() => attempt(n + 1), 100);
        };
        attempt(0);
      };

      if (/^bitcoin:/i.test(trimmed)) {
        tryNav(() => navigateToSend(trimmed));
        return;
      }

      // --- Unambiguous PAY payloads → SendSheet (#756) ---------------
      // bolt11 invoices (mainnet/testnet/signet/regtest prefixes) and
      // Lightning Addresses (`user@host`) can only be paid, never
      // claimed, so route them straight to the SendSheet — it decodes
      // the bolt11 (amount/memo; zero-amount → amount prompt) and
      // resolves the Lightning Address (amount prompt) in `processInput`.
      // Pass the raw `lightning:`-prefixed URI; SendSheet strips the
      // prefix itself.
      const isBolt11 = /^ln(bc|tb|ts|bs)/i.test(lnurl);
      const isLightningAddress = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lnurl) && !isBolt11;
      if (isBolt11 || isLightningAddress) {
        console.log(`[Link] → SendSheet (${isBolt11 ? 'bolt11' : 'lnaddress'})`);
        tryNav(() => navigateToSend(trimmed));
        return;
      }

      // --- LNURL forms: resolve ONCE, route on the resolved tag ------
      // `lnurl1…` / `lnurlp://` / `lnurlw://` / `lnurl://` / raw https.
      // The bech32 prefix does NOT tell us pay vs withdraw — only the
      // server's `tag` does (Copilot review #488 / disambiguation trap
      // in #756). So resolve and branch:
      //   withdrawRequest → HuntFoundScreen (claim, no regression to #341)
      //   payRequest      → SendSheet (pay)
      const isLnurlForm =
        /^lnurl1/i.test(lnurl) || /^lnurl(p|w)?:\/\//i.test(lnurl) || /^https:\/\//i.test(lnurl);
      if (!isLnurlForm) {
        // Unknown payload under the lightning: scheme — friendly nudge
        // rather than a silent dead end (Copilot review #488).
        Toast.show({
          type: 'info',
          text1: 'Link not supported',
          text2: "That isn't an invoice, Lightning Address, or LNURL Lightning Piggy can open.",
          visibilityTime: 4500,
        });
        return;
      }
      // LNURL form: resolve ONCE, then route on the resolved direction.
      // Combines #756's pay/withdraw disambiguation with #341's withdraw UX:
      //   withdrawRequest → the generic LnurlWithdrawSheet bottom sheet (#341),
      //                     NOT the full HuntFoundScreen (a standalone voucher
      //                     needn't be a geo-cache Piglet — those arrive as
      //                     `lightningpiggy://`, handled above).
      //   payRequest      → SendSheet (#756).
      void (async () => {
        try {
          const resolved = await resolveLnurlDirection(lnurl);
          if (cancelled) return;
          if (resolved.kind === 'withdraw') {
            console.log(`[Link] → LnurlWithdrawSheet (LNURL withdrawRequest)`);
            // Consent for this exact link was given above (host shown) and the
            // endpoint is already resolved, so skip the sheet's own host step;
            // it still shows host + amount and requires the Withdraw tap.
            tryNav(() => openLnurlWithdrawSheet(lnurl, undefined, false));
          } else {
            // payRequest → SendSheet. Hand it the resolved endpoint URL so
            // SendSheet doesn't have to re-decode the bech32 (and so
            // `lnurlp://` / raw-https forms work even though `processInput`
            // only understands bolt11 + Lightning Address today — see the
            // SendSheet TODO in #757).
            console.log(`[Link] → SendSheet (LNURL payRequest)`);
            tryNav(() => navigateToSend(resolved.url));
          }
        } catch (err) {
          if (cancelled) return;
          // Friendly message — never surface the raw SDK / relay string.
          console.warn(`[Link] LNURL resolve failed: ${(err as Error)?.message ?? err}`);
          Toast.show({
            type: 'info',
            text1: "Couldn't open that link",
            text2: 'The Lightning link could not be resolved. Check your connection and try again.',
            visibilityTime: 4500,
          });
        }
      })();
    };
    Linking.getInitialURL().then(route);
    const sub = Linking.addEventListener('url', (e) => route(e.url));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return (
    <GestureHandlerRootView style={styles.container}>
      {/* SafeAreaProvider feeds `useSafeAreaInsets()` — without it all
          insets silently return 0 and the composer's safe-area padding
          (above the gesture bar) collapses. Needed company to the
          react-native-edge-to-edge plugin so insets propagate end-to-end. */}
      <SafeAreaProvider>
        {/* KeyboardProvider drives react-native-keyboard-controller.
            Paired with react-native-edge-to-edge (plugin in app.config.ts)
            it subscribes to `WindowInsetsCompat.Type.ime()` and exposes
            the IME inset to hooks + components like KeyboardStickyView.
            Without edge-to-edge, Android 15+ silently reports 0 keyboard
            height to every API (see #194 diagnosis). */}
        <KeyboardProvider>
          {/* LocaleProvider mirrors ThemeProvider: a persisted device-wide
              preference (locale override, defaults to 'system') read high
              in the tree so every screen's `useTranslation()` sees it. #137. */}
          <LocaleProvider>
            <ThemeProvider>
              {/* SendingAnimationProvider mirrors ThemeProvider: a persisted
                Appearance preference (bubbles vs lightning) read by the
                payment send overlay. Sits beside the theme so both load
                their AsyncStorage value once, high in the tree. */}
              <SendingAnimationProvider>
                <WalletProvider>
                  <NostrProvider>
                    {/* TrustGraphProvider derives the L1+L2 web-of-trust set
                    from Nostr contacts. Lives inside NostrProvider so it
                    can read `contacts` + `pubkey`, but outside Groups
                    because nothing else depends on it. */}
                    <TrustGraphProvider>
                      {/* GroupsProvider sits inside Nostr so groups can subscribe
                    to multi-recipient gift wraps using the active signer. */}
                      <GroupsProvider>
                        {/* Marmot (MLS) session lifecycle — needs the signer +
                      relays from Nostr; Groups/DM inbox consume its events. */}
                        <MarmotBridge />
                        {/* Notification-watcher push registration (DMs, zaps,
                      mentions, NWC payments) — needs the signer, relays and
                      the NWC wallets. */}
                        <WatcherPushBridge />
                        {/* LiveLocationProvider sits inside Nostr (uses the
                      signer + sendDirectMessage) but outside the
                      navigator so an active share survives screen
                      transitions and pause/resume cycles. */}
                        <LiveLocationProvider>
                          {/* UserLocationProvider: ONE GPS watch subscription
                        shared across every map surface, so all screens
                        see the same live position + accuracy halo and
                        we don't fan out to N concurrent watches. */}
                          <UserLocationProvider>
                            <BottomSheetModalProvider>
                              <ThemedStatusBar />
                              {/* Sits above the navigator so a single banner
                            covers every screen + tab when the device
                            loses connectivity. Slides on/off via the
                            internal `isConnected` check — no layout
                            penalty when online (returns null). See #634. */}
                              <OfflineBanner />
                              <AppNavigator />
                              {/* Global claim sheet for standalone LNURL-withdraw
                            vouchers (gift cards, bounty stickers). Opened by the
                            `lightning:`/`lnurlw:` deep-link/intent-filter path
                            above via `openLnurlWithdrawSheet`. Generic (no Piggy
                            branding) and a bottom sheet, not a full screen —
                            Piglet/geo-cache taps keep HuntFoundScreen via their
                            `lightningpiggy://` record. MUST live inside
                            BottomSheetModalProvider (its BottomSheetModal needs
                            that context) and inside WalletProvider (needs
                            makeInvoice). Replaced the broken passive foreground
                            NFC listener (#341). */}
                              <LnurlWithdrawHost />
                              {/* Consent sheet for deep links / scans / NFC
                            payloads (#1500). Also a BottomSheetModal, so it
                            MUST sit inside BottomSheetModalProvider — outside
                            it Gorhom throws on mount and the app never boots.
                            `LinkActionSheetProvider.test.tsx` pins both the
                            provider requirement and this nesting. */}
                              <LinkActionSheetHost />
                            </BottomSheetModalProvider>
                          </UserLocationProvider>
                        </LiveLocationProvider>
                        {/* BrandedToast: brand-themed wrapper around
                      `react-native-toast-message`. Single mount for the
                      app's toast slot — keeps styling (pink success
                      accent, red error, rounded corners + shadow that
                      mirror BrandedAlert) in one place. ESLint blocks
                      direct imports of the underlying lib elsewhere. */}
                        <BrandedToast />
                        <GlobalIncomingPaymentOverlay />
                        {/* Fires OS notifications for incoming payments / zaps
                        (#279). Lives here (not in WalletContext) to keep that
                        over-cap file from growing — see #703. */}
                        <PaymentNotifier />
                        {/* BrandedAlertHost: portal target for the on-brand
                      BrandedAlert dialog. Sits at the root so any sheet /
                      screen that calls `Alert.alert(...)` (the BrandedAlert
                      drop-in re-export, NOT the system Alert) renders
                      above the rest of the UI without z-index gymnastics. */}
                        <BrandedAlertHost />
                      </GroupsProvider>
                    </TrustGraphProvider>
                  </NostrProvider>
                </WalletProvider>
              </SendingAnimationProvider>
              <BootSplash done={bootDone} />
            </ThemeProvider>
          </LocaleProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
