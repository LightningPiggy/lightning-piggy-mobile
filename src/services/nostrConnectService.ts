import { lockRelays } from '../config/testRelayLockdown';
import { activeAccountRelays, watchTestRelayLockdown } from './testRelayRouting';
import { pool } from './nostrPool';
/**
 * NIP-46 ("Nostr Connect" / bunker) signer service.
 *
 * Mirrors the API shape of `amberService.ts` so that NostrContext can
 * branch on `signerType: 'nip46'` and call into the same method names
 * (requestPublicKey, requestEventSignature, requestNip04Encrypt, etc.)
 * without caring about the underlying transport.
 *
 * Where Amber speaks Android Intents (NIP-55) and is therefore Android-
 * only with ~10-50 ms per call, NIP-46 speaks NIP-04 / NIP-44 encrypted
 * DMs over a Nostr relay, runs on every platform that can talk to a
 * relay (notably iOS, where Clave is the canonical signer), and pays
 * ~200-1500 ms per call for the round-trip.
 *
 * See `docs/nip46-clave.adoc` for the pairing flow walkthrough and the
 * comparison table against NIP-55. See issue #283 for the design
 * rationale.
 *
 * Implementation notes
 * --------------------
 * - All signing happens through nostr-tools' `BunkerSigner` class. We
 *   keep a single in-memory instance per session, lazily constructed on
 *   first use from the persisted `Nip46Connection`. NostrContext owns
 *   the persisted object; this service just consumes it.
 * - The `BunkerSigner.signEvent` API takes an `EventTemplate` (no
 *   pubkey, no id, no sig) and returns a `VerifiedEvent`. To match
 *   amberService.requestEventSignature's `(jsonString, eventId,
 *   currentUser) => { signature, event }` signature we wrap and
 *   serialise on the way in/out.
 * - Permission errors from the bunker are normalised to
 *   `NostrConnectError('permission', 'NIP-46 signer denied <method>')` so callers can detect them
 *   and prompt the user to re-pair with broader perms.
 */
import { BunkerSigner, createNostrConnectURI, type BunkerPointer } from 'nostr-tools/nip46';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { Nip46Connection } from '../types/nostr';
import { NostrConnectError, isCiphertextDecryptError } from './signerErrors';

/** Lazily-constructed BunkerSigner. Re-created when the active
 *  connection changes (login / logout / re-pair). */
let _activeSigner: BunkerSigner | null = null;
let lockdownGeneration = 0;
let _activeConnection: Nip46Connection | null = null;
/** In-flight `getSigner()` connect, memoised so a burst of concurrent
 *  requests (e.g. the inbox refresh decrypting a batch of wraps in
 *  parallel right after auto-login, when `_activeSigner` is still null)
 *  shares ONE `connect()` round-trip instead of each building its own
 *  BunkerSigner and leaking N-1 relay subscriptions. Cleared whenever the
 *  active signer is reset (setActiveConnection / adoptPairedSigner) or the
 *  connect rejects. */
let _signerPromise: Promise<BunkerSigner> | null = null;

/** Heuristic for "the bunker rejected this method because the user
 *  didn't grant the corresponding perm". Bunker error shapes vary
 *  across implementations (Clave / nsec.app / Aegis all word it
 *  slightly differently), so we match on the substrings most likely to
 *  appear. False negatives just surface as a generic error to the
 *  caller — no harm done. */
function isPermissionError(err: unknown): boolean {
  // nostr-tools' BunkerSigner rejects with the bunker's raw error string
  // (not an Error), so read the string form as well as `.message`.
  const raw = typeof err === 'string' ? err : ((err as Error)?.message ?? '');
  const msg = raw.toLowerCase();
  return (
    msg.includes('permission') ||
    msg.includes('denied') ||
    msg.includes('not authorized') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden')
  );
}

function wrapPermissionError(method: string, err: unknown): Error {
  if (isPermissionError(err)) {
    return new NostrConnectError('permission', `NIP-46 signer denied ${method}`, err);
  }
  return new NostrConnectError(
    method.endsWith('_decrypt') && isCiphertextDecryptError(err) ? 'decrypt-failed' : 'failed',
    err instanceof Error ? err.message : String(err),
    err,
  );
}

/**
 * Set (or replace) the active connection. Closes any prior signer
 * cleanly so its relay subscription doesn't leak. Idempotent on the
 * same connection object — repeated calls with identical fields are
 * a no-op.
 *
 * Called from NostrContext on:
 *  - app startup (after reading the persisted connection from SecureStore)
 *  - successful pairing (right after the BunkerSigner has connect()ed)
 *  - logout (with `null` to release the relay subscription)
 */
export async function setActiveConnection(connection: Nip46Connection | null): Promise<void> {
  if (
    _activeConnection &&
    connection &&
    _activeConnection.remoteSignerPubkey === connection.remoteSignerPubkey &&
    _activeConnection.userPubkey === connection.userPubkey &&
    _activeConnection.clientSecretKeyHex === connection.clientSecretKeyHex &&
    _activeConnection.relays.join('|') === connection.relays.join('|') &&
    _activeConnection.perms === connection.perms
  ) {
    return;
  }
  if (_activeSigner) {
    try {
      await _activeSigner.close();
    } catch {
      // Best-effort cleanup — ignore close errors so we still
      // transition to the new state.
    }
    _activeSigner = null;
  }
  _signerPromise = null;
  _activeConnection = connection;
}

export function getActiveConnection(): Nip46Connection | null {
  return _activeConnection;
}

/**
 * Lazily construct and return the BunkerSigner for the active
 * connection. Throws if no connection is set.
 *
 * The first call performs a `connect()` round-trip; subsequent calls
 * reuse the open subscription. This is intentional — the bunker keeps
 * a long-lived subscription on the relay and tearing it down per
 * request would add ~200-1500 ms of overhead per signature.
 */
async function getSigner(): Promise<BunkerSigner> {
  if (_activeSigner) return _activeSigner;
  // Coalesce concurrent first-callers onto one connect (see _signerPromise).
  if (_signerPromise) return _signerPromise;
  if (!_activeConnection) {
    throw new NostrConnectError('unavailable', 'NIP-46 signer not connected');
  }
  const connection = _activeConnection;
  const generation = lockdownGeneration;
  const promise = (async () => {
    const pointer: BunkerPointer = {
      pubkey: connection.remoteSignerPubkey,
      relays: lockRelays(connection.relays, connection.userPubkey),
      secret: null,
    };
    const clientSecretKey = hexToBytes(connection.clientSecretKeyHex);
    const signer = BunkerSigner.fromBunker(
      clientSecretKey,
      pointer,
      __DEV__ ? { pool } : undefined,
    );
    // `connect()` is the explicit handshake — it sends a `connect`
    // request through the relay so the bunker registers this session
    // before we start firing signEvent / nip44_encrypt at it. Subsequent
    // requests reuse the subscription opened here.
    try {
      // nostr-tools connect() omits the optional permissions parameter.
      // Reuse only the saved grants: existing pairings are never broadened.
      if (connection.perms) {
        await signer.sendRequest('connect', [
          pointer.pubkey,
          pointer.secret ?? '',
          connection.perms,
        ]);
      } else {
        await signer.connect();
      }
    } catch (e) {
      // If the bunker can't be reached (relay down, bunker app closed,
      // user revoked the connection) surface a clear error rather than
      // letting per-method calls each fail with their own opaque message.
      throw new NostrConnectError(
        'unavailable',
        `NIP-46 signer could not connect: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
    // Guard against a mid-flight `setActiveConnection` (logout / re-pair):
    // if the active connection changed while this handshake was in flight,
    // this signer belongs to the OLD identity. Caching it would leave a
    // stale signer/subscription under the wrong connection and re-enable
    // signing after logout. Close it and fail this attempt instead.
    if (_activeConnection !== connection || generation !== lockdownGeneration) {
      try {
        await signer.close();
      } catch {
        // Best-effort — we're discarding this signer regardless.
      }
      throw new NostrConnectError('unavailable', 'NIP-46 connection changed during connect');
    }
    _activeSigner = signer;
    return signer;
  })();
  _signerPromise = promise;
  try {
    return await promise;
  } catch (e) {
    // Drop the memo so the next call retries a fresh connect rather than
    // re-awaiting the same rejected promise forever — but ONLY if it still
    // points at THIS attempt. A concurrent setActiveConnection + getSigner
    // may have already installed a newer promise we must not clobber.
    if (_signerPromise === promise) _signerPromise = null;
    throw e;
  }
}

/**
 * Returns the user's hex pubkey as reported by the bunker. We DO NOT
 * trust the cached `userPubkey` from the persisted connection here —
 * the bunker is the source of truth (it might have rotated keys,
 * switched accounts, etc.).
 */
export async function requestPublicKey(): Promise<string> {
  const signer = await getSigner();
  try {
    return await signer.getPublicKey();
  } catch (e) {
    throw wrapPermissionError('get_public_key', e);
  }
}

/**
 * Sign an unsigned event. Mirrors `amberService.requestEventSignature`'s
 * `(eventJson, eventId, currentUser) => { signature, event }` signature
 * so NostrContext can call either service interchangeably.
 *
 * `eventId` and `currentUser` are accepted but unused — Amber's native
 * module needs them for its Intent extras; the bunker derives both from
 * the unsigned event itself.
 */
export async function requestEventSignature(
  eventJson: string,
  _eventId: string,
  _currentUser: string,
): Promise<{ signature: string; event: string }> {
  const signer = await getSigner();
  const parsed = JSON.parse(eventJson);
  // BunkerSigner.signEvent takes an EventTemplate — strip pubkey/id/sig
  // even if the caller included them, matching how Amber's Kotlin side
  // handles the same JSON shape (see PR #267's Amber group-send path).
  const template = {
    kind: parsed.kind,
    created_at: parsed.created_at,
    tags: parsed.tags ?? [],
    content: parsed.content ?? '',
  };
  let signed;
  try {
    signed = await signer.signEvent(template);
  } catch (e) {
    throw wrapPermissionError('sign_event', e);
  }
  return { signature: signed.sig, event: JSON.stringify(signed) };
}

export async function requestNip04Encrypt(
  plaintext: string,
  recipientPubkey: string,
  _currentUser: string,
): Promise<string> {
  const signer = await getSigner();
  try {
    return await signer.nip04Encrypt(recipientPubkey, plaintext);
  } catch (e) {
    throw wrapPermissionError('nip04_encrypt', e);
  }
}

export async function requestNip04Decrypt(
  ciphertext: string,
  senderPubkey: string,
  _currentUser: string,
): Promise<string> {
  const signer = await getSigner();
  try {
    return await signer.nip04Decrypt(senderPubkey, ciphertext);
  } catch (e) {
    throw wrapPermissionError('nip04_decrypt', e);
  }
}

export async function requestNip44Encrypt(
  plaintext: string,
  recipientPubkey: string,
  _currentUser: string,
): Promise<string> {
  const signer = await getSigner();
  try {
    return await signer.nip44Encrypt(recipientPubkey, plaintext);
  } catch (e) {
    throw wrapPermissionError('nip44_encrypt', e);
  }
}

export async function requestNip44Decrypt(
  ciphertext: string,
  senderPubkey: string,
  _currentUser: string,
): Promise<string> {
  const signer = await getSigner();
  try {
    return await signer.nip44Decrypt(senderPubkey, ciphertext);
  } catch (e) {
    throw wrapPermissionError('nip44_decrypt', e);
  }
}

/**
 * NIP-46 has no equivalent of Amber's `nip44DecryptSilent`
 * ContentResolver fast-path. Each decrypt is a relay round-trip plus
 * (optionally) a user prompt on the bunker side. For an inbox-refresh
 * batch of 50 wraps this would be 50 * (200-1500ms) = unusable, plus
 * 50 prompts unless the user pre-granted nip44_decrypt at pair time.
 *
 * Trade-off taken here: the inbox refresh path in NostrContext
 * **feature-flags off the silent batch path when signerType ===
 * 'nip46'** — instead, the inbox shows a "decrypting..." spinner and
 * progress UI while wraps catch up via the per-request slow path
 * (`requestNip44Decrypt`). This is correct (one prompt per wrap, all
 * properly attributed) but slow on cold cache.
 *
 * A spec-compliant `nip44_decrypt_batch` extension would need
 * coordination with at least Clave / nsec.app / Aegis — leaving for
 * follow-up work. See issue #283.
 *
 * This function exists only so that callers asking for it explicitly
 * get a clear error rather than silently falling back to a path that
 * would prompt 50 times. Use `requestNip44Decrypt` instead.
 */
export async function requestNip44DecryptSilent(
  _ciphertext: string,
  _senderPubkey: string,
  _currentUser: string,
): Promise<string> {
  throw new Error('NIP-46 does not support silent batch decrypt — use requestNip44Decrypt');
}

/** Explicit target identity allows fixture pairing before an account is active. */
export function pairingRelays(relays: string[], targetPubkey?: string): string[] {
  return [...lockRelays(activeAccountRelays(relays), targetPubkey)];
}

/**
 * Build a `nostrconnect://` pairing URI. The bunker (Clave / Aegis /
 * nsec.app / etc.) scans this and replies with a `connect` ack that
 * carries the bunker's pubkey, completing the pairing handshake.
 *
 * `clientPubkey` is the per-app keypair pubkey (NOT the user's nsec).
 * `secret` is 32 hex chars of crypto-secure entropy used by the bunker
 * to authenticate the inbound connection request.
 *
 * Format follows the NIP-46 spec, section "Nostr Connect URIs":
 *   nostrconnect://<client-pub>?relay=<url>&secret=<hex>&perms=<csv>&name=<urlenc>
 *
 * `relay=` is repeated once per relay in `relays` (NIP46_PAIRING_RELAYS by
 * default; see NostrLoginSheet), so the bunker can answer on any of them.
 */
export function buildPairingUri(input: {
  clientPubkey: string;
  targetPubkey?: string;
  relays: string[];
  secret: string;
  perms: string[];
  name?: string;
}): string {
  // Delegate to nostr-tools' canonical builder so the URI shape
  // (param names, ordering quirks, missing-perms handling) stays
  // in sync with what BunkerSigner.fromURI parses on the other side.
  return createNostrConnectURI({
    clientPubkey: input.clientPubkey,
    relays: pairingRelays(input.relays, input.targetPubkey),
    secret: input.secret,
    perms: input.perms,
    name: input.name,
  });
}

/**
 * Wait for a bunker to respond to our pairing URI. Generates the
 * BunkerSigner from the URI, awaits the bunker's `connect` ack
 * (resolved by `BunkerSigner.fromURI`), then returns both the live
 * signer and the connection object the caller should persist.
 *
 * The caller (NostrLoginSheet) is responsible for:
 *  - generating the per-app keypair
 *  - rendering the URI as a QR for the bunker to scan
 *  - persisting the returned `Nip46Connection` to SecureStore
 *  - calling `setActiveConnection` so subsequent service calls reuse
 *    the open subscription
 *
 * `maxWaitSeconds` defaults to 120 — enough for a slow user to switch
 * apps, find Clave, scan the QR, and tap Approve. Longer than that we
 * give up and the user can retap the button.
 *
 * Pass `signal` to make the wait abortable: cancelling the sheet rejects
 * the pairing promptly, and if the bunker acks *after* the abort the
 * orphaned signer is closed so its relay subscription doesn't leak.
 *
 * This function deliberately does NOT cache the signer/connection into the
 * module globals (Copilot review): mutating them before the caller has
 * persisted the connection + committed to the login would leave a live
 * subscription cached under an identity the app never logged into (e.g.
 * the user cancels, or `loginWithNip46` fails, after the ack). The caller
 * adopts the live signer via `adoptPairedSigner` once it has decided to
 * proceed — reusing the open subscription without a second `connect()`.
 */
export async function awaitBunkerPair(input: {
  clientSecretKey: Uint8Array;
  clientPubkey: string;
  targetPubkey?: string;
  relays: string[];
  secret: string;
  perms: string[];
  name: string;
  maxWaitSeconds?: number;
  signal?: AbortSignal;
}): Promise<{ signer: BunkerSigner; connection: Nip46Connection; userPubkey: string }> {
  const relays = pairingRelays(input.relays, input.targetPubkey);
  const uri = buildPairingUri({
    clientPubkey: input.clientPubkey,
    relays,
    secret: input.secret,
    perms: input.perms,
    name: input.name,
  });
  const { signal } = input;
  if (signal?.aborted) throw makeAbortError();
  const maxWait = (input.maxWaitSeconds ?? 120) * 1000;

  // BunkerSigner.fromURI has no AbortSignal input of its own, so race the
  // pairing promise against the abort. On abort we reject immediately and,
  // if the bunker acks late, close the orphaned signer rather than leak it.
  const pairPromise = BunkerSigner.fromURI(
    input.clientSecretKey,
    uri,
    __DEV__ ? { pool } : undefined,
    maxWait,
  );
  const signer = await raceAbort(pairPromise, signal, (late) => {
    late.close().catch(() => {});
  });

  // The bunker's pubkey is now in `signer.bp.pubkey`. Resolve the
  // user's signing pubkey too — on multi-account bunkers (nsec.app,
  // etc.) the bunker pubkey and signing pubkey differ, and the
  // signing pubkey is what NostrContext stores as the logged-in user.
  // getPublicKey is another relay round-trip, so race it against abort
  // too — a cancel here rejects immediately instead of blocking on it.
  let userPubkey: string;
  try {
    userPubkey = await raceAbort(signer.getPublicKey(), signal, () => {});
  } catch (e) {
    // Aborted mid-round-trip (or getPublicKey failed) — close the signer we
    // opened via fromURI so its subscription doesn't leak.
    await signer.close().catch(() => {});
    throw e;
  }
  const connection: Nip46Connection = {
    remoteSignerPubkey: signer.bp.pubkey,
    userPubkey,
    relays,
    clientSecretKeyHex: bytesToHex(input.clientSecretKey),
    perms: input.perms.join(','),
  };
  return { signer, connection, userPubkey };
}

/**
 * Adopt a signer that `awaitBunkerPair` already connected, reusing its open
 * relay subscription so the first signEvent doesn't pay a second `connect()`
 * round-trip. Closes any previously-active signer. Call this only after the
 * caller has committed to the login (persisted the connection) — the pairing
 * helper intentionally leaves the globals untouched until then.
 */
export function adoptPairedSigner(connection: Nip46Connection, signer: BunkerSigner): void {
  if (_activeSigner && _activeSigner !== signer) {
    _activeSigner.close().catch(() => {});
  }
  _signerPromise = null;
  _activeConnection = connection;
  _activeSigner = signer;
}

/**
 * Hermes has no `DOMException`, so build a plain Error tagged like the DOM
 * `AbortError` — callers can still branch on `err.name === 'AbortError'`.
 */
function makeAbortError(): Error {
  const e = new Error('NIP-46 pairing aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Await `promise`, but reject early if `signal` aborts. If the promise
 * settles *after* an abort, `onLateResolve` receives the resolved value so
 * the caller can dispose of it (close the orphaned signer). A late rejection
 * after abort is swallowed — the abort already rejected the returned promise.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLateResolve: (value: T) => void,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      // `{ once: true }` already de-registers this on fire; remove it
      // explicitly too so cleanup is symmetric with the settle branches
      // below and doesn't depend on that option for correctness.
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      reject(makeAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          onLateResolve(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(err);
      },
    );
  });
}

// Entering lockdown destroys the shared pool's old public subscriptions.
// Rebuild the signer lazily so its RPC subscription uses the LAN relay too.
watchTestRelayLockdown(() => {
  lockdownGeneration++;
  const signer = _activeSigner;
  _activeSigner = null;
  _signerPromise = null;
  void signer?.close().catch(() => {});
});
