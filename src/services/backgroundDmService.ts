import { getAppFormatLocale } from '../utils/appFormatLocale';
import { dmThreadId, MARMOT_WELCOME_KIND, protocolForWireKind } from '../utils/dmProtocol';
/**
 * backgroundDmService — Amethyst-style realtime background DM notifications
 * for Android (#279 realtime upgrade).
 *
 * THE GAP THIS CLOSES. The app already surfaces real-content DM notifications
 * the moment a wrap arrives — but ONLY while the React tree is mounted, via
 * the live sub in `src/contexts/nostrLiveDmSub.ts`. Once the app is
 * backgrounded, Doze / App-Standby suspends the JS engine and the relay
 * WebSocket within minutes, so new messages aren't noticed until the user
 * reopens the app (or the ~15-min `expo-background-task` detect-and-ping in
 * `backgroundSyncService.ts` happens to wake — which only fires a GENERIC
 * "you have new messages" ping, never the content).
 *
 * This module is the control + worker layer for a persistent Android
 * FOREGROUND SERVICE that keeps that live subscription alive in the
 * background, exactly like Amethyst — no FCM, no Google Play Services, no
 * remote push server, so it works on GrapheneOS / microG. A foreground
 * service is the only Doze-immune path that doesn't require GMS.
 *
 * SIGNER-AWARE PRIVACY (Signal sealed-sender style).
 *   - nsec (local key): we can decrypt off-screen, so the notification
 *     carries the sender name + a message preview (subject to the user's
 *     lock-screen-content preference, enforced in notificationService).
 *   - Amber / NIP-46 remote: the secret key is NOT on the device, and a
 *     remote signer can't approve a decrypt headlessly — so we post a
 *     CONTENTLESS "New encrypted message" notification. The detail loads
 *     when the user opens the app and the signer is reachable.
 *
 * iOS is OUT OF SCOPE: iOS can't hold a background socket; realtime DM
 * notifications there need APNs + a remote server, which the project
 * explicitly rejects. Every entry point here is guarded on
 * `Platform.OS === 'android'` and no-ops elsewhere.
 *
 * ───────────────────────────────────────────────────────────────────────
 * NATIVE GLUE (the piece that makes this a true background watch).
 * ───────────────────────────────────────────────────────────────────────
 * Keeping the JS engine + WebSocket alive while the app is backgrounded needs
 * a native foreground `Service`. That lives in the local Expo module
 * `modules/background-dm-service`: `BackgroundDmService` (a
 * HeadlessJsTaskService) hosts the `BackgroundDmTask` headless JS task — see
 * `src/services/backgroundDmHeadlessTask.ts` — which calls
 * `runBackgroundDmWatch()` in a headless context, so the subscription survives
 * the app being backgrounded or swiped away. `BackgroundDmModule` is the
 * start/stop bridge this file calls; `BootReceiver` re-arms after a reboot.
 * Permissions are declared in `plugins/withForegroundService.js`; the
 * `<service>`/`<receiver>` in the module's own manifest.
 *
 * When that native module ISN'T present in the build (Expo Go, or a dev client
 * predating the native rebuild), this layer degrades gracefully: it persists
 * the preference, posts/dismisses the chip, and runs the subscription inline
 * for as long as the foreground JS context is alive — already an upgrade over
 * the ~15-min detect-and-ping, just not Doze-immune.
 */
import {
  canWatchBackgroundPayments,
  isBackgroundPaymentWatchRunning,
  startBackgroundPaymentWatch,
  stopBackgroundPaymentWatch,
} from './backgroundPaymentService';
import { captureBackgroundPaymentScope } from './backgroundPaymentScope';
import { Platform } from 'react-native';
import { initialiseBackgroundRelayAccount } from './backgroundRelayAccount';
import { loadIdentities } from './identitiesStore';
import { resolveReadRelays } from './backgroundDmReadRelays';
import { buildNsecDecryptor, loadFollowedPubkeys, storeDecryptedWrap } from './backgroundDmIngest';
import {
  claimWrapNotification,
  isLiveDmSubArmed,
  noteContentlessWrapAlert,
  wasWrapHandled,
} from './dmWrapNotificationDedupe';
import * as nostrService from './nostrService';
import { subscribeInboxDmsForViewer } from './dmLiveSubscription';
import {
  fireMessageNotification,
  hasNotificationPermission,
  showForegroundServiceNotification,
  dismissForegroundServiceNotification,
} from './notificationService';
import * as zapSenderProfileStorage from './zapSenderProfileStorage';
import { partnerFromRumor, textForRumor, type DecodedRumor } from '../utils/nip17Unwrap';
import { dmRowPreview } from '../utils/dmRowPreview';
import { isNip171InboxRumor } from '../contexts/nip171InboxRouting';
import { hasRepliedTo, loadRepliedPartners } from './dmRepliedPartners';
import { loadBackgroundDmEnabled } from './backgroundDmPreference';
import {
  startForegroundService,
  stopForegroundService,
  isBackgroundDmServiceAvailable,
} from '../../modules/background-dm-service';

// NIP-59 randomises a gift wrap's `created_at` up to ~2 days into the PAST,
// so a genuinely-new wrap can arrive with an already-old timestamp. We only
// notify for wraps whose INNER rumor timestamp is at/after the sub-open time
// (minus skew) — the inner kind-14 `created_at` is the real send time, the
// outer wrap time is not. Mirrors `isFreshArrival` in nostrLiveDmSub.ts so
// the relay's on-open backlog replay doesn't flood notifications.
const NOTIFY_SKEW_SEC = 120;

// Bound the kind-1059 backlog the relay re-streams when the sub opens, so
// arming the watch doesn't re-ingest the full wrap history. New wraps still
// arrive live after EOSE. Matches the spirit of COLD_INITIAL_WRAP_LIMIT used
// by the foreground live sub.
const BACKLOG_WRAPS_LIMIT = 50;

// Remote-signer (contentless) watches can't decrypt, so the rumor-timestamp
// freshness gate can't run — every replayed wrap would otherwise become a
// generic notification burst on arm (Copilot review, PR #958). Those wraps
// are gated on EOSE below; this smaller limit additionally bounds any
// stragglers a slow relay replays after the first relay's EOSE.
const CONTENTLESS_BACKLOG_WRAPS_LIMIT = 10;

const HEX64 = /^[0-9a-f]{64}$/;

interface ActiveWatch {
  viewerPubkey: string;
  unsubscribe: () => void;
}

let activeWatch: ActiveWatch | null = null;

// --- Self-re-arm on relay drop ---
// The app-wide SimplePool deliberately does NOT auto-reconnect (flipping
// enableReconnect would change lifecycle behaviour for every subscription in
// the app), so when the wrap subscription closes on every relay this watch
// has gone deaf while the chip still promises otherwise. The watch re-arms
// itself: the subscription's onclose triggers a backoff-scheduled re-arm,
// and a coarse safety interval re-arms periodically as a catch-all.
// Re-arms are silent by construction — re-subscribing over healthy sockets
// reuses the pool's open connections, the freshness gate mutes the backlog
// replay, and the wrap-id claim table prevents duplicate notifications.
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
const SAFETY_REARM_INTERVAL_MS = 15 * 60_000;
// A subscription that lived at least this long before closing counts as
// having been healthy — the next drop retries from the shortest delay. NB
// EOSE is NOT a usable health signal here: nostr-tools marks unreachable
// relays as EOSE'd so waiters don't hang, so a fully-offline arm still
// "EOSEs" (verified live: it pinned the backoff at 5s during an outage).
const HEALTHY_SUB_MIN_LIFETIME_MS = 60_000;

// Bumped on every (re)arm and teardown. onclose closures capture the
// generation at arm time; a stale generation means "this close belongs to a
// subscription we already superseded on purpose" and must not re-arm.
let watchGeneration = 0;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let safetyRearmTimer: ReturnType<typeof setInterval> | null = null;
// See runBackgroundDmWatch: arms run one at a time, and the count tells the
// payment host-reconcile that a DM watch is being (re)built right now.
let dmArmChain: Promise<unknown> = Promise.resolve();
let dmArmsInFlight = 0;
// Watch-session epoch, bumped synchronously by an intentional stop and by an
// identity re-arm. Every queued arm and every host decision captures it up
// front and re-checks it after each await, so work begun for a session that
// has since been stopped or replaced can never subscribe, re-arm, or stop
// anything on its behalf (#1100 review). NB distinct from watchGeneration,
// which each arm bumps only once it actually subscribes.
let watchEpoch = 0;

/** Snapshot the current watch epoch; the returned check is false once superseded. */
export function captureBackgroundDmWatchEpoch(): () => boolean {
  const epoch = watchEpoch;
  return () => epoch === watchEpoch;
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleWatchReconnect(generation: number): void {
  // Stale close (already superseded), intentionally-stopped watch, or a
  // reconnect already pending: no-op.
  if (generation !== watchGeneration || !activeWatch || reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.min(reconnectAttempt, 10),
    RECONNECT_MAX_DELAY_MS,
  );
  reconnectAttempt += 1;
  console.warn(`[BgDmWatch] wrap sub closed — re-arming in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void runBackgroundDmWatch().catch((e) => {
      console.warn('[BgDmWatch] re-arm failed:', e);
    });
  }, delay);
}

/**
 * Resolve a sender's display name from the persisted profile cache, falling
 * back to a relay fetch, then to a shortened npub-ish hex. Best-effort and
 * never throws — a missing name just yields a generic label.
 */
async function resolveSenderName(pubkey: string, readRelays: string[]): Promise<string> {
  const short = `${pubkey.slice(0, 8)}…`;
  try {
    const cached =
      zapSenderProfileStorage.peekSync(pubkey) ?? (await zapSenderProfileStorage.get(pubkey));
    const cachedName = cached?.displayName || cached?.name;
    if (cachedName) return cachedName;
  } catch {
    // fall through to relay fetch
  }
  try {
    const profile = await nostrService.fetchProfile(pubkey, readRelays);
    const name = profile?.displayName || profile?.name;
    if (name) return name;
  } catch {
    // fall through to the short hex
  }
  return short;
}

/**
 * The decrypt + notify side-effect for one inbound wrap, signer-aware.
 *
 * `decryptWrap` is null for remote signers (Amber / NIP-46), in which case we
 * skip decryption entirely and post a contentless "New encrypted message"
 * (Signal sealed-sender style) — we still know a wrap addressed to us
 * arrived, we just can't read it off-screen.
 */
/** How long the contentless path waits for a live sub to decrypt a wrap. A
 * remote signer answers in a second or two; a slower one still gets the
 * contentless alert, which the live sub replaces once it decrypts. */
export const LIVE_SUB_DECRYPT_GRACE_MS = 8_000;
const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function handleWrap(input: {
  ev: nostrService.RawInboxDmEvent;
  viewerPubkey: string;
  readRelays: string[];
  subOpenedAtSec: number;
  decryptWrap: ((wrap: nostrService.RawGiftWrapEvent) => DecodedRumor | null) | null;
  /** True once the subscription's initial backlog replay has settled (EOSE). */
  backlogSettled: () => boolean;
  /** Followed pubkeys for the follow gate; null = cache absent → fail open. */
  followedPubkeys: Set<string> | null;
}): Promise<void> {
  const { ev, viewerPubkey, readRelays, subOpenedAtSec, decryptWrap } = input;
  // This background watch only cares about NIP-17 gift wraps (kind 1059) —
  // the modern DM format. Legacy kind-4 and marketplace kind-16/17 are left
  // to the foreground live sub; mirroring all of them here would duplicate a
  // lot of nostrLiveDmSub for diminishing returns.
  if (ev.kind !== 1059) return;

  // Contentless path: remote signer can't decrypt headlessly. We can't tell
  // who it's from (that's inside the wrap), so the notification is fully
  // generic and the thread id is a sentinel that never matches an actively-
  // viewed thread. Because we can't read the inner rumor timestamp, the
  // freshness gate below can't run — instead stay SILENT until the initial
  // backlog replay settles (EOSE), so arming doesn't burst a generic
  // notification per replayed wrap. The claim keeps the foreground live sub
  // (which can be armed in the same JS context and receive this same wrap)
  // from posting a second notification — see dmWrapNotificationDedupe.
  if (!decryptWrap) {
    if (!input.backlogSettled()) return;
    // The app's live sub runs in this JS context and CAN decrypt (it asks the
    // remote signer): give it a moment. A wrap it decoded is its call — the
    // self-copy of a message we sent, a stranger's wrap or a reaction must
    // not raise a contentless "New encrypted message" with nothing behind it.
    if (isLiveDmSubArmed()) {
      await waitMs(LIVE_SUB_DECRYPT_GRACE_MS);
      if (wasWrapHandled(ev.id)) return;
      // Signed out / switched account meanwhile: not this watch's to alert.
      if (activeWatch?.viewerPubkey !== viewerPubkey) return;
    }
    if (!claimWrapNotification(ev.id)) return;
    // Remembered so the live sub can replace it once it decrypts the wrap.
    noteContentlessWrapAlert(ev.id);
    await fireMessageNotification({
      kind: 'dm',
      owner: viewerPubkey,
      threadId: '__background__',
      title: 'New encrypted message',
      body: 'Open Lightning Piggy to read',
      // The sender is inside the encryption; the wrap id lets a tap open the
      // right conversation once the app has decrypted it (#1154).
      data: { wrapId: ev.id },
    });
    return;
  }

  const rumor = decryptWrap(ev);
  if (!rumor) {
    console.warn('[BgDmWatch] wrap skipped: decrypt failed');
    return;
  }
  // Only notify for genuinely-fresh arrivals (the inner rumor timestamp is
  // the real send time; the relay's on-open backlog has old timestamps).
  if (rumor.created_at < subOpenedAtSec - NOTIFY_SKEW_SEC) return;

  const partnership = partnerFromRumor(rumor, viewerPubkey);
  if (!partnership) return;
  // Never notify for our own echoes (self-wraps / outgoing copies), nor for a
  // Marmot invite: it's joined as its own chat, the NIP-17 row is hidden (#1269).
  if (partnership.fromMe || rumor.kind === MARMOT_WELCOME_KIND) return;
  // A NIP-171 ticket or group rumor isn't a 1:1 message (the app ingests it).
  if (isNip171InboxRumor(rumor)) return;
  // Follow gate (mirrors the live sub's): a stranger must not be able to
  // spam OS notifications by gift-wrapping to our pubkey. Deliberately does
  // NOT claim the wrap id — the live sub's follow-gate defer buffer may
  // legitimately replay and notify for this wrap once follows hydrate.
  if (
    input.followedPubkeys &&
    !input.followedPubkeys.has(partnership.partnerPubkey.toLowerCase())
  ) {
    // …unless we've replied to them (#1623), like the live sub. Wait for that
    // set to load so a cold start can't mistake them for a stranger.
    await loadRepliedPartners(viewerPubkey);
    // Signed out / switched account meanwhile: not this watch's to alert.
    if (activeWatch?.viewerPubkey !== viewerPubkey) return;
    if (!hasRepliedTo(viewerPubkey, partnership.partnerPubkey)) return;
  }
  // Keep what we just decrypted (#1325): tapping the alert or opening
  // Messages then shows it at once instead of waiting for an inbox refresh.
  // Fresh, gated 1:1 messages only: the on-open backlog, Marmot invites and
  // an unknown follow set are left to the refresh; and not while the app's
  // live sub is armed, which stores it already. Not awaited: the write
  // mustn't delay the alert.
  if (input.followedPubkeys && !isLiveDmSubArmed()) {
    void storeDecryptedWrap(viewerPubkey, ev, rumor, input.followedPubkeys).catch(() => undefined);
  }
  // Claim BEFORE the async name resolution below — the claim is the
  // synchronous point that closes the race with the foreground live sub
  // processing the same wrap on the same JS thread.
  if (!claimWrapNotification(ev.id)) return;
  console.warn('[BgDmWatch] fresh wrap → firing notification');

  const senderName = await resolveSenderName(partnership.partnerPubkey, readRelays);
  // textForRumor folds kind-15 file messages into a renderable URL; for a
  // notification body we want the human-facing text. `dmRowPreview` then redacts
  // a structured rumor (order JSON, or an NWC wallet-share bearer connection
  // string) to a secret-free summary — a plain chat message passes through
  // unchanged. The notificationService additionally swaps in generic copy when
  // the user has lock-screen content disabled.
  const preview = dmRowPreview(textForRumor(rumor), rumor.kind, getAppFormatLocale());
  const notifId = await fireMessageNotification({
    kind: 'dm',
    owner: viewerPubkey,
    threadId: dmThreadId(partnership.partnerPubkey, protocolForWireKind(rumor.kind)),
    title: senderName,
    body: preview,
    data: {
      conversationPubkey: partnership.partnerPubkey,
      messageId: ev.id,
      conversationProtocol: protocolForWireKind(rumor.kind),
    },
  });
  console.warn(`[BgDmWatch] notification result: ${notifId ?? 'suppressed/failed'}`);
}

/**
 * Run one background DM watch session: open the live kind-1059 subscription
 * for the active identity and fire signer-aware notifications on new wraps.
 * Idempotent — re-arming tears down any prior watch first. Returns true if a
 * watch was armed, false when there's nothing to watch (no identity, no read
 * relays, or not Android).
 *
 * This is the function the native foreground-service headless task
 * (`BackgroundDmTask`, see backgroundDmHeadlessTask.ts) calls to arm the
 * watch in its headless context. When the native module is absent it's driven
 * directly by `startBackgroundDmWatch` instead, so the experience still works
 * for as long as the foreground JS context is alive.
 */
export function runBackgroundDmWatch(): Promise<boolean> {
  return enqueueArm(captureBackgroundDmWatchEpoch());
}

/**
 * Queue one arm for the session `isCurrent` was captured in. An arm whose
 * session is stopped or replaced before it subscribes resolves false without
 * touching anything — the newer owner decides.
 */
function enqueueArm(isCurrent: () => boolean): Promise<boolean> {
  if (Platform.OS !== 'android') return Promise.resolve(false);
  // Serialise arms (safety re-arm, reconnect, account switch, host
  // reconcile) so two can't interleave and stack subscriptions, and count
  // them: while one is in flight `activeWatch` is transiently null by design,
  // and the payment poll must not read that as "no DM watch" (#1100 review).
  dmArmsInFlight += 1;
  const run = dmArmChain.catch(() => {}).then(() => armBackgroundDmWatchOnce(isCurrent));
  dmArmChain = run;
  return run.finally(() => {
    dmArmsInFlight -= 1;
  });
}

async function armBackgroundDmWatchOnce(isCurrent: () => boolean): Promise<boolean> {
  // Superseded while queued behind an earlier arm: bail before any teardown
  // so a stale arm can never close the newer session's subscription.
  if (!isCurrent()) return false;
  // Re-check notification permission on EVERY arm — including the safety
  // re-arm and relay-drop reconnect paths. If the user revoked
  // POST_NOTIFICATIONS after enabling the watch, keeping the subscription
  // (and service) alive is an invisible battery drain that can never surface
  // an alert — hard-stop the whole watch instead, matching what
  // startBackgroundDmWatch and the headless task enforce on entry.
  const granted = await hasNotificationPermission().catch(() => false);
  if (!isCurrent()) return false;
  if (!granted) {
    console.warn('[BgDmWatch] permission revoked — stopping the watch');
    void stopBackgroundDmWatch().catch(() => {});
    return false;
  }

  // Tear down any existing watch so we never stack two subscriptions.
  stopBackgroundDmWatchSubscription();

  const blob = await loadIdentities();
  if (!isCurrent()) return false;
  // Normalise to lowercase before validating/subscribing — identities are
  // accepted case-insensitively upstream, but relay filters and the follow
  // gate compare lowercase hex; an uppercase-stored pubkey must not silently
  // refuse to arm (Copilot review on #958).
  const activePubkey = blob.activePubkey?.toLowerCase();
  if (!activePubkey || !HEX64.test(activePubkey)) {
    console.warn('[BgDmWatch] not armed: no active pubkey');
    return false;
  }
  const identity = blob.identities.find((i) => i.pubkey.toLowerCase() === activePubkey);
  if (!identity) {
    console.warn('[BgDmWatch] not armed: active identity not found');
    return false;
  }

  if (__DEV__) await initialiseBackgroundRelayAccount();
  const readRelays = await resolveReadRelays(activePubkey);
  if (!isCurrent()) return false;
  if (readRelays.length === 0) {
    console.warn('[BgDmWatch] not armed: no read relays');
    return false;
  }

  const decryptWrap = buildNsecDecryptor(identity);
  // Follow gate data — only meaningful on the content path (the contentless
  // path can't know the sender, so it can't be gated). Loaded once per arm;
  // the 15-min safety re-arm refreshes it as follows change.
  const followedPubkeys = decryptWrap ? await loadFollowedPubkeys(activePubkey) : null;
  // A headless start has no React tree to load who we've replied to (#1623).
  // Start it now; the follow gate waits for it before treating anyone as a
  // stranger.
  if (decryptWrap) void loadRepliedPartners(activePubkey);
  // Last await before subscribing: from here to `activeWatch` is synchronous,
  // so a stop / identity re-arm can't slip in between check and install.
  if (!isCurrent()) return false;
  const subOpenedAtSec = Math.floor(Date.now() / 1000);
  console.warn(
    `[BgDmWatch] arming: viewer=${activePubkey.slice(0, 8)}… relays=${readRelays.length} decryptor=${decryptWrap ? 'nsec' : 'contentless'} follows=${followedPubkeys ? followedPubkeys.size : 'uncached'}`,
  );

  // Backlog-settled latch for the contentless path (see handleWrap). The nsec
  // path doesn't need it — its per-wrap rumor-timestamp gate is stricter.
  let eosed = false;
  // This arm supersedes any pending reconnect and starts a fresh generation.
  clearReconnectTimer();
  const generation = ++watchGeneration;
  const armedAtMs = Date.now();
  const unsubscribe = subscribeInboxDmsForViewer({
    viewerPubkey: activePubkey,
    relays: readRelays,
    wrapsLimit: decryptWrap ? BACKLOG_WRAPS_LIMIT : CONTENTLESS_BACKLOG_WRAPS_LIMIT,
    onEose: () => {
      eosed = true;
    },
    onWrapsClose: () => {
      // Lifetime-based health: a sub that survived a while was genuinely
      // connected, so its drop retries from the base delay; a rapid-fail
      // (offline) keeps climbing the exponential ladder.
      if (Date.now() - armedAtMs >= HEALTHY_SUB_MIN_LIFETIME_MS) reconnectAttempt = 0;
      scheduleWatchReconnect(generation);
    },
    onEvent: (ev) => {
      // Fire-and-forget per event; swallow per-event errors so one bad wrap
      // can't tear down the long-lived subscription.
      void handleWrap({
        ev,
        viewerPubkey: activePubkey,
        readRelays,
        subOpenedAtSec,
        decryptWrap,
        backlogSettled: () => eosed,
        followedPubkeys,
      }).catch((e) => {
        console.warn('[backgroundDmService] handleWrap failed:', e);
      });
    },
  });

  activeWatch = { viewerPubkey: activePubkey, unsubscribe };
  // Belt-and-braces: a periodic re-arm catches anything the onclose signal
  // misses (e.g. a subscription alive on one zombie relay that never
  // delivers). Cheap on healthy sockets; silent by construction.
  if (!safetyRearmTimer) {
    safetyRearmTimer = setInterval(() => {
      if (!activeWatch) return;
      void runBackgroundDmWatch().catch(() => {});
    }, SAFETY_REARM_INTERVAL_MS);
  }
  return true;
}

/**
 * Start the payment poll with the host reconcile hook: when a pass finds the
 * payment scope gone and no DM subscription is armed either, nothing is
 * watching — stop the foreground service / chip instead of letting the
 * never-settling headless task pin them forever (Copilot review, #1100). A
 * live DM watch keeps the host up; the poll idles cheaply until a wallet
 * reappears or the 15-min safety re-arm re-evaluates.
 *
 * `activeWatch` alone is not proof that DMs are off: every safety re-arm and
 * reconnect clears it while awaiting storage. So an in-flight arm defers the
 * decision to the next pass, and with no DM watch at all the reconcile tries
 * one arm itself (it also recovers a reconnect whose arm threw) before
 * stopping anything (#1100 review). Every step is pinned to the epoch the
 * reconcile started in, so a stop or identity re-arm during its awaits hands
 * the decision to that newer session instead of being overridden by it.
 */
export function armBackgroundPaymentWatch(): void {
  startBackgroundPaymentWatch(() => {
    void reconcilePaymentHost().catch(() => {});
  });
}

async function reconcilePaymentHost(): Promise<void> {
  const isCurrent = captureBackgroundDmWatchEpoch();
  if (activeWatch || dmArmsInFlight > 0) return;
  const armed = await enqueueArm(isCurrent);
  // A later arm (account switch, reconnect) or a stop owns the decision now.
  if (!isCurrent() || armed || activeWatch || dmArmsInFlight > 0) return;
  if (!isBackgroundPaymentWatchRunning()) return;
  const payments = await canWatchBackgroundPayments();
  if (!isCurrent() || payments || activeWatch || dmArmsInFlight > 0) return;
  console.warn('[BgDmWatch] payment scope gone and no DM watch — stopping the host');
  await stopBackgroundDmWatch();
}

/** Close the live subscription without touching the foreground chip. */
function stopBackgroundDmWatchSubscription(): void {
  // Invalidate in-flight close signals + pending reconnects FIRST — the
  // unsubscribe below fires onWrapsClose synchronously, and without the bump
  // that intentional close would schedule a bogus reconnect. NB the backoff
  // counter is NOT reset here: every re-arm passes through this teardown, so
  // resetting would pin a dead-network loop at the shortest delay forever.
  // It resets on a healthy EOSE and on an intentional stopBackgroundDmWatch.
  watchGeneration += 1;
  clearReconnectTimer();
  if (safetyRearmTimer) {
    clearInterval(safetyRearmTimer);
    safetyRearmTimer = null;
  }
  if (activeWatch) {
    try {
      activeWatch.unsubscribe();
    } catch {
      // best-effort
    }
    activeWatch = null;
  }
}

/**
 * Enable the background DM watch: post the persistent foreground status chip
 * and arm the live subscription. Android-only; no-ops elsewhere. Call after
 * the user flips the Settings toggle ON (and notification permission is
 * granted). Does NOT persist the preference — the toggle handler owns that
 * via `setBackgroundDmEnabled`.
 *
 * Starts the native foreground service (modules/background-dm-service) when
 * it's present in the build, so the JS context — and this subscription —
 * survives the app being backgrounded or swiped away. The service hosts a
 * headless JS task that calls `runBackgroundDmWatch()` itself, so we don't
 * arm the subscription a SECOND time here when the native service is taking
 * over; we only fall back to running it inline when the native module is
 * absent (e.g. Expo Go, or a dev client predating the native build), where
 * the chip + subscription persist only while the app's JS context is alive.
 */
export async function startBackgroundDmWatch(reportFailure = false): Promise<void> {
  if (Platform.OS !== 'android') return;
  // A stop / identity re-arm during this start's awaits supersedes it: it
  // must neither arm after an explicit stop nor second-guess the newer owner.
  let isCurrent = captureBackgroundDmWatchEpoch();
  // Without notification permission the watch is an invisible battery drain —
  // it can't post the status chip or any of the message alerts it exists to
  // deliver — so a missing/revoked permission is a hard stop, not a warning.
  const granted = await hasNotificationPermission().catch(() => false);
  if (!isCurrent()) return;
  if (!granted) {
    console.warn('[BgDmWatch] not started: notification permission missing');
    if (reportFailure) throw new Error('Notification permission missing');
    return;
  }
  try {
    if (isBackgroundDmServiceAvailable()) {
      // Native service owns the watch: it spins up a headless JS context and
      // runs the BackgroundDmTask (→ runBackgroundDmWatch) there. Arming it
      // here too would open a duplicate subscription — and the service posts
      // its own startForeground() chip, so posting the Expo sticky chip as
      // well would stack two ongoing entries in the shade.
      await startForegroundService();
      if (!isCurrent()) return;
      // If the service was ALREADY running, the start above is a no-op (the
      // service guards against stacking a second headless task) — but the
      // active identity may have changed since its watch armed (login adding
      // a new account). Swap the subscription in place; no-op after a fresh
      // start (the headless task hasn't armed anything in this context yet).
      const rearm = rearmBackgroundDmWatchForActiveIdentity();
      // The re-arm opens its epoch synchronously on call: adopt it, so a
      // failure inside our own re-arm is still ours to clean up below.
      isCurrent = captureBackgroundDmWatchEpoch();
      await rearm;
      if (!isCurrent()) return;
      // A running native service does not dispatch another headless task.
      // Recover payment polling here if its earlier task failed or yielded
      // before arming; starting the shared loop is idempotent.
      armBackgroundPaymentWatch();
    } else {
      // Fallback (native module absent — Expo Go / stale dev client): the
      // Expo sticky chip is the only status surface, and the subscription
      // runs inline in this JS context.
      const chipId = await showForegroundServiceNotification({
        title: 'Lightning Piggy is watching for messages and payments',
        body: 'Tap to open. Watching messages and checking Lightning payments.',
      });
      if (!isCurrent()) return;
      if (chipId === null) {
        console.warn('[BgDmWatch] not started: foreground chip could not be posted');
        if (reportFailure) throw new Error('Foreground notification unavailable');
        return;
      }
      const armed = await enqueueArm(isCurrent);
      if (!isCurrent()) return;
      // Payments poll independently of the DM subscription: an identity with
      // NWC wallets but no DM relays still gets payment alerts (#1100 review).
      const payments = await canWatchBackgroundPayments();
      if (!isCurrent()) return;
      if (!armed && !payments) {
        // Nothing to watch (no identity / no relays / no NWC wallets) — don't
        // leave a chip promising a watch that isn't running.
        await dismissForegroundServiceNotification();
      } else {
        // Armed even with no NWC wallet yet, like the headless task: each pass
        // self-gates, so a wallet added later is polled without a re-arm.
        armBackgroundPaymentWatch();
      }
    }
  } catch (e) {
    // Don't leave a stray chip (or half-armed subscription) behind when the
    // start failed — clean up and log; callers don't handle a rejection here.
    console.warn('[BgDmWatch] start failed — cleaning up:', e);
    // Superseded meanwhile: the stop / re-arm that won owns the cleanup, and
    // tearing down here could kill that newer session's watch.
    if (!isCurrent()) return;
    stopBackgroundPaymentWatch();
    stopBackgroundDmWatchSubscription();
    await dismissForegroundServiceNotification();
    if (reportFailure) throw e;
  }
}

/**
 * Disable the background DM watch: close the subscription and dismiss the
 * persistent chip. Android-only; safe to call when nothing is running.
 */
export async function stopBackgroundDmWatch(): Promise<void> {
  stopBackgroundPaymentWatch();
  if (Platform.OS !== 'android') return;
  // End the session synchronously, before any await: bumping the epoch
  // cancels every queued or in-flight arm and host decision, and the teardown
  // closes any inline subscription this context owns (the fallback path) and
  // clears the reconnect / safety timers so none can enqueue a fresh arm.
  // Nothing from the old session can arm after this point, so the awaits
  // below never need to tear down again (which could only hit a newer start).
  // An intentional stop also resets the reconnect backoff so the next enable
  // starts fresh.
  watchEpoch += 1;
  reconnectAttempt = 0;
  stopBackgroundDmWatchSubscription();
  // Then stop the native service, which tears down the headless task.
  // Best-effort — a transient bridge error must not skip the chip dismissal
  // below, or the watch is left half-stopped with the chip still up.
  await stopForegroundService().catch((e) => {
    console.warn('[BgDmWatch] native stop failed (continuing cleanup):', e);
  });
  await dismissForegroundServiceNotification();
}

/**
 * Re-arm the live subscription for the (possibly changed) active identity.
 * Call after an account switch (#288): the running watch — whether hosted by
 * the native service's headless task or the inline fallback — was armed for
 * the PREVIOUS pubkey and would otherwise keep notifying for it until the
 * next app relaunch. Both hosts share this module's JS context (one React
 * context per process), so re-running the arm swaps the subscription in
 * place; the service, chip, and wake lock keep running untouched. No-op when
 * no watch is currently armed (feature off, or start was hard-stopped).
 */
export async function rearmBackgroundDmWatchForActiveIdentity(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // No-op unless SOMETHING is running. A payment-only watch (identity with
  // NWC wallets but no DM relays) counts: the missing DM subscription must
  // not skip the payment re-arm (#1100 review). Once anything is live the
  // service is up, so re-evaluate BOTH watchers for the new identity — it may
  // have relays the previous one lacked, or vice versa.
  // An arm in flight counts too: it may have read the previous identity
  // before the switch was persisted, and would otherwise win uncorrected.
  if (!activeWatch && dmArmsInFlight === 0 && !isBackgroundPaymentWatchRunning()) return;
  // Start a new epoch synchronously: queued arms and host decisions for the
  // previous identity are cancelled, and a later stop / re-arm cancels ours.
  watchEpoch += 1;
  const isCurrent = captureBackgroundDmWatchEpoch();
  // Abort any in-flight poll for the previous identity; the fresh start
  // below ticks immediately for the new one.
  stopBackgroundPaymentWatch();
  const armed = await enqueueArm(isCurrent);
  if (!isCurrent()) return;
  const payments = await canWatchBackgroundPayments();
  if (!isCurrent()) return;
  // While the host stays up the poll always runs (it self-gates per pass), so
  // an NWC wallet added after this re-arm is picked up without another one.
  if (armed || payments) armBackgroundPaymentWatch();
  if (!armed && !payments) {
    // The new identity has neither DM relays nor NWC wallets: nothing is
    // watching, so the native service / chip must not stay up draining the
    // battery (Copilot review, #1100). Reconcile the host — the preference
    // is untouched, so the next launch/login sync re-evaluates as usual.
    console.warn('[BgDmWatch] re-arm: nothing to watch for the new identity — stopping the host');
    await stopBackgroundDmWatch();
  }
}

/**
 * Re-evaluate the host after an NWC wallet has been PERSISTED for
 * `ownerPubkey`. With the preference already on but no DM relays and no NWC
 * wallet, the host stopped itself (nothing to watch), so a first wallet added
 * afterwards — or one re-added after the last was removed — would otherwise go
 * unpolled until the next launch / login sync (Copilot review, #1100).
 *
 * Only (re)starts a host that is not running: a live DM watch or payment poll
 * already self-gates per pass and picks the new wallet up. Starts nothing when
 * the preference is off, notification permission is missing, or the wallet's
 * identity is no longer active; any identity / preference / wallet write or
 * watch stop / re-arm during the checks supersedes this call.
 */
export async function rearmBackgroundWatchAfterNwcWalletAdded(
  ownerPubkey: string | null,
): Promise<void> {
  if (Platform.OS !== 'android' || !ownerPubkey) return;
  const hostRunning = () =>
    activeWatch !== null || dmArmsInFlight > 0 || isBackgroundPaymentWatchRunning();
  if (hostRunning()) return;
  const isCurrent = captureBackgroundDmWatchEpoch();
  const scopeCurrent = captureBackgroundPaymentScope();
  const { activePubkey } = await loadIdentities();
  if (activePubkey !== ownerPubkey) return;
  // Preference on, permission granted, and a usable NWC credential listed
  // for the active identity.
  const payments = await canWatchBackgroundPayments();
  if (!payments || !isCurrent() || !scopeCurrent() || hostRunning()) return;
  await startBackgroundDmWatch();
}

/**
 * Bring the watch into line with the persisted preference. Call on app
 * launch / login so a user who enabled it last session has the chip +
 * subscription back. No-op when disabled or not Android.
 */
export async function syncBackgroundDmWatchFromPreference(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const enabled = await loadBackgroundDmEnabled();
  if (enabled) {
    await startBackgroundDmWatch();
  } else {
    await stopBackgroundDmWatch();
  }
}

/** Test hook: report whether a live subscription is currently armed. */
export function __isWatchActiveForTests(): boolean {
  return activeWatch !== null;
}

/** Test hook: tear down state between tests. */
export function __resetForTests(): void {
  reconnectAttempt = 0;
  dmArmChain = Promise.resolve();
  dmArmsInFlight = 0;
  watchEpoch += 1;
  stopBackgroundDmWatchSubscription();
}
