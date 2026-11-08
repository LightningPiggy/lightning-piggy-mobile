/**
 * Unit tests for the NWC relay-health module (#785 / #786).
 *
 * Covers two independent back-off mechanisms plus the tri-state wallet health:
 *  - the reply-timeout cooldown (#656) — moved here from nwcService.test.ts now
 *    that `isRelayInCooldown` / `recordRelayOutcome` live in this module;
 *  - the rate-limit publish back-off (#785), whose KEY regression is that a
 *    successful READ must NOT clear it (rate-limiting is about publish volume,
 *    not backend health);
 *  - `getWalletHealth` returning checking / responsive / degraded / disconnected,
 *    plus the liveness-probe throttle (#1768).
 *
 * These functions hold module-level Maps keyed by walletId, so every test uses
 * a UNIQUE walletId to stay isolated (no shared mutable state across cases).
 */

import {
  RELAY_COOLDOWN_BASE_MS,
  RELAY_COOLDOWN_MAX_MS,
  RELAY_DEAD_AFTER_FAILURES,
  getWalletHealth,
  isRateLimitError,
  isRelayDead,
  isRelayInCooldown,
  WALLET_PROBE_AFTER_MS,
  WALLET_REPLY_FRESH_MS,
  clearWalletLiveness,
  markRelayResponsive,
  markWalletProbed,
  recordRateLimited,
  recordRelayOutcome,
  recordWalletReply,
  resetWalletReply,
  shouldProbeWallet,
  subscribeWalletHealth,
  trackWalletReply,
} from './nwcRelayHealth';

// A connection error that recordRelayOutcome counts toward "dead". The message
// matches isConnectionError's matcher in nwcErrors.
const connErr = () => new Error('Failed to connect to wss://relay.example.com');
// Shapes of the @getalby/sdk errors: Nip47WalletError carries a NIP-47 `code`;
// Nip47ReplyTimeoutError has no custom `name`, code "INTERNAL".
const sdkErr = (message: string, code: string) => Object.assign(new Error(message), { code });
const walletErr = (code: string) => sdkErr(`wallet said ${code}`, code);
const sdkReplyTimeout = () => sdkErr('reply timeout: event abc123', 'INTERNAL');

let nextId = 0;
const freshId = () => `wallet-${nextId++}`;

afterEach(() => {
  jest.useRealTimers();
});

describe('isRateLimitError', () => {
  it.each([
    'rate-limited',
    'rate limited: slow down',
    'too many requests',
    'too fast, please wait',
    'slow down',
    'temp-ban for 60s',
    'tempban',
    'request throttled',
    'blocked by relay',
  ])('matches %p', (msg) => {
    expect(isRateLimitError(new Error(msg))).toBe(true);
  });

  it('does NOT match a plain reply timeout', () => {
    expect(isRateLimitError(new Error('reply timeout'))).toBe(false);
  });

  it('does NOT match a generic connection error', () => {
    expect(isRateLimitError(connErr())).toBe(false);
  });

  it('tolerates non-Error values', () => {
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('rate-limited')).toBe(true);
  });
});

describe('reply-timeout cooldown (#656)', () => {
  it('is false for a fresh / responsive wallet', () => {
    const id = freshId();
    expect(isRelayInCooldown(id)).toBe(false);
    expect(isRelayDead(id)).toBe(false);
  });

  it('stays out of cooldown until the relay crosses the dead threshold', () => {
    const id = freshId();
    for (let i = 0; i < RELAY_DEAD_AFTER_FAILURES - 1; i++) recordRelayOutcome(id, connErr());
    expect(isRelayInCooldown(id)).toBe(false);
    expect(isRelayDead(id)).toBe(false);
  });

  it('enters cooldown once the relay is considered dead', () => {
    const id = freshId();
    for (let i = 0; i < RELAY_DEAD_AFTER_FAILURES; i++) recordRelayOutcome(id, connErr());
    expect(isRelayInCooldown(id)).toBe(true);
    expect(isRelayDead(id)).toBe(true);
  });

  it('clears the cooldown the moment the relay answers again (markRelayResponsive)', () => {
    const id = freshId();
    for (let i = 0; i < RELAY_DEAD_AFTER_FAILURES; i++) recordRelayOutcome(id, connErr());
    expect(isRelayInCooldown(id)).toBe(true);
    // An answered request (no error) resets the failure counter + cooldown.
    recordRelayOutcome(id);
    expect(isRelayInCooldown(id)).toBe(false);
    expect(isRelayDead(id)).toBe(false);
  });

  it('expires on its own timer', () => {
    jest.useFakeTimers();
    const id = freshId();
    const t0 = Date.now();
    jest.setSystemTime(t0);
    for (let i = 0; i < RELAY_DEAD_AFTER_FAILURES; i++) recordRelayOutcome(id, connErr());
    expect(isRelayInCooldown(id)).toBe(true);
    jest.setSystemTime(t0 + RELAY_COOLDOWN_BASE_MS + 1);
    expect(isRelayInCooldown(id)).toBe(false);
  });
});

describe('rate-limit publish back-off (#785)', () => {
  it('parks the relay as soon as it rate-limits us', () => {
    const id = freshId();
    expect(isRelayInCooldown(id)).toBe(false);
    recordRateLimited(id);
    expect(isRelayInCooldown(id)).toBe(true);
  });

  it('KEY REGRESSION: a successful READ does NOT clear the rate-limit back-off', () => {
    const id = freshId();
    recordRateLimited(id);
    expect(isRelayInCooldown(id)).toBe(true);
    // A lucky answered read resets reply-timeout health …
    markRelayResponsive(id);
    recordRelayOutcome(id); // another answered request
    // … but the rate-limit back-off must remain — it's about publish volume,
    // not whether one read happened to come back.
    expect(isRelayInCooldown(id)).toBe(true);
  });

  it('escalates the back-off with each strike (doubling)', () => {
    jest.useFakeTimers();
    const id = freshId();
    const t0 = 1_000_000;
    jest.setSystemTime(t0);

    // Strike 1 → BASE window.
    recordRateLimited(id);
    jest.setSystemTime(t0 + RELAY_COOLDOWN_BASE_MS - 1);
    expect(isRelayInCooldown(id)).toBe(true);

    // Strike 2 lands WHILE still parked (a repeat publish into the ban, the
    // real-world case) — so strikes climb to 2 and the window becomes 2×BASE
    // from this moment. We don't read isRelayInCooldown first, which would
    // reset the strike count once a window has lapsed.
    const t1 = t0 + RELAY_COOLDOWN_BASE_MS - 1;
    recordRateLimited(id);
    jest.setSystemTime(t1 + RELAY_COOLDOWN_BASE_MS + 1);
    expect(isRelayInCooldown(id)).toBe(true); // still parked: window is 2×BASE
    jest.setSystemTime(t1 + 2 * RELAY_COOLDOWN_BASE_MS + 1);
    expect(isRelayInCooldown(id)).toBe(false);
  });

  it('caps the escalating back-off at RELAY_COOLDOWN_MAX_MS', () => {
    jest.useFakeTimers();
    const id = freshId();
    let t = 0;
    // Hammer many strikes so 2^(strikes-1) blows past the cap.
    for (let i = 0; i < 12; i++) {
      jest.setSystemTime(t);
      recordRateLimited(id);
      // Advance past the max window so the next strike records cleanly.
      t += RELAY_COOLDOWN_MAX_MS + 1;
    }
    // Last strike's window must be exactly the cap, not unbounded.
    const last = t - (RELAY_COOLDOWN_MAX_MS + 1);
    jest.setSystemTime(last + RELAY_COOLDOWN_MAX_MS - 1);
    expect(isRelayInCooldown(id)).toBe(true);
    jest.setSystemTime(last + RELAY_COOLDOWN_MAX_MS + 1);
    expect(isRelayInCooldown(id)).toBe(false);
  });

  it('resets strikes once the back-off expires so a recovered relay starts fresh', () => {
    jest.useFakeTimers();
    const id = freshId();
    const t0 = 5_000_000;
    jest.setSystemTime(t0);
    recordRateLimited(id);
    recordRateLimited(id); // 2 strikes → window 2×BASE
    // Let it lapse (this also resets the strike count inside isRelayInCooldown).
    jest.setSystemTime(t0 + 2 * RELAY_COOLDOWN_BASE_MS + 1);
    expect(isRelayInCooldown(id)).toBe(false);
    // A NEW rate-limit should restart at strike 1 → BASE window, not 4×BASE.
    const t1 = t0 + 2 * RELAY_COOLDOWN_BASE_MS + 2;
    jest.setSystemTime(t1);
    recordRateLimited(id);
    jest.setSystemTime(t1 + RELAY_COOLDOWN_BASE_MS - 1);
    expect(isRelayInCooldown(id)).toBe(true);
    jest.setSystemTime(t1 + RELAY_COOLDOWN_BASE_MS + 1);
    expect(isRelayInCooldown(id)).toBe(false);
  });
});

describe('getWalletHealth (#786)', () => {
  it('is disconnected when the WebSocket is not connected — regardless of relay state', () => {
    const id = freshId();
    expect(getWalletHealth(id, false)).toBe('disconnected');
    // Even parked, a down socket reads disconnected (red beats amber).
    recordRateLimited(id);
    expect(getWalletHealth(id, false)).toBe('disconnected');
  });

  it('is responsive when connected and the wallet has answered', () => {
    const id = freshId();
    recordRelayOutcome(id); // answered
    expect(getWalletHealth(id, true)).toBe('responsive');
  });

  it('is degraded when connected but the relay is rate-limit parked', () => {
    const id = freshId();
    recordRateLimited(id);
    expect(getWalletHealth(id, true)).toBe('degraded');
  });

  it('is degraded on a single recent reply-timeout (before crossing the dead threshold)', () => {
    const id = freshId();
    recordRelayOutcome(id, connErr()); // 1 failure, not yet "dead"
    expect(isRelayInCooldown(id)).toBe(false);
    expect(getWalletHealth(id, true)).toBe('degraded');
  });

  it('clears back to responsive as soon as a request answers (live read)', () => {
    const id = freshId();
    recordRelayOutcome(id, connErr());
    expect(getWalletHealth(id, true)).toBe('degraded');
    recordRelayOutcome(id); // answered
    expect(getWalletHealth(id, true)).toBe('responsive');
  });
});

describe('checking state — green only after a real wallet reply (#1768)', () => {
  const T0 = 1_700_000_000_000;

  it('starts neutral: an open socket with no failures is checking, not responsive', () => {
    const id = freshId();
    expect(getWalletHealth(id, true, T0)).toBe('checking');
  });

  it('turns responsive on a wallet reply (result or wallet-level error)', () => {
    const id = freshId();
    markRelayResponsive(id, T0);
    expect(getWalletHealth(id, true, T0 + 1_000)).toBe('responsive');

    const id2 = freshId();
    recordRelayOutcome(id2, walletErr('NOT_IMPLEMENTED')); // wallet answered with an error
    expect(getWalletHealth(id2, true)).toBe('responsive');
  });

  it('decays back to checking once the last reply is older than the freshness window', () => {
    const id = freshId();
    markRelayResponsive(id, T0);
    expect(getWalletHealth(id, true, T0 + WALLET_REPLY_FRESH_MS - 1)).toBe('responsive');
    expect(getWalletHealth(id, true, T0 + WALLET_REPLY_FRESH_MS)).toBe('checking');
  });

  it('goes back to checking after a reconnect (fresh socket proves nothing)', () => {
    const id = freshId();
    markRelayResponsive(id, T0);
    resetWalletReply(id);
    expect(getWalletHealth(id, true, T0 + 1_000)).toBe('checking');
  });

  it('keeps amber / red exactly as before', () => {
    const id = freshId();
    markRelayResponsive(id, T0);
    recordRelayOutcome(id, connErr()); // a timeout after a reply → amber, not green
    expect(getWalletHealth(id, true)).toBe('degraded');
    expect(getWalletHealth(id, false)).toBe('disconnected');
    // A stale wallet whose probe then times out reads amber, not checking.
    const id2 = freshId();
    recordRelayOutcome(id2, connErr());
    expect(getWalletHealth(id2, true, T0 + WALLET_REPLY_FRESH_MS * 10)).toBe('degraded');
  });

  it('clearWalletLiveness forgets the reply (wallet removed)', () => {
    const id = freshId();
    markRelayResponsive(id, T0);
    clearWalletLiveness(id);
    expect(getWalletHealth(id, true, T0)).toBe('checking');
  });
});

describe('shouldProbeWallet (#1768)', () => {
  const T0 = 1_700_000_000_000;

  it('probes a wallet that has never answered', () => {
    expect(shouldProbeWallet(freshId(), T0)).toBe(true);
  });

  it('does not probe while the last reply is recent', () => {
    const id = freshId();
    markRelayResponsive(id, T0);
    expect(shouldProbeWallet(id, T0 + WALLET_PROBE_AFTER_MS - 1)).toBe(false);
    expect(shouldProbeWallet(id, T0 + WALLET_PROBE_AFTER_MS)).toBe(true);
  });

  it('probes a minute before the freshness window lapses, so a live wallet stays green', () => {
    expect(WALLET_PROBE_AFTER_MS).toBeLessThan(WALLET_REPLY_FRESH_MS);
  });

  it('throttles repeat probes to one per WALLET_PROBE_AFTER_MS', () => {
    const id = freshId();
    markWalletProbed(id, T0);
    expect(shouldProbeWallet(id, T0 + 30_000)).toBe(false);
    expect(shouldProbeWallet(id, T0 + WALLET_PROBE_AFTER_MS)).toBe(true);
  });
});

describe('subscribeWalletHealth (#1768)', () => {
  it('notifies on replies, failures, rate limits and resets; stops after unsubscribe', () => {
    const id = freshId();
    const seen: string[] = [];
    const unsubscribe = subscribeWalletHealth((walletId) => seen.push(walletId));
    recordRelayOutcome(id);
    recordRelayOutcome(id, connErr());
    recordRateLimited(id);
    resetWalletReply(id);
    expect(seen).toEqual([id, id, id, id]);
    unsubscribe();
    recordRelayOutcome(id);
    expect(seen).toHaveLength(4);
  });

  it('a throwing listener does not break request bookkeeping', () => {
    const id = freshId();
    const unsubscribe = subscribeWalletHealth(() => {
      throw new Error('ui blew up');
    });
    expect(() => recordRelayOutcome(id)).not.toThrow();
    expect(getWalletHealth(id, true)).toBe('responsive');
    unsubscribe();
  });
});

describe('only real wallet answers turn the card green (#1768 review)', () => {
  it("counts the SDK's own reply timeout as unanswered, not as a reply (the outage bug)", () => {
    const id = freshId();
    recordRelayOutcome(id, sdkReplyTimeout());
    expect(getWalletHealth(id, true)).toBe('degraded');
    recordRelayOutcome(id, sdkErr('publish timeout: abc', 'INTERNAL'));
    recordRelayOutcome(id, sdkErr('failed to publish: boom', 'INTERNAL'));
    expect(isRelayDead(id)).toBe(true);
  });

  it('a local error (no NIP-47 code) clears failures as before but does not turn green', () => {
    const id = freshId();
    recordRelayOutcome(id, connErr());
    recordRelayOutcome(id, new Error('Not connected'));
    expect(isRelayDead(id)).toBe(false);
    expect(getWalletHealth(id, true)).toBe('checking');
  });

  it('recordWalletReply credits results and wallet errors only', () => {
    const ok = freshId();
    recordWalletReply(ok);
    expect(getWalletHealth(ok, true)).toBe('responsive');

    const walletError = freshId();
    recordWalletReply(walletError, walletErr('INSUFFICIENT_BALANCE'));
    expect(getWalletHealth(walletError, true)).toBe('responsive');

    for (const err of [sdkReplyTimeout(), connErr(), new Error('Not connected')]) {
      const id = freshId();
      recordWalletReply(id, err);
      // Ignored entirely: no green, and no failure counted either.
      expect(getWalletHealth(id, true)).toBe('checking');
    }
  });

  it('trackWalletReply credits a resolved call and rethrows failures', async () => {
    const id = freshId();
    await expect(trackWalletReply(id, async () => 42)).resolves.toBe(42);
    expect(getWalletHealth(id, true)).toBe('responsive');

    const id2 = freshId();
    const timeout = sdkReplyTimeout();
    await expect(
      trackWalletReply(id2, async () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);
    expect(getWalletHealth(id2, true)).toBe('checking');
  });
});
