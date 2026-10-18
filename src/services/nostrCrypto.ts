/**
 * Crypto facade — single seam for all local NIP-44 / schnorr operations.
 *
 * Why this file exists
 * --------------------
 * Stage 1a of epic #1036 (native-crypto): extract every call site that
 * performs local crypto (nip44 encrypt/decrypt, schnorr sign/verify via
 * finalizeEvent/verifyEvent, event hashing) behind a single module so that
 * Stage 1b can swap the implementation to rust-nostr FFI without touching
 * the rest of the codebase — one file to change, zero business logic to
 * re-verify.
 *
 * What lives here
 * ---------------
 * Only LOCAL crypto operations. The Amber (NIP-55 IPC) and NIP-46 (bunker
 * relay-RPC) paths are NOT crypto we run locally — they delegate to an
 * external signer and stay in their own service files untouched.
 *
 * Benchmark harness
 * -----------------
 * In dev builds (`__DEV__`) or when EXPO_PUBLIC_KEEP_PERF_LOGS=1, each
 * wrapped operation records a timing sample. A periodic summary (at most
 * once per 60 s) logs:
 *
 *   [PerfBlock] nostrCrypto nip44Decrypt n=42 p50=1ms p95=3ms
 *
 * Overhead on the hot path: one performance.now() pair + one array push per
 * call. No logging on the hot path itself.
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import * as nip44 from 'nostr-tools/nip44';
import {
  finalizeEvent,
  getEventHash,
  verifiedSymbol,
  verifyEvent,
  type Event as NostrEvent,
  type VerifiedEvent,
  type UnsignedEvent,
} from 'nostr-tools/pure';

import { getNostrNative, type NostrNativeApi } from '../../modules/nostr-native';
import { assertNotWrapOnlyKind } from '../utils/wrapOnlyKinds';

// ---------------------------------------------------------------------------
// Perf gate — active in dev (__DEV__) AND in EXPO_PUBLIC_KEEP_PERF_LOGS
// preview APKs, so the benchmark markers fire in both; production release
// builds (neither set) skip the sampling entirely.
// ---------------------------------------------------------------------------
const PERF_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_KEEP_PERF_LOGS === '1';

// ---------------------------------------------------------------------------
// Native routing (Stage 2 M1, #1046) — rust-nostr via modules/nostr-native.
//
// EXPO_PUBLIC_NATIVE_CRYPTO=1 routes the sk+pk-shaped operations below to
// the native module when it is linked (Android + iOS dev/EAS builds);
// everything else — and every platform where the module is absent — keeps the
// exact JS path. EXPO_PUBLIC_NATIVE_CRYPTO_XCHECK=1 additionally runs BOTH
// implementations per op in dev and logs any divergence loudly.
//
// Both env literals are inlined at bundle time, so a normal build (flags
// unset) keeps today's JS behaviour with zero routing overhead beyond one
// boolean check. The conversation-key-shaped nip44Decrypt/nip44Encrypt
// cannot route natively (rust-nostr's FFI derives the conversation key
// internally from sk+pk and does not accept a raw key), which is why the
// sk+pk wrappers below exist and call sites prefer them.
// ---------------------------------------------------------------------------

// Build-time enable: the env literal is inlined at bundle time. When set it
// force-enables native routing for the whole build; the runtime Settings
// pref (#1057) can only ever turn native ON in addition to it, never override
// it off — so a build compiled with the flag stays native regardless of pref.
const ENV_NATIVE_CRYPTO = process.env.EXPO_PUBLIC_NATIVE_CRYPTO === '1';

const flags = {
  native: ENV_NATIVE_CRYPTO,
  xcheck: __DEV__ && process.env.EXPO_PUBLIC_NATIVE_CRYPTO_XCHECK === '1',
};

/**
 * Apply the persisted tester preference (#1057) to routing. Called ONCE at
 * startup (index.ts) after the pref hydrates, before warmUpNativeCrypto().
 * `flags.native` becomes `EXPO_PUBLIC_NATIVE_CRYPTO === '1' || <pref>`, so the
 * env flag always wins and the pref can only add native, never remove it.
 *
 * This is the ONLY runtime path that flips routing — deliberately not called
 * when the Settings toggle changes (that just writes the pref; the row carries
 * a "restart to apply" caption), so there is no mid-session re-routing and the
 * crypto hot path never consults AsyncStorage.
 */
export function setNativeCryptoEnabled(enabled: boolean): void {
  flags.native = ENV_NATIVE_CRYPTO || enabled;
}

// Warm-up latch — routing is permitted ONLY after warmUpNativeCrypto() has
// resolved successfully (the JNA + libnostr_sdk_ffi.so load actually worked).
// It defaults false, so: (a) an op that runs before warm-up resolves stays on
// JS, and (b) a module that is linked but fails to load (dlopen/JNA failure)
// never routes real crypto into a broken path — the catch below leaves this
// false for the rest of the session. warmUpNativeCrypto() is fire-and-forgotten
// at startup (see index.ts) — it need not be awaited; the false default keeps
// first ops on JS until it latches, so there is no unready-native window.
let nativeReady = false;

// Single-entry hex cache for the viewer's secret key. The native FFI takes the
// key as hex, but the sk is a stable reference across a session (from the
// memoised key cache), so re-running bytesToHex on every decrypt/encrypt — which
// inbox ingest does thousands of times — is avoidable overhead that erodes the
// native speed-up. Keyed on reference identity: a new sk (account switch)
// misses and refreshes.
let cachedSk: Uint8Array | null = null;
let cachedSkHex = '';
function skHex(sk: Uint8Array): string {
  if (sk !== cachedSk) {
    cachedSk = sk;
    cachedSkHex = bytesToHex(sk);
  }
  return cachedSkHex;
}

/** @internal Test use only — flip routing/cross-check/warm-up latch without env. */
export function __setNostrCryptoFlagsForTests(next: {
  native?: boolean;
  xcheck?: boolean;
  ready?: boolean;
}): void {
  if (!__DEV__) return;
  if (next.native !== undefined) flags.native = next.native;
  if (next.xcheck !== undefined) flags.xcheck = next.xcheck;
  if (next.ready !== undefined) nativeReady = next.ready;
}

// Routing gate: the native module is used ONLY when the build-time env flag is
// set AND warm-up has succeeded (nativeReady). getNostrNative() adds the third
// guard — it returns null on unsupported platforms and when the module isn't
// linked.
function nativeIfActive(): NostrNativeApi | null {
  if (!flags.native || !nativeReady) return null;
  return getNostrNative();
}

/** True when sk+pk-shaped ops are actually routing to the native module. */
export function isNativeCryptoActive(): boolean {
  return nativeIfActive() !== null;
}

/**
 * Capability probe (#1057) — CAN this device ever run native crypto, ignoring
 * whether it's enabled or warmed up. getNostrNative() already returns null
 * on unsupported platforms and when the module isn't linked (Expo Go, web,
 * stale dev client), so this is the honest "is the native module present"
 * signal used to enable/disable the Settings toggle.
 *
 * Distinct from isNativeCryptoActive(): a tester can toggle native ON on a
 * capable device (available=true) yet still see active=false until they
 * restart and warm-up latches routing for the new session.
 */
export function isNativeCryptoAvailable(): boolean {
  return getNostrNative() !== null;
}

/**
 * Pays the native module's one-time JNA + .so load off the JS thread and
 * latches routing on: sets nativeReady=true ONLY when warm-up resolves true,
 * so every crypto op stays on the pure-JS path until the native module has
 * proven it can load. Resolves false (never rejects) — a linked-but-broken
 * module (dlopen/JNA failure), a disabled env flag, or an unsupported platform
 * all leave nativeReady false and keep callers on JS for the session.
 *
 * Fire-and-forgotten at startup (index.ts) to warm native routing; it does
 * not need awaiting — until it resolves, nativeReady's false default keeps
 * first ops on JS, so there is no unready-native window.
 */
export async function warmUpNativeCrypto(): Promise<boolean> {
  if (!flags.native) return false;
  // Reach the module directly (not via nativeIfActive, which gates on the very
  // latch we're about to set) — still platform/linkage-guarded by getNostrNative.
  const native = getNostrNative();
  if (!native) return false;
  try {
    nativeReady = (await native.warmUp()) === true;
    return nativeReady;
  } catch {
    nativeReady = false;
    return false;
  }
}

// Never log key material or plaintext — lengths/verdicts are enough to find
// a divergence without leaking a DM into logcat.
function reportMismatch(op: string, detail: string): void {
  console.error(
    `[NostrCrypto] XCHECK MISMATCH op=${op} ${detail} — native and JS implementations disagree`,
  );
}

// ---------------------------------------------------------------------------
// Sliding window — keeps the most recent MAX_SAMPLES timing samples per op
// (oldest sample evicted via shift when the window is full).
// ---------------------------------------------------------------------------
const MAX_SAMPLES = 200;

interface OpStats {
  samples: number[];
  count: number;
  /** `count` at the last emitted summary — ops with no new samples since
   *  then are skipped, so a long-idle op doesn't log forever. */
  countAtLastSummary: number;
}

const stats: Record<string, OpStats> = {
  nip44Decrypt: { samples: [], count: 0, countAtLastSummary: 0 },
  nip44Encrypt: { samples: [], count: 0, countAtLastSummary: 0 },
  schnorrSign: { samples: [], count: 0, countAtLastSummary: 0 },
  schnorrVerify: { samples: [], count: 0, countAtLastSummary: 0 },
  eventHash: { samples: [], count: 0, countAtLastSummary: 0 },
};

/** Append one timing sample, evicting oldest when window is full. */
function recordSample(op: string, ms: number): void {
  const s = stats[op];
  if (!s) return;
  s.count += 1;
  if (s.samples.length >= MAX_SAMPLES) s.samples.shift();
  s.samples.push(ms);
}

/** Compute p50 and p95 from an unsorted sample array (sorts a copy). */
function percentiles(arr: number[]): { p50: number; p95: number } {
  if (arr.length === 0) return { p50: 0, p95: 0 };
  const sorted = arr.slice().sort((a, b) => a - b);
  // (len - 1) * p matches the repo's existing percentile convention
  // (friendsOfFriendsService.bench.ts) — `len * p` skews indexes high.
  const p50 = sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0;
  const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0;
  return { p50, p95 };
}

// ---------------------------------------------------------------------------
// Summary logger — fires at most once per 60 s, only when ops occurred.
// ---------------------------------------------------------------------------
const SUMMARY_INTERVAL_MS = 60_000;
let lastSummaryAt = 0;
let summaryScheduled = false;

function scheduleSummary(): void {
  if (!PERF_ENABLED || summaryScheduled) return;
  summaryScheduled = true;
  const delay = Math.max(0, SUMMARY_INTERVAL_MS - (Date.now() - lastSummaryAt));
  setTimeout(() => {
    summaryScheduled = false;
    const now = Date.now();
    if (now - lastSummaryAt < SUMMARY_INTERVAL_MS) return;
    lastSummaryAt = now;
    for (const [op, s] of Object.entries(stats)) {
      if (s.count === s.countAtLastSummary) continue;
      s.countAtLastSummary = s.count;
      const { p50, p95 } = percentiles(s.samples);
      console.log(
        `[PerfBlock] nostrCrypto ${op} n=${s.count} p50=${p50}ms p95=${p95}ms (window=${s.samples.length})`,
      );
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Instrumented wrappers
// ---------------------------------------------------------------------------

/**
 * NIP-44 v2: derive shared conversation key from a secret key and a peer's
 * public key. Called once per decrypt/encrypt pair; result may be cached by
 * callers when processing multiple layers (as nip17Unwrap does).
 */
export function nip44GetConversationKey(secretKey: Uint8Array, peerPublicKey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(secretKey, peerPublicKey);
}

/**
 * NIP-44 v2 decrypt. Throws on invalid ciphertext (caller must try/catch).
 * Benchmarked as the dominant hot-path cost during inbox ingest.
 */
export function nip44Decrypt(ciphertext: string, conversationKey: Uint8Array): string {
  if (!PERF_ENABLED) {
    return nip44.v2.decrypt(ciphertext, conversationKey);
  }
  const t0 = performance.now();
  const result = nip44.v2.decrypt(ciphertext, conversationKey);
  recordSample('nip44Decrypt', performance.now() - t0);
  scheduleSummary();
  return result;
}

/**
 * NIP-44 v2 encrypt.
 */
export function nip44Encrypt(plaintext: string, conversationKey: Uint8Array): string {
  if (!PERF_ENABLED) {
    return nip44.v2.encrypt(plaintext, conversationKey);
  }
  const t0 = performance.now();
  const result = nip44.v2.encrypt(plaintext, conversationKey);
  recordSample('nip44Encrypt', performance.now() - t0);
  scheduleSummary();
  return result;
}

/**
 * sk+pk-shaped NIP-44 decrypt: derive the conversation key and decrypt in
 * one call. This is the native-routable twin of nip44Decrypt — rust-nostr's
 * FFI takes (secretKey, peerPubkey) and derives the conversation key
 * internally. Throws on invalid ciphertext in BOTH implementations; native
 * errors are NOT retried on JS (that would double the cost of every junk
 * wrap a relay feeds us — callers already catch-and-skip).
 */
export function nip44DecryptFrom(
  ciphertext: string,
  secretKey: Uint8Array,
  peerPublicKey: string,
): string {
  // Normalise the pubkey up front so the native and JS-fallback paths derive
  // an identical conversation key regardless of routing (an uppercase pubkey
  // must not decrypt differently, and xcheck must compare like with like).
  const pub = peerPublicKey.toLowerCase();
  const native = nativeIfActive();
  if (!native) {
    return nip44Decrypt(ciphertext, nip44GetConversationKey(secretKey, pub));
  }
  // Gate the timestamp on PERF_ENABLED — t0 is only read inside the
  // PERF_ENABLED sample guard below, so skip the call on the hot path when
  // logging is off (mirrors the pure-JS wrappers' early-return).
  const t0 = PERF_ENABLED ? performance.now() : 0;
  let result: string | undefined;
  let nativeError: unknown;
  try {
    result = native.nip44Decrypt(skHex(secretKey), pub, ciphertext);
  } catch (error) {
    nativeError = error;
  }
  // Sample successful decrypts only, mirroring the JS path where a throw
  // aborts before recordSample — keeps native/JS p50/p95 comparable.
  if (PERF_ENABLED && nativeError === undefined) {
    recordSample('nip44Decrypt', performance.now() - t0);
    scheduleSummary();
  }
  if (flags.xcheck) {
    let jsResult: string | undefined;
    let jsError: unknown;
    try {
      jsResult = nip44.v2.decrypt(ciphertext, nip44GetConversationKey(secretKey, pub));
    } catch (error) {
      jsError = error;
    }
    if (nativeError === undefined && jsError === undefined && result !== jsResult) {
      reportMismatch(
        'nip44DecryptFrom',
        `plaintext differs (len ${result?.length} vs ${jsResult?.length})`,
      );
    } else if ((nativeError === undefined) !== (jsError === undefined)) {
      reportMismatch(
        'nip44DecryptFrom',
        `one impl threw (native: ${nativeError ? 'threw' : 'ok'}, js: ${jsError ? 'threw' : 'ok'})`,
      );
    }
  }
  if (nativeError !== undefined) throw nativeError;
  return result as string;
}

/**
 * Convenience wrapper: derive conversation key from sk+pk and encrypt in one
 * call. Matches `nip44EncryptForRecipient` in nostrService.ts. Routes to the
 * native module when active; NIP-44 payloads are nonce-randomised so the two
 * implementations can't be compared byte-for-byte — the cross-check instead
 * requires the JS impl to decrypt the native payload back to the plaintext.
 */
export function nip44EncryptForRecipient(
  plaintext: string,
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
): string {
  // Normalise up front so JS-fallback and native derive the same conversation
  // key regardless of routing (see nip44DecryptFrom).
  const pub = recipientPubkey.toLowerCase();
  const native = nativeIfActive();
  if (!native) {
    return nip44Encrypt(plaintext, nip44GetConversationKey(senderSecretKey, pub));
  }
  const t0 = PERF_ENABLED ? performance.now() : 0;
  const payload = native.nip44Encrypt(skHex(senderSecretKey), pub, plaintext);
  if (PERF_ENABLED) {
    recordSample('nip44Encrypt', performance.now() - t0);
    scheduleSummary();
  }
  if (flags.xcheck) {
    try {
      const roundTrip = nip44.v2.decrypt(payload, nip44GetConversationKey(senderSecretKey, pub));
      if (roundTrip !== plaintext) {
        reportMismatch(
          'nip44EncryptForRecipient',
          'js-decrypt(native-payload) differs from plaintext',
        );
      }
    } catch (error) {
      reportMismatch(
        'nip44EncryptForRecipient',
        `js-decrypt(native-payload) threw: ${(error as Error)?.message ?? 'unknown'}`,
      );
    }
  }
  return payload;
}

/**
 * Sign an unsigned event with a secret key (schnorr). Wraps
 * nostr-tools' `finalizeEvent`; benchmarked as schnorrSign.
 */
export function nostrFinalizeEvent(
  event: { kind: number; created_at: number; tags: string[][]; content: string },
  secretKey: Uint8Array,
): VerifiedEvent {
  // Gamma order kinds 16/17 are NIP-17 rumors only — never signed.
  assertNotWrapOnlyKind(event.kind, 'sign');
  if (!PERF_ENABLED) {
    return finalizeEvent(event, secretKey);
  }
  const t0 = performance.now();
  const result = finalizeEvent(event, secretKey);
  recordSample('schnorrSign', performance.now() - t0);
  scheduleSummary();
  return result;
}

/**
 * Verify a signed Nostr event (schnorr signature check). Wraps
 * nostr-tools' `verifyEvent`; benchmarked as schnorrVerify.
 *
 * Native path replicates verifyEvent's exact semantics: memoised via
 * nostr-tools' verifiedSymbol (so SimplePool and our pool.verifyEvent
 * override still see the marker), id must equal the recomputed hash, and
 * any malformed input verifies false rather than throwing. Only the
 * schnorr check itself (the ~25 ms part) moves to rust-nostr — the
 * canonical-serialisation sha256 stays in JS (getEventHash, ~µs).
 */
export function nostrVerifyEvent(event: NostrEvent): event is VerifiedEvent {
  const memoised = event[verifiedSymbol];
  if (typeof memoised === 'boolean') return memoised;
  const native = nativeIfActive();
  if (native) {
    const t0 = PERF_ENABLED ? performance.now() : 0;
    let valid = false;
    try {
      const hash = getEventHash(event);
      valid =
        hash === event.id &&
        native.schnorrVerify(event.sig.toLowerCase(), hash, event.pubkey.toLowerCase());
    } catch {
      valid = false;
    }
    if (PERF_ENABLED) {
      recordSample('schnorrVerify', performance.now() - t0);
      scheduleSummary();
    }
    if (flags.xcheck) {
      // Compare BEFORE stamping the symbol so the JS verifier actually runs.
      const jsValid = verifyEvent({ ...event });
      if (jsValid !== valid) {
        reportMismatch('nostrVerifyEvent', `native=${valid} js=${jsValid} id=${event.id}`);
      }
    }
    event[verifiedSymbol] = valid;
    return valid;
  }
  if (!PERF_ENABLED) {
    return verifyEvent(event);
  }
  const t0 = performance.now();
  const result = verifyEvent(event);
  recordSample('schnorrVerify', performance.now() - t0);
  scheduleSummary();
  return result;
}

/**
 * Hash a Nostr event to produce its id (SHA-256 of the canonical
 * serialisation). Wraps nostr-tools' `getEventHash`.
 */
export function nostrGetEventHash(
  event: Pick<UnsignedEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>,
): string {
  if (!PERF_ENABLED) {
    return getEventHash(event as UnsignedEvent);
  }
  const t0 = performance.now();
  const result = getEventHash(event as UnsignedEvent);
  recordSample('eventHash', performance.now() - t0);
  scheduleSummary();
  return result;
}

// ---------------------------------------------------------------------------
// Test-only exports (prefixed __) — force a summary flush, or reset state.
// ---------------------------------------------------------------------------

/** @internal Test use only — reset all accumulated stats. */
export function __resetStats(): void {
  for (const s of Object.values(stats)) {
    s.samples = [];
    s.count = 0;
    s.countAtLastSummary = 0;
  }
  lastSummaryAt = 0;
  summaryScheduled = false;
}

/** @internal Test use only — force a summary flush right now. */
export function __flushSummary(): void {
  lastSummaryAt = 0;
  summaryScheduled = false;
  for (const [op, s] of Object.entries(stats)) {
    if (s.count === 0) continue;
    s.countAtLastSummary = s.count;
    const { p50, p95 } = percentiles(s.samples);
    console.log(
      `[PerfBlock] nostrCrypto ${op} n=${s.count} p50=${p50}ms p95=${p95}ms (window=${s.samples.length})`,
    );
  }
}

/** @internal Test use only — return a snapshot of accumulated stats. */
export function __getStats(): Record<string, { count: number; samples: number[] }> {
  const snapshot: Record<string, { count: number; samples: number[] }> = {};
  for (const [op, s] of Object.entries(stats)) {
    snapshot[op] = { count: s.count, samples: s.samples.slice() };
  }
  return snapshot;
}
