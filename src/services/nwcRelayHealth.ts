/**
 * Per-wallet relay-health bookkeeping for NWC (Nostr Wallet Connect).
 *
 * Extracted from `nwcService` (#785) so the service stays under the file-size
 * cap and so the health signal can be unit-tested in isolation. Tracks two
 * independent back-off mechanisms keyed by walletId:
 *
 *  1. **Reply-timeout cooldown** (`relayCooldownUntil`) — a relay that stops
 *     answering NIP-47 requests (reply-timeout / connection error) is parked
 *     with an escalating back-off so reconnect/poll callers stop hammering a
 *     dead relay every tick (#654/#656). ANY answered request clears it.
 *
 *  2. **Rate-limit back-off** (`relayRateLimitUntil`) — when the relay itself
 *     pushes back with a `rate-limited` / `too many` / `slow down` style
 *     rejection (e.g. CoinOS under publish flood, #785), we park it on its own
 *     escalating timer. CRITICALLY this is NOT cleared by a successful read:
 *     rate-limiting is about publish *volume*, not backend health, so a lucky
 *     answered request must not reset the back-off. It clears only when its own
 *     timer lapses.
 */

import { isUnansweredError, isWalletAnswer } from './nwcErrors';

// Per-wallet count of consecutive NIP-47 requests that got no answer from the
// relay (reply-timeout / connection error). A WebSocket can stay `connected`
// while the relay hangs or the link dies (no clean close → TCP lingers in
// ESTABLISHED for ~2h), so transport state alone reports a dead relay as
// "Connected" (#654). isWalletConnected() treats a run of unanswered requests
// as not-connected so the UI is honest and the reconnect path kicks in.
const relayFailures = new Map<string, number>();
// Per-wallet timestamp until which a dead/timing-out relay is "parked" — once it
// looks dead we back off with an escalating cooldown instead of retrying every
// reconnect/poll tick (the churn behind the lag when a relay goes offline, #656).
const relayCooldownUntil = new Map<string, number>();
// Per-wallet rate-limit back-off: timestamp until which the relay is parked
// because it told us to slow down, plus a strike count driving the escalation.
// Tracked separately from the reply-timeout cooldown because a successful read
// must NOT clear it (#785).
const relayRateLimitUntil = new Map<string, number>();
const relayRateLimitStrikes = new Map<string, number>();
// Per-wallet timestamp of the last time the WALLET SERVICE actually answered a
// NIP-47 request (a result or a wallet-level error). An open relay socket with
// no failures is NOT evidence the wallet is up — the wallet backend can be
// down for hours while the relay socket stays healthy (#1768). Green
// "Connected" requires an answer within `WALLET_REPLY_FRESH_MS`.
const lastWalletReplyAt = new Map<string, number>();
// Per-wallet timestamp of the last liveness probe we sent, so the watchdog
// can't probe more often than `WALLET_PROBE_AFTER_MS` (#1768).
const lastWalletProbeAt = new Map<string, number>();

// Listeners told "this wallet's health inputs just changed" so the watchdog can
// re-read `getWalletHealth` promptly (coalesced) instead of waiting up to 30 s
// for its next tick — otherwise a wallet that answered at startup would sit on
// grey "Checking…" for half a minute (#1768).
const healthListeners = new Set<(walletId: string) => void>();
function notifyHealthChanged(walletId: string): void {
  for (const listener of healthListeners) {
    try {
      listener(walletId);
    } catch {
      // a UI-side listener throwing must not break request bookkeeping
    }
  }
}

/** Subscribe to health-input changes; returns the unsubscribe function. */
export function subscribeWalletHealth(listener: (walletId: string) => void): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

export const RELAY_DEAD_AFTER_FAILURES = 3;
export const RELAY_COOLDOWN_BASE_MS = 30_000;
export const RELAY_COOLDOWN_MAX_MS = 5 * 60_000;
/**
 * How long a wallet reply keeps the card green (#1768). Past this with no
 * further answer the health decays to neutral `checking` until the next
 * request (a balance refresh or the watchdog probe) answers.
 */
export const WALLET_REPLY_FRESH_MS = 5 * 60_000;
/**
 * Idle age after which the watchdog sends a liveness probe (one `get_balance`),
 * and the minimum gap between probes. A minute under the freshness window so a
 * wallet that keeps answering stays green without flickering grey (#1768).
 */
export const WALLET_PROBE_AFTER_MS = 4 * 60_000;

/**
 * Does this error look like the relay rate-limiting / throttling / temp-banning
 * us? CoinOS's relay returns `rate-limited` when flooded with retries; other
 * relays phrase it as "too many", "slow down", "blocked", etc. Matching this
 * lets us back off publish volume instead of discarding the signal and showing
 * a green "Connected" while every request times out (#785).
 */
export function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /rate.?limit|too many|too fast|slow down|temp.?ban|throttl|blocked/i.test(msg);
}

/**
 * Reset the failure count AND clear the reply-timeout cooldown — on a fresh
 * connect or any answered request.
 *
 * Deliberately does NOT touch the rate-limit back-off: that's about publish
 * volume, not whether the relay just answered a read, so a lucky successful
 * request must not reset it (#785). The rate-limit timer clears itself in
 * `isRelayInCooldown` once it lapses.
 */
export function markRelayResponsive(walletId: string, now: number = Date.now()): void {
  relayFailures.set(walletId, 0);
  relayCooldownUntil.delete(walletId);
  lastWalletReplyAt.set(walletId, now);
  notifyHealthChanged(walletId);
}

/**
 * A fresh relay socket was just opened (connect / reconnect): forget the last
 * wallet reply so the card shows neutral `checking` until the new connection
 * actually gets an answer (#1768). Like the failure counter (#654), a socket
 * open proves nothing about whether the wallet service is up.
 */
export function resetWalletReply(walletId: string): void {
  lastWalletReplyAt.delete(walletId);
  notifyHealthChanged(walletId);
}

/**
 * Forget the reply / probe timestamps — on `disconnect` (wallet removed or
 * identity switched) so the Maps follow the wallet lifecycle. Deliberately
 * leaves the failure counter and back-offs alone (same as before #1768).
 */
export function clearWalletLiveness(walletId: string): void {
  lastWalletReplyAt.delete(walletId);
  lastWalletProbeAt.delete(walletId);
}

/**
 * Should the watchdog send a liveness probe to this wallet now (#1768)? Only
 * when the wallet hasn't answered for `WALLET_PROBE_AFTER_MS` AND we haven't
 * probed it within that same gap — so an idle foregrounded app costs at most
 * one `get_balance` per wallet per ~4 min. Callers must still skip a parked
 * relay (`isRelayInCooldown`) and a handshake in flight; this is just the
 * age/throttle half so it stays pure and testable.
 */
export function shouldProbeWallet(walletId: string, now: number = Date.now()): boolean {
  const lastReply = lastWalletReplyAt.get(walletId);
  if (lastReply !== undefined && now - lastReply < WALLET_PROBE_AFTER_MS) return false;
  const lastProbe = lastWalletProbeAt.get(walletId);
  if (lastProbe !== undefined && now - lastProbe < WALLET_PROBE_AFTER_MS) return false;
  return true;
}

/** Record that a liveness probe was just sent (throttles `shouldProbeWallet`). */
export function markWalletProbed(walletId: string, now: number = Date.now()): void {
  lastWalletProbeAt.set(walletId, now);
}

/**
 * Record the outcome of a NIP-47 request against its relay-health counter.
 * Only a reply-timeout / connection error (the relay never answered —
 * including the SDK's own reply/publish timeouts, `isUnansweredError`, #1768)
 * counts toward "dead". ANY answer resets it — including a wallet-level error such as
 * "method not supported" (NWC wallets that don't implement `get_balance`) or
 * "insufficient funds". So this is capability-agnostic: it keys off whether the
 * relay *responded*, not which method succeeded, and never false-disconnects a
 * wallet that simply lacks a method (#654). Past the dead threshold, park the
 * relay with an escalating backoff (#656).
 */
export function recordRelayOutcome(walletId: string, error?: unknown): void {
  if (error !== undefined && isUnansweredError(error)) {
    const failures = (relayFailures.get(walletId) ?? 0) + 1;
    relayFailures.set(walletId, failures);
    if (failures >= RELAY_DEAD_AFTER_FAILURES) {
      const backoff = Math.min(
        RELAY_COOLDOWN_BASE_MS * 2 ** (failures - RELAY_DEAD_AFTER_FAILURES),
        RELAY_COOLDOWN_MAX_MS,
      );
      relayCooldownUntil.set(walletId, Date.now() + backoff);
    }
    notifyHealthChanged(walletId);
  } else if (error === undefined || isWalletAnswer(error)) {
    markRelayResponsive(walletId);
  } else {
    // A local error (no NIP-47 `code`, e.g. a decode/guard throw): as before it
    // doesn't count toward "dead", but it isn't proof the wallet answered
    // either, so it must not turn the card green (#1768).
    relayFailures.set(walletId, 0);
    relayCooldownUntil.delete(walletId);
    notifyHealthChanged(walletId);
  }
}

/**
 * Credit a real wallet answer from a call that doesn't otherwise feed relay
 * health (pay / list / lookup / get_info). Success-only on purpose: a result,
 * or a NIP-47 wallet error, stamps the reply (→ green). Timeouts and local
 * errors are ignored HERE — those callers have their own poll cadences and
 * ceilings (e.g. the 2.5 s lookup race), and counting them toward "dead" would
 * flap the card; the dead/amber signal stays owned by get_balance /
 * make_invoice / the connect probe (#654, #1768).
 */
export function recordWalletReply(walletId: string, error?: unknown): void {
  if (error === undefined || isWalletAnswer(error)) markRelayResponsive(walletId);
}

/** Run a NIP-47 call and credit its answer via `recordWalletReply`. */
export async function trackWalletReply<T>(walletId: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    recordWalletReply(walletId);
    return result;
  } catch (error) {
    recordWalletReply(walletId, error);
    throw error;
  }
}

/**
 * Park the relay because it rate-limited us. Each strike doubles the back-off
 * (30s, 60s, 120s, … capped at 5 min). Unlike the reply-timeout cooldown this
 * is NOT cleared by a successful read — only by its own timer lapsing (#785).
 */
export function recordRateLimited(walletId: string): void {
  const strikes = (relayRateLimitStrikes.get(walletId) ?? 0) + 1;
  relayRateLimitStrikes.set(walletId, strikes);
  const backoff = Math.min(RELAY_COOLDOWN_BASE_MS * 2 ** (strikes - 1), RELAY_COOLDOWN_MAX_MS);
  relayRateLimitUntil.set(walletId, Date.now() + backoff);
  notifyHealthChanged(walletId);
}

/**
 * True while a relay is parked — either because it stopped answering
 * (reply-timeout cooldown, #656) OR because it rate-limited us (#785).
 * reconnect/poll callers should skip it until the cooldown expires rather than
 * hammering it every tick.
 */
export function isRelayInCooldown(walletId: string): boolean {
  const now = Date.now();
  let parked = false;

  const until = relayCooldownUntil.get(walletId);
  if (until !== undefined) {
    if (now >= until) {
      // Expired — drop the entry so the Map can't grow unbounded.
      relayCooldownUntil.delete(walletId);
    } else {
      parked = true;
    }
  }

  const rlUntil = relayRateLimitUntil.get(walletId);
  if (rlUntil !== undefined) {
    if (now >= rlUntil) {
      // The rate-limit back-off clears only on its own timer — drop both the
      // timestamp and the strikes so a recovered relay starts fresh AND the
      // Maps don't retain a key forever for any wallet that was ever throttled
      // (#787 review). A missing strikes entry reads as 0 in `recordRateLimited`.
      relayRateLimitUntil.delete(walletId);
      relayRateLimitStrikes.delete(walletId);
    } else {
      parked = true;
    }
  }

  return parked;
}

/**
 * Has the relay stopped answering enough requests to be considered dead? Used
 * by `isWalletConnected` — transport "connected" can lie, so a run of
 * unanswered requests reads as not-connected (#654).
 */
export function isRelayDead(walletId: string): boolean {
  return (relayFailures.get(walletId) ?? 0) >= RELAY_DEAD_AFTER_FAILURES;
}

export type WalletConnectionHealth = 'checking' | 'responsive' | 'degraded' | 'disconnected';

/**
 * Four-state health for the wallet card (#786, #1768):
 *  - `disconnected` (red) — the WebSocket isn't connected;
 *  - `degraded` (amber "Not responding") — connected but the relay is parked
 *    (cooldown/rate-limit) OR has recent reply-timeouts. A LIVE read: it clears
 *    as soon as a request answers, since `markRelayResponsive` zeroes
 *    `relayFailures`;
 *  - `responsive` (green "Connected") — connected AND the wallet service
 *    answered within `WALLET_REPLY_FRESH_MS`;
 *  - `checking` (grey "Checking…") — connected, nothing has failed, but the
 *    wallet hasn't answered recently (fresh start, just reconnected, or idle
 *    past the window). Neutral, not a failure: Send / Receive stay enabled.
 */
export function getWalletHealth(
  walletId: string,
  isWsConnected: boolean,
  now: number = Date.now(),
): WalletConnectionHealth {
  if (!isWsConnected) return 'disconnected';
  if (isRelayInCooldown(walletId) || (relayFailures.get(walletId) ?? 0) > 0) {
    return 'degraded';
  }
  const lastReply = lastWalletReplyAt.get(walletId);
  if (lastReply !== undefined && now - lastReply < WALLET_REPLY_FRESH_MS) return 'responsive';
  return 'checking';
}
