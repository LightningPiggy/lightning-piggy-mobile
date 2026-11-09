// Tests for the Amethyst-style realtime background DM watch (#279 realtime
// upgrade). The relay subscription, identity/relay storage, notification
// service, profile cache, and NIP-17 unwrap are all mocked so we assert the
// signer-gating + fresh-arrival + contentless logic without network or
// native modules.

import {
  armBackgroundPaymentWatch,
  runBackgroundDmWatch,
  startBackgroundDmWatch,
  stopBackgroundDmWatch,
  rearmBackgroundDmWatchForActiveIdentity,
  rearmBackgroundWatchAfterNwcWalletAdded,
  __isWatchActiveForTests,
  __resetForTests,
} from './backgroundDmService';
import { invalidateBackgroundPaymentScope } from './backgroundPaymentScope';
import {
  claimWrapNotification,
  __resetForTests as __resetDedupeForTests,
} from './dmWrapNotificationDedupe';
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn().mockResolvedValue(null) }));

const mockSubscribe = jest.fn();
const mockLoadIdentities = jest.fn();
const mockGetUserRelays = jest.fn();
const mockAsyncGetItem = jest.fn();
const mockFireMessageNotification = jest.fn().mockResolvedValue('id');
const mockHasPermission = jest.fn();
const mockShowForeground = jest.fn().mockResolvedValue('fg');
const mockDismissForeground = jest.fn().mockResolvedValue(undefined);
const mockUnwrapWrapNsec = jest.fn();
const mockPartnerFromRumor = jest.fn();
const mockTextForRumor = jest.fn();
const mockDecodeNsec = jest.fn();
const mockFetchProfile = jest.fn().mockResolvedValue(null);
const mockPeekSync = jest.fn().mockReturnValue(null);
const mockGet = jest.fn().mockResolvedValue(null);
const mockCanWatchPayments = jest.fn();
const mockPaymentsRunning = jest.fn();
const mockStartPayments = jest.fn();
const mockStopPayments = jest.fn();
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('nostr-tools/nip44', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: (...a: unknown[]) => mockAsyncGetItem(...a) },
}));
jest.mock('./identitiesStore', () => ({ loadIdentities: () => mockLoadIdentities() }));
// The per-account settings migration reads the identity registry too; these
// tests script loadIdentities call by call, so keep it out of the way.
jest.mock('./safetySettingsMigration', () => ({
  ...jest.requireActual('./safetySettingsMigration'),
  ensureSafetySettingsMigrated: () => Promise.resolve(),
}));
// mergeRelays is the real one — the relay-resolution fix under test IS the
// defaults + nip65-cache + overrides merge, so don't stub it out.
jest.mock('./nostrRelayStorage', () => ({
  getUserRelays: () => mockGetUserRelays(),
  mergeRelays: jest.requireActual('./nostrRelayStorage').mergeRelays,
}));
jest.mock('./nostrService', () => ({
  decodeNsec: (...a: unknown[]) => mockDecodeNsec(...a),
  fetchProfile: (...a: unknown[]) => mockFetchProfile(...a),
  DEFAULT_RELAYS: ['wss://default.example'],
}));
jest.mock('./dmLiveSubscription', () => ({
  subscribeInboxDmsForViewer: (...a: unknown[]) => mockSubscribe(...a),
}));
jest.mock('./notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireMessageNotification(...a),
  hasNotificationPermission: () => mockHasPermission(),
  showForegroundServiceNotification: (...a: unknown[]) => mockShowForeground(...a),
  dismissForegroundServiceNotification: (...a: unknown[]) => mockDismissForeground(...a),
}));
jest.mock('./zapSenderProfileStorage', () => ({
  peekSync: (...a: unknown[]) => mockPeekSync(...a),
  get: (...a: unknown[]) => mockGet(...a),
}));
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: (...a: unknown[]) => mockUnwrapWrapNsec(...a),
  partnerFromRumor: (...a: unknown[]) => mockPartnerFromRumor(...a),
  textForRumor: (...a: unknown[]) => mockTextForRumor(...a),
}));
jest.mock('./backgroundPaymentService', () => ({
  canWatchBackgroundPayments: () => mockCanWatchPayments(),
  isBackgroundPaymentWatchRunning: () => mockPaymentsRunning(),
  startBackgroundPaymentWatch: (...a: unknown[]) => mockStartPayments(...a),
  stopBackgroundPaymentWatch: (...a: unknown[]) => mockStopPayments(...a),
}));
jest.mock('./backgroundDmPreference', () => ({ loadBackgroundDmEnabled: jest.fn() }));

const ME = 'a'.repeat(64);
const PARTNER = 'b'.repeat(64);
const READ_RELAYS = [{ url: 'wss://r.example', read: true, write: true }];
// Overrides the default relay to write-only, so the merged READ set is empty.
const WRITE_ONLY_RELAYS = [{ url: 'wss://default.example', read: false, write: true }];
const SECRET = new Uint8Array(32);

// Grab the onEvent handler the service registered with the subscription.
function capturedOnEvent(): (ev: unknown) => void {
  const call = mockSubscribe.mock.calls.at(-1);
  return (call?.[0] as { onEvent: (ev: unknown) => void }).onEvent;
}

// Fire the subscription's EOSE callback — marks the backlog replay settled.
function settleBacklog(): void {
  const call = mockSubscribe.mock.calls.at(-1);
  (call?.[0] as { onEose?: () => void }).onEose?.();
}

// Fire the wrap subscription's close signal (all relays dropped).
function dropWrapsSub(): void {
  const call = mockSubscribe.mock.calls.at(-1);
  (call?.[0] as { onWrapsClose?: (reasons: string[]) => void }).onWrapsClose?.(['relay closed']);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  __resetDedupeForTests();
  mockSubscribe.mockReturnValue(() => {});
  mockGetUserRelays.mockResolvedValue(READ_RELAYS);
  // A contacts cache following PARTNER: with none the watch fails closed (#1764).
  mockAsyncGetItem.mockImplementation((key: string) =>
    Promise.resolve(
      key.startsWith('nostr_contacts_cache') ? JSON.stringify([{ pubkey: PARTNER }]) : null,
    ),
  );
  mockHasPermission.mockResolvedValue(true);
  mockShowForeground.mockResolvedValue('fg');
  mockDecodeNsec.mockReturnValue({ pubkey: ME, secretKey: SECRET });
  mockCanWatchPayments.mockResolvedValue(false);
  mockPaymentsRunning.mockReturnValue(false);
});

function nsecIdentity() {
  return {
    identities: [{ pubkey: ME, signerType: 'nsec', nsec: 'nsec1xxx', lastUsedAt: 1 }],
    activePubkey: ME,
  };
}
function amberIdentity() {
  return {
    identities: [{ pubkey: ME, signerType: 'amber', lastUsedAt: 1 }],
    activePubkey: ME,
  };
}

describe('runBackgroundDmWatch arming', () => {
  it('returns false with no active identity', async () => {
    mockLoadIdentities.mockResolvedValue({ identities: [], activePubkey: null });
    expect(await runBackgroundDmWatch()).toBe(false);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('arms on DEFAULT_RELAYS when the user never customised relays (#279 swipe-away bug)', async () => {
    // Regression guard: getUserRelays() alone is only the explicit overrides
    // and is [] for most users — the watch must still arm via the defaults.
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockGetUserRelays.mockResolvedValue([]);
    expect(await runBackgroundDmWatch()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ relays: ['wss://default.example'] }),
    );
  });

  it('merges the cached NIP-65 list and user overrides into the read set', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockGetUserRelays.mockResolvedValue([{ url: 'wss://user.example', read: true, write: true }]);
    mockAsyncGetItem.mockResolvedValue(
      JSON.stringify([
        { url: 'wss://nip65.example', read: true, write: true },
        { url: 'wss://writeonly.example', read: false, write: true },
      ]),
    );
    expect(await runBackgroundDmWatch()).toBe(true);
    const relays = (mockSubscribe.mock.calls.at(-1)?.[0] as { relays: string[] }).relays;
    expect(relays).toEqual(
      expect.arrayContaining([
        'wss://default.example',
        'wss://nip65.example',
        'wss://user.example',
      ]),
    );
    expect(relays).not.toContain('wss://writeonly.example');
  });

  it('arms the live subscription for an nsec identity', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    expect(await runBackgroundDmWatch()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(__isWatchActiveForTests()).toBe(true);
  });

  it('tears down a prior watch before re-arming (no double subscription)', async () => {
    const unsub = jest.fn();
    mockSubscribe.mockReturnValue(unsub);
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();
    await runBackgroundDmWatch();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });
});

describe('nsec path: content notifications', () => {
  beforeEach(() => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
  });

  it('fires a sender-named content notification for a fresh inbound wrap', async () => {
    mockUnwrapWrapNsec.mockReturnValue({
      pubkey: PARTNER,
      created_at: nowSec(),
      kind: 14,
      tags: [],
      content: 'hello there',
    });
    mockPartnerFromRumor.mockReturnValue({ partnerPubkey: PARTNER, fromMe: false });
    mockTextForRumor.mockReturnValue('hello there');
    mockPeekSync.mockReturnValue({ displayName: 'Alice', name: null });

    await runBackgroundDmWatch();
    await capturedOnEvent()({ id: 'w1', kind: 1059 });
    await Promise.resolve();

    expect(mockFireMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dm',
        threadId: `${PARTNER.toLowerCase()}:nip17`,
        title: 'Alice',
        body: 'hello there',
        data: { conversationPubkey: PARTNER, conversationProtocol: 'nip17', messageId: 'w1' },
      }),
    );
  });

  it('skips our own echoes (fromMe)', async () => {
    mockUnwrapWrapNsec.mockReturnValue({
      pubkey: ME,
      created_at: nowSec(),
      kind: 14,
      tags: [],
      content: 'mine',
    });
    mockPartnerFromRumor.mockReturnValue({ partnerPubkey: PARTNER, fromMe: true });

    await runBackgroundDmWatch();
    await capturedOnEvent()({ id: 'w2', kind: 1059 });
    await Promise.resolve();

    expect(mockFireMessageNotification).not.toHaveBeenCalled();
  });

  it('stays silent for stale backlog wraps (old timestamp)', async () => {
    mockUnwrapWrapNsec.mockReturnValue({
      pubkey: PARTNER,
      created_at: nowSec() - 3 * 24 * 60 * 60, // 3 days old
      kind: 14,
      tags: [],
      content: 'old',
    });
    mockPartnerFromRumor.mockReturnValue({ partnerPubkey: PARTNER, fromMe: false });

    await runBackgroundDmWatch();
    await capturedOnEvent()({ id: 'w3', kind: 1059 });
    await Promise.resolve();

    expect(mockFireMessageNotification).not.toHaveBeenCalled();
  });

  // Follow / replied / Web of Trust gating (including no contacts cache)
  // lives in backgroundDmTier.test.ts, per tier.

  it('stays silent when the foreground live sub already claimed the wrap', async () => {
    mockUnwrapWrapNsec.mockReturnValue({
      pubkey: PARTNER,
      created_at: nowSec(),
      kind: 14,
      tags: [],
      content: 'hello there',
    });
    mockPartnerFromRumor.mockReturnValue({ partnerPubkey: PARTNER, fromMe: false });
    mockTextForRumor.mockReturnValue('hello there');

    await runBackgroundDmWatch();
    // Simulate the live sub (same JS context) winning the claim first.
    expect(claimWrapNotification('w-claimed')).toBe(true);
    await capturedOnEvent()({ id: 'w-claimed', kind: 1059 });
    await Promise.resolve();

    expect(mockFireMessageNotification).not.toHaveBeenCalled();
  });

  it('ignores non-1059 kinds (kind-4 / orders left to the foreground sub)', async () => {
    await runBackgroundDmWatch();
    await capturedOnEvent()({ id: 'k4', kind: 4 });
    await Promise.resolve();
    expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
    expect(mockFireMessageNotification).not.toHaveBeenCalled();
  });
});

describe('remote signer path: contentless notifications', () => {
  it('posts a contentless notification for an Amber identity, never decrypting', async () => {
    mockLoadIdentities.mockResolvedValue(amberIdentity());

    await runBackgroundDmWatch();
    settleBacklog();
    await capturedOnEvent()({ id: 'w4', kind: 1059 });
    await Promise.resolve();

    expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
    expect(mockFireMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dm',
        threadId: '__background__',
        title: 'New encrypted message',
        body: 'Open Lightning Piggy to read',
        // The wrap id lets a tap open the conversation once decrypted (#1154).
        data: { wrapId: 'w4' },
      }),
    );
  });

  it('stays silent for backlog wraps replayed before EOSE (no notification burst on arm)', async () => {
    // Contentless watches can't run the rumor-timestamp freshness gate, so
    // without the EOSE latch every replayed wrap would become a generic
    // notification on enable/boot (Copilot review, PR #958).
    mockLoadIdentities.mockResolvedValue(amberIdentity());

    await runBackgroundDmWatch();
    await capturedOnEvent()({ id: 'backlog-1', kind: 1059 });
    await capturedOnEvent()({ id: 'backlog-2', kind: 1059 });
    await Promise.resolve();
    expect(mockFireMessageNotification).not.toHaveBeenCalled();

    settleBacklog();
    await capturedOnEvent()({ id: 'live-1', kind: 1059 });
    await Promise.resolve();
    expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
  });

  it('uses the smaller contentless backlog limit when it cannot decrypt', async () => {
    mockLoadIdentities.mockResolvedValue(amberIdentity());
    await runBackgroundDmWatch();
    expect(mockSubscribe).toHaveBeenCalledWith(expect.objectContaining({ wrapsLimit: 10 }));
  });

  it('falls back to contentless when the nsec fails to decode', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockDecodeNsec.mockImplementation(() => {
      throw new Error('bad nsec');
    });

    await runBackgroundDmWatch();
    settleBacklog();
    await capturedOnEvent()({ id: 'w5', kind: 1059 });
    await Promise.resolve();

    expect(mockFireMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New encrypted message' }),
    );
  });
});

describe('self-re-arm on relay drop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('re-arms with backoff when the wrap subscription closes', async () => {
    await runBackgroundDmWatch();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    dropWrapsSub();
    // First retry fires after the 5s base delay.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially on rapid failures, resets after a long-lived sub', async () => {
    await runBackgroundDmWatch();
    dropWrapsSub(); // immediate fail (offline-style)
    await jest.advanceTimersByTimeAsync(5_000); // retry 1 (after 5s)
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    dropWrapsSub(); // fails again immediately
    await jest.advanceTimersByTimeAsync(5_000); // only 5s — retry 2 needs 10s
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000); // 10s total → retry 2
    expect(mockSubscribe).toHaveBeenCalledTimes(3);

    // A sub that survives ≥60s counts as healthy — its drop resets the
    // backoff so the next retry is the base 5s again. (EOSE is NOT the
    // health signal: nostr-tools EOSEs unreachable relays too.)
    await jest.advanceTimersByTimeAsync(61_000);
    dropWrapsSub();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockSubscribe).toHaveBeenCalledTimes(4);
  });

  it('does NOT re-arm on the close fired by an intentional stop', async () => {
    const unsub = jest.fn(() => dropWrapsSub());
    mockSubscribe.mockReturnValue(unsub);
    await startBackgroundDmWatch();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    await stopBackgroundDmWatch();
    // The teardown's own close signal must not schedule anything.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it('safety interval re-arms a live watch periodically', async () => {
    await runBackgroundDmWatch();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15 * 60_000);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });
});

describe('rearmBackgroundDmWatchForActiveIdentity (account switch, #288)', () => {
  it('is a no-op when no watch is armed', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await rearmBackgroundDmWatchForActiveIdentity();
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockStopPayments).not.toHaveBeenCalled();
    expect(mockStartPayments).not.toHaveBeenCalled();
  });

  it('re-arms a payment-only watch and arms DMs for a new identity that has relays', async () => {
    // Previous identity had NWC wallets but no DM relays, so only the payment
    // poll was running. The missing DM subscription must not skip the payment
    // re-arm — and the new identity's relays should now get a DM watch too
    // (CodeRabbit + Copilot reviews, #1100).
    mockPaymentsRunning.mockReturnValue(true);
    mockCanWatchPayments.mockResolvedValue(true);
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await rearmBackgroundDmWatchForActiveIdentity();
    expect(mockStopPayments).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
  });

  it('stops the host when the new identity has neither DM relays nor NWC wallets', async () => {
    // A running watch switched to an unwatchable identity must not leave the
    // native service / chip up draining the battery (Copilot review, #1100).
    const unsub = jest.fn();
    mockSubscribe.mockReturnValue(unsub);
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();
    expect(__isWatchActiveForTests()).toBe(true);

    mockGetUserRelays.mockResolvedValue(WRITE_ONLY_RELAYS);
    mockCanWatchPayments.mockResolvedValue(false);
    await rearmBackgroundDmWatchForActiveIdentity();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(__isWatchActiveForTests()).toBe(false);
    expect(mockStartPayments).not.toHaveBeenCalled();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
  });

  it('keeps the host up when the new identity is payment-only', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();
    mockGetUserRelays.mockResolvedValue(WRITE_ONLY_RELAYS);
    mockCanWatchPayments.mockResolvedValue(true);
    await rearmBackgroundDmWatchForActiveIdentity();
    expect(__isWatchActiveForTests()).toBe(false);
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
    expect(mockDismissForeground).not.toHaveBeenCalled();
  });

  it('keeps polling payments after a switch to an identity without NWC wallets yet', async () => {
    // The poll self-gates per pass, so it must keep running while the host is
    // up for DMs — otherwise a wallet connected after the switch is never
    // polled until the next app launch (#1100 review).
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();
    mockCanWatchPayments.mockResolvedValue(false);
    await rearmBackgroundDmWatchForActiveIdentity();
    expect(mockStopPayments).toHaveBeenCalledTimes(1);
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
    expect(mockStopPayments.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartPayments.mock.invocationCallOrder[0],
    );
    expect(mockDismissForeground).not.toHaveBeenCalled();
  });

  it('swaps the running subscription to the new active identity', async () => {
    const OTHER = 'c'.repeat(64);
    const unsub = jest.fn();
    mockSubscribe.mockReturnValue(unsub);
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();

    // Account switch: the registry now reports OTHER as active.
    mockLoadIdentities.mockResolvedValue({
      identities: [{ pubkey: OTHER, signerType: 'nsec', nsec: 'nsec1yyy', lastUsedAt: 2 }],
      activePubkey: OTHER,
    });
    mockDecodeNsec.mockReturnValue({ pubkey: OTHER, secretKey: SECRET });
    await rearmBackgroundDmWatchForActiveIdentity();

    expect(unsub).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscribe.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ viewerPubkey: OTHER }),
    );
  });
});

describe('rearmBackgroundWatchAfterNwcWalletAdded (first wallet, #1100 review)', () => {
  it('restarts the stopped host when the first NWC wallet is added with the preference on', async () => {
    // Preference already enabled, no DM relays and no NWC wallet yet: the
    // start finds nothing to watch and tears the host down.
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockGetUserRelays.mockResolvedValue(WRITE_ONLY_RELAYS);
    await startBackgroundDmWatch();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
    expect(mockStartPayments).not.toHaveBeenCalled();

    // The first NWC wallet is persisted for the active identity.
    mockCanWatchPayments.mockResolvedValue(true);
    await rearmBackgroundWatchAfterNwcWalletAdded(ME);
    expect(mockShowForeground).toHaveBeenCalledTimes(2);
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('starts nothing when the payment scope is unwatchable (preference off / no permission)', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockCanWatchPayments.mockResolvedValue(false);
    await rearmBackgroundWatchAfterNwcWalletAdded(ME);
    expect(mockShowForeground).not.toHaveBeenCalled();
    expect(mockStartPayments).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('ignores a wallet persisted for an identity that is no longer active', async () => {
    mockLoadIdentities.mockResolvedValue({
      identities: [{ pubkey: PARTNER, signerType: 'nsec', nsec: 'nsec1yyy', lastUsedAt: 2 }],
      activePubkey: PARTNER,
    });
    mockCanWatchPayments.mockResolvedValue(true);
    await rearmBackgroundWatchAfterNwcWalletAdded(ME);
    expect(mockCanWatchPayments).not.toHaveBeenCalled();
    expect(mockShowForeground).not.toHaveBeenCalled();
    expect(mockStartPayments).not.toHaveBeenCalled();
  });

  it('yields when the identity, preference or wallets change during the check', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockCanWatchPayments.mockImplementation(async () => {
      invalidateBackgroundPaymentScope();
      return true;
    });
    await rearmBackgroundWatchAfterNwcWalletAdded(ME);
    expect(mockShowForeground).not.toHaveBeenCalled();
    expect(mockStartPayments).not.toHaveBeenCalled();
  });

  it('yields to a stop that lands during the check', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockCanWatchPayments.mockImplementation(async () => {
      await stopBackgroundDmWatch();
      return true;
    });
    await rearmBackgroundWatchAfterNwcWalletAdded(ME);
    expect(mockShowForeground).not.toHaveBeenCalled();
    expect(mockStartPayments).not.toHaveBeenCalled();
  });

  it('leaves a running host alone: its self-gating poll picks the wallet up', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockCanWatchPayments.mockResolvedValue(true);
    await runBackgroundDmWatch();
    await rearmBackgroundWatchAfterNwcWalletAdded(ME);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    __resetForTests();
    mockPaymentsRunning.mockReturnValue(true);
    await rearmBackgroundWatchAfterNwcWalletAdded(ME);
    expect(mockShowForeground).not.toHaveBeenCalled();
    expect(mockStartPayments).not.toHaveBeenCalled();
    expect(mockCanWatchPayments).not.toHaveBeenCalled();
  });
});

describe('armBackgroundPaymentWatch host reconcile', () => {
  function capturedOnUnwatchable(): () => void {
    return mockStartPayments.mock.calls.at(-1)?.[0] as () => void;
  }

  // Let the async reconcile (arm attempt + scope re-check + stop) settle.
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it('stops the host when the payment scope disappears and no DM watch can arm', async () => {
    mockLoadIdentities.mockResolvedValue({ identities: [], activePubkey: null });
    mockPaymentsRunning.mockReturnValue(true);
    armBackgroundPaymentWatch();
    capturedOnUnwatchable()();
    await flush();
    expect(mockStopPayments).toHaveBeenCalled();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
  });

  it('does not stop the host while a DM safety re-arm is in flight', async () => {
    // DM-only identity: every payment pass is unwatchable. The safety re-arm
    // clears activeWatch and then awaits storage; a pass landing in that
    // window must not read it as "no DM watch" and kill the host (#1100).
    jest.useFakeTimers();
    try {
      mockPaymentsRunning.mockReturnValue(true);
      mockLoadIdentities.mockResolvedValue(nsecIdentity());
      await runBackgroundDmWatch();
      armBackgroundPaymentWatch();
      let release!: () => void;
      mockLoadIdentities.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(nsecIdentity());
          }),
      );
      await jest.advanceTimersByTimeAsync(15 * 60_000);
      expect(__isWatchActiveForTests()).toBe(false);
      capturedOnUnwatchable()();
      await flush();
      release();
      await flush();
      expect(mockDismissForeground).not.toHaveBeenCalled();
      expect(mockStopPayments).not.toHaveBeenCalled();
      expect(__isWatchActiveForTests()).toBe(true);
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-arms a DM watch whose reconnect arm failed instead of stopping the host', async () => {
    jest.useFakeTimers();
    try {
      mockPaymentsRunning.mockReturnValue(true);
      mockLoadIdentities.mockResolvedValue(nsecIdentity());
      await runBackgroundDmWatch();
      armBackgroundPaymentWatch();
      mockLoadIdentities.mockRejectedValueOnce(new Error('keystore busy'));
      dropWrapsSub();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(__isWatchActiveForTests()).toBe(false);
      capturedOnUnwatchable()();
      await flush();
      expect(mockDismissForeground).not.toHaveBeenCalled();
      expect(__isWatchActiveForTests()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the host up for a live DM watch', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();
    armBackgroundPaymentWatch();
    capturedOnUnwatchable()();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockDismissForeground).not.toHaveBeenCalled();
    expect(__isWatchActiveForTests()).toBe(true);
  });
});

describe('arm cancellation epoch (#1100 review)', () => {
  const OTHER = 'c'.repeat(64);
  function otherIdentity() {
    return {
      identities: [{ pubkey: OTHER, signerType: 'nsec', nsec: 'nsec1yyy', lastUsedAt: 2 }],
      activePubkey: OTHER,
    };
  }

  // Hold the next call of `mock` pending until the returned release fires.
  function holdNext<T>(mock: jest.Mock): (value: T) => void {
    let release!: (value: T) => void;
    mock.mockImplementationOnce(
      () =>
        new Promise<T>((resolve) => {
          release = resolve;
        }),
    );
    return (value) => release(value);
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it('an arm awaiting loadIdentities installs nothing once stopped', async () => {
    const release = holdNext(mockLoadIdentities);
    const arm = runBackgroundDmWatch();
    await flush();
    expect(mockLoadIdentities).toHaveBeenCalledTimes(1);
    await stopBackgroundDmWatch();
    release(nsecIdentity());
    expect(await arm).toBe(false);
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(__isWatchActiveForTests()).toBe(false);
  });

  it('arms queued before a stop never subscribe; arms after it do', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    const release = holdNext(mockLoadIdentities);
    const arms = [runBackgroundDmWatch(), runBackgroundDmWatch(), runBackgroundDmWatch()];
    await flush();
    await stopBackgroundDmWatch();
    release(nsecIdentity());
    expect(await Promise.all(arms)).toEqual([false, false, false]);
    // Only the head of the queue got as far as storage.
    expect(mockLoadIdentities).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);

    // A fresh session after the stop arms normally.
    expect(await runBackgroundDmWatch()).toBe(true);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it('a stop clears the reconnect timer before its awaits', async () => {
    jest.useFakeTimers();
    try {
      mockLoadIdentities.mockResolvedValue(nsecIdentity());
      await runBackgroundDmWatch();
      dropWrapsSub();
      const stop = stopBackgroundDmWatch();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      await stop;
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(__isWatchActiveForTests()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an account-switch re-arm supersedes an in-flight arm for the old identity', async () => {
    const release = holdNext(mockLoadIdentities);
    const staleArm = runBackgroundDmWatch();
    await flush();
    // Nothing is armed yet, but the in-flight arm counts as a running watch.
    mockLoadIdentities.mockResolvedValue(otherIdentity());
    mockDecodeNsec.mockReturnValue({ pubkey: OTHER, secretKey: SECRET });
    const rearm = rearmBackgroundDmWatchForActiveIdentity();
    release(nsecIdentity());
    expect(await staleArm).toBe(false);
    await rearm;
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe.mock.calls[0][0]).toEqual(
      expect.objectContaining({ viewerPubkey: OTHER }),
    );
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
  });

  it('a re-arm superseded by a stop neither arms payments nor subscribes', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();
    const release = holdNext(mockLoadIdentities);
    const rearm = rearmBackgroundDmWatchForActiveIdentity();
    await flush();
    await stopBackgroundDmWatch();
    release(nsecIdentity());
    await rearm;
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(__isWatchActiveForTests()).toBe(false);
    expect(mockStartPayments).not.toHaveBeenCalled();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
  });

  it('a fallback start interrupted by a stop does not arm after it', async () => {
    const release = holdNext(mockLoadIdentities);
    mockCanWatchPayments.mockResolvedValue(true);
    const start = startBackgroundDmWatch();
    await flush();
    await stopBackgroundDmWatch();
    release(nsecIdentity());
    await start;
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockStartPayments).not.toHaveBeenCalled();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
  });

  it('a host reconcile does not stop a newer session started during its awaits', async () => {
    mockPaymentsRunning.mockReturnValue(true);
    mockLoadIdentities.mockResolvedValue({ identities: [], activePubkey: null });
    armBackgroundPaymentWatch();
    const onUnwatchable = mockStartPayments.mock.calls.at(-1)?.[0] as () => void;
    // The reconcile's arm finds nothing, then parks on the scope re-check.
    const releaseScope = holdNext<boolean>(mockCanWatchPayments);
    onUnwatchable();
    await flush();
    expect(mockCanWatchPayments).toHaveBeenCalledTimes(1);

    // Meanwhile the user stops and re-enables: a payment-only session.
    await stopBackgroundDmWatch();
    mockCanWatchPayments.mockResolvedValue(true);
    await startBackgroundDmWatch();
    expect(mockStartPayments).toHaveBeenCalledTimes(2);
    const dismissalsBefore = mockDismissForeground.mock.calls.length;
    const stopsBefore = mockStopPayments.mock.calls.length;

    // The stale "scope gone" verdict lands late and must be ignored.
    releaseScope(false);
    await flush();
    expect(mockDismissForeground).toHaveBeenCalledTimes(dismissalsBefore);
    expect(mockStopPayments).toHaveBeenCalledTimes(stopsBefore);
  });

  it('a host reconcile arm cancelled by a stop installs nothing', async () => {
    mockPaymentsRunning.mockReturnValue(true);
    armBackgroundPaymentWatch();
    const onUnwatchable = mockStartPayments.mock.calls.at(-1)?.[0] as () => void;
    const release = holdNext(mockLoadIdentities);
    onUnwatchable();
    await flush();
    await stopBackgroundDmWatch();
    release(nsecIdentity());
    await flush();
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
  });
});

describe('start / stop lifecycle', () => {
  it('start posts the foreground chip and arms the watch', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await startBackgroundDmWatch();
    expect(mockShowForeground).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it('stops the whole watch when permission is revoked before a re-arm', async () => {
    // The safety re-arm / reconnect call runBackgroundDmWatch directly — a
    // revoked POST_NOTIFICATIONS must tear the watch down, not leave an
    // invisible battery drain (Copilot review, PR #958).
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await runBackgroundDmWatch();
    expect(__isWatchActiveForTests()).toBe(true);

    mockHasPermission.mockResolvedValue(false);
    expect(await runBackgroundDmWatch()).toBe(false);
    await Promise.resolve();
    expect(mockDismissForeground).toHaveBeenCalled();
    expect(__isWatchActiveForTests()).toBe(false);
  });

  it('hard-stops without arming when notification permission is missing', async () => {
    // Settings needs a rejection to roll back; automatic starts stay best effort.
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockHasPermission.mockResolvedValue(false);
    await startBackgroundDmWatch();
    await expect(startBackgroundDmWatch(true)).rejects.toThrow('Notification permission missing');
    expect(mockShowForeground).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(__isWatchActiveForTests()).toBe(false);
  });

  it('does not arm anything when the fallback chip cannot be posted', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockShowForeground.mockResolvedValueOnce(null);
    await startBackgroundDmWatch();
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(__isWatchActiveForTests()).toBe(false);
  });

  it('dismisses the chip when the fallback arm finds nothing to watch', async () => {
    // Arming can fail after the chip is up (no identity / no relays) — the
    // chip must not stay in the shade promising a watch that is not running.
    mockLoadIdentities.mockResolvedValue({ identities: [], activePubkey: null });
    await startBackgroundDmWatch();
    expect(mockShowForeground).toHaveBeenCalledTimes(1);
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
    expect(mockStartPayments).not.toHaveBeenCalled();
    expect(__isWatchActiveForTests()).toBe(false);
  });

  it('keeps the chip and polls payments when only payments are watchable (fallback)', async () => {
    // Identity with NWC wallets but no DM relays: payment monitoring runs on
    // its own and the chip stays up for it (#1100 review).
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockGetUserRelays.mockResolvedValue(WRITE_ONLY_RELAYS);
    mockCanWatchPayments.mockResolvedValue(true);
    await startBackgroundDmWatch();
    expect(__isWatchActiveForTests()).toBe(false);
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockShowForeground).toHaveBeenCalledTimes(1);
    expect(mockDismissForeground).not.toHaveBeenCalled();
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
  });

  it('polls payments for a DM identity before it has any NWC wallet (fallback)', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockCanWatchPayments.mockResolvedValue(false);
    await startBackgroundDmWatch();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
    expect(mockDismissForeground).not.toHaveBeenCalled();
  });

  it('starts payment polling alongside the DM watch (fallback)', async () => {
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    mockCanWatchPayments.mockResolvedValue(true);
    await startBackgroundDmWatch();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockStartPayments).toHaveBeenCalledTimes(1);
  });

  it('cleans up the chip and the payment poll when arming throws', async () => {
    mockLoadIdentities.mockRejectedValueOnce(new Error('identities store unavailable'));
    await startBackgroundDmWatch();
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
    expect(mockStopPayments).toHaveBeenCalled();
    expect(__isWatchActiveForTests()).toBe(false);
  });

  it('stop dismisses the chip and closes the subscription', async () => {
    const unsub = jest.fn();
    mockSubscribe.mockReturnValue(unsub);
    mockLoadIdentities.mockResolvedValue(nsecIdentity());
    await startBackgroundDmWatch();
    await stopBackgroundDmWatch();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(mockDismissForeground).toHaveBeenCalledTimes(1);
    expect(__isWatchActiveForTests()).toBe(false);
  });
});
