/**
 * decryptedMediaCache — the one place encrypted chat media (voice notes and
 * photos, NIP-17 kind 15 and Marmot MIP-04) is fetched, decrypted and cached
 * as a playable / displayable `file://` URI.
 *
 * Decrypted media is plaintext, so it follows the same rule as the DM stores
 * (#689): it belongs to one account and must not outlive it.
 *
 *  - **Per account on disk.** Files live under
 *    `cacheDirectory/decrypted/<sha256(owner)>/`, so `wipeDecryptedMediaForOwner`
 *    can delete one account's media without touching another's.
 *  - **Bound to the key material.** The cache key is a hash of the URL AND the
 *    key / nonce / Marmot params. A hit therefore only happens for a caller
 *    holding exactly the keys the original (authenticated) decrypt succeeded
 *    with, so a message pointing at a cached URL with other keys can't be
 *    served someone else's plaintext without decrypting.
 *  - **Generation token.** Each owner has a generation, bumped when its media
 *    is wiped or its session ends (account switch / sign-out). A decrypt that
 *    was in flight when that happened never fills the memory cache, and only
 *    publishes a file if it was already past its last check — on a wipe the
 *    wipe waits for that publish and then deletes the folder; on a switch the
 *    same wipe removes the outgoing account's folder.
 *  - **Sessions.** Only a cold start (no account yet in this process) waits
 *    for an owner; a request made between sessions is cancelled, so one
 *    account's media can never be decrypted into the next account's folder.
 *  - **Legacy cleanup.** Before #1241 the components wrote device-wide
 *    `lp-voice-*` / `lp-img-*` files straight into `cacheDirectory`; they are
 *    deleted once after upgrade (and on any sign-out until that has run).
 *
 * The active owner is set by `useIdentityMemoryReset` (a layout effect on the
 * provider's pubkey), so the media components don't need the pubkey threaded
 * through every bubble.
 */
import { sniffFileMime, FileVerificationError, MAX_FILE_BYTES } from './fileDownload';
import { sanitizeAttachmentText } from '../utils/fileAttachment';
import { checkRemoteUrl, fetchBounded, MEDIA_MAX_BYTES } from '../utils/remoteUrlPolicy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cacheDirectory,
  copyAsync,
  deleteAsync,
  getInfoAsync,
  makeDirectoryAsync,
  moveAsync,
  readDirectoryAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { decryptFile } from './encryptedFile';
import { decryptMarmotMedia } from './marmotMedia';
import type { MarmotImageParams } from '../utils/messageContent';

export type DecryptedMediaKind = 'voice' | 'image' | 'file';

/** Everything needed to fetch + decrypt one attachment. */
export interface EncryptedMediaRef {
  url: string;
  kind: DecryptedMediaKind;
  mime?: string;
  size?: number;
  plaintextSha256?: string;
  plainUrl?: boolean;
  /** Explicitly unencrypted imeta files are still cached per account. */
  encrypted?: boolean;
  /** Declared NIP-17 ciphertext hash, checked before decryption. */
  sha256?: string;
  /** NIP-17 (kind 15) AES-256-GCM key. */
  keyHex?: string;
  nonceHex?: string;
  /** A Marmot (MIP-04) attachment: decrypted with these instead of `keyHex`. */
  marmot?: MarmotImageParams;
}

/** Thrown when the owner's session ended / cache was wiped mid-decrypt. */
export class DecryptedMediaCancelledError extends Error {
  constructor() {
    super('decrypted media request cancelled (account changed or cache wiped)');
    this.name = 'DecryptedMediaCancelledError';
  }
}

export const PDF_PREVIEW_WIDTH = 480;
const ROOT_DIR = 'decrypted';
export const LEGACY_CLEANUP_FLAG_KEY = 'decrypted_media_legacy_cleanup_v1';
const LEGACY_FILE_RE = /^lp-(voice|img)-/;
const LEGACY_CLEANUP_DELAY_MS = 5000;
// Bounded like the other module caches (#732 review): insertion-order eviction.
const MEMORY_CAP = 128;

// `<ownerDir>/<cacheKey>` → file:// uri, for the ACTIVE owner only.
const memory = new Map<string, string>();
const verifiedFiles = new Map<string, { size: number; mime: string }>();
export const verifiedFileMetadata = (uri: string) => verifiedFiles.get(uri);

// Android's chooser may settle before the recipient opens its content URI.
// Keep a bounded number of shares through the chooser and for ten minutes after.
export const FILE_SHARE_RETENTION_MS = 10 * 60 * 1000;
const MAX_RETAINED_FILES = 16;
const retainedFiles = new Map<
  string,
  { users: number; shared: boolean; timer?: ReturnType<typeof setTimeout> }
>();

/** Release schedules cleanup; repeated/concurrent shares extend the same lease. */
export function retainDecryptedFile(uri: string): () => void {
  return retainFile(uri, true);
}

/** Preview-only leases protect rendering from eviction without reserving share slots. */
function retainFile(uri: string, forShare: boolean): () => void {
  let lease = retainedFiles.get(uri);
  if (forShare && !lease?.shared) {
    const shares = [...retainedFiles.values()].filter((entry) => entry.shared).length;
    if (shares >= MAX_RETAINED_FILES) throw new Error('Too many retained file shares');
  }
  if (!lease) {
    lease = { users: 0, shared: false };
    retainedFiles.set(uri, lease);
  }
  if (forShare) lease.shared = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.users++;
  const current = lease;
  let released = false;
  return () => {
    if (released || retainedFiles.get(uri) !== current) return;
    released = true;
    if (--current.users > 0) return;
    if (!current.shared) {
      retainedFiles.delete(uri);
      return;
    }
    current.timer = setTimeout(() => {
      void deleteDecryptedFile(uri).catch(() => {});
    }, FILE_SHARE_RETENTION_MS);
  };
}

/** File shares are transient plaintext, including memory entries. */
export async function deleteDecryptedFile(uri: string): Promise<void> {
  const lease = retainedFiles.get(uri);
  if (lease?.timer) clearTimeout(lease.timer);
  retainedFiles.delete(uri);
  verifiedFiles.delete(uri);
  for (const [key, value] of memory) if (value === uri) memory.delete(key);
  await deleteAsync(`${uri}.preview-${PDF_PREVIEW_WIDTH}.png`, { idempotent: true });
  await deleteAsync(`${uri}.share/`, { idempotent: true });
  await deleteAsync(uri, { idempotent: true });
}

/** Derived previews join the account's publish barrier so logout cannot leave plaintext behind. */
export async function publishDecryptedPreview(
  uri: string,
  render: () => Promise<string | null>,
): Promise<string | null> {
  const session = captureDecryptedMediaSession();
  session.assertCurrent();
  const { owner, epoch } = await requestOwner();
  session.assertCurrent();
  const dir = ownerDirUri(owner);
  if (!dir || !uri.startsWith(dir)) throw new DecryptedMediaCancelledError();
  const ownerDir = ownerDirName(owner);
  const gen = generationOf(ownerDir);
  const release = retainFile(uri, false);
  try {
    let result: string | null = null;
    await trackPublish(
      ownerDir,
      (async () => {
        result = await render();
      })(),
    );
    if (epoch !== sessionEpoch || generationOf(ownerDir) !== gen)
      throw new DecryptedMediaCancelledError();
    session.assertCurrent();
    return result;
  } finally {
    release();
  }
}

/** Named exports share the source lease, account directory, and wipe generation. */
export async function namedFileExport(uri: string, name: string): Promise<string> {
  const session = captureDecryptedMediaSession();
  session.assertCurrent();
  const { owner } = await requestOwner();
  session.assertCurrent();
  const dir = ownerDirUri(owner);
  if (!dir || !uri.startsWith(dir) || !retainedFiles.has(uri))
    throw new DecryptedMediaCancelledError();
  const ownerDir = ownerDirName(owner);
  const gen = generationOf(ownerDir);
  const safeName = sanitizeAttachmentText(name).replace(/^[. ]+|[. ]+$/g, '') || 'attachment.bin';
  const shareDir = `${uri}.share/`;
  const target = `${shareDir}${encodeURIComponent(safeName)}`;
  await trackPublish(
    ownerDir,
    (async () => {
      await makeDirectoryAsync(shareDir, { intermediates: true });
      if (generationOf(ownerDir) !== gen) throw new DecryptedMediaCancelledError();
      await copyAsync({ from: uri, to: target });
    })(),
  );
  if (generationOf(ownerDir) !== gen) throw new DecryptedMediaCancelledError();
  session.assertCurrent();
  return target;
}

/** Sweep abandoned shares from prior runs; keep at most 16 recent files. */
async function evictDiskFiles(dir: string): Promise<void> {
  const names = (await readDirectoryAsync(dir)).filter(
    (name) =>
      name.startsWith('file-') &&
      !name.endsWith('.share') &&
      !name.includes('.preview-') &&
      !retainedFiles.has(`${dir}${name}`),
  );
  const entries = await Promise.all(
    names.map(async (name) => ({
      uri: `${dir}${name}`,
      info: await getInfoAsync(`${dir}${name}`),
    })),
  );
  entries.sort(
    (a, b) =>
      (b.info.exists ? (b.info.modificationTime ?? 0) : 0) -
      (a.info.exists ? (a.info.modificationTime ?? 0) : 0),
  );
  await Promise.all(
    entries
      .filter(
        ({ info }, i) =>
          i >= 15 ||
          (info.exists &&
            (info.modificationTime ?? 0) < (Date.now() - FILE_SHARE_RETENTION_MS) / 1000),
      )
      // A share can acquire a lease while the asynchronous directory scan runs.
      .filter(({ uri }) => !retainedFiles.has(uri))
      .map(({ uri }) => deleteDecryptedFile(uri)),
  );
}
// `<ownerDir>/<cacheKey>` → in-flight resolve, so a bubble and the fullscreen
// viewer opening the same photo share one fetch + decrypt.
const inflight = new Map<string, Promise<string>>();
// ownerDir → generation; see the header.
const generations = new Map<string, number>();
let activeOwner: string | null = null;
// "Not hydrated yet" vs "between sessions": only a cold start (no owner ever
// set in this process) may wait for one. Every owner change bumps the epoch.
let everHadOwner = false;
let sessionEpoch = 0;
type OwnerWaiter = (owner: string | null, epoch: number) => void;
// Requests waiting in `waitForOwner` for the first account to become active.
let ownerWaiters: OwnerWaiter[] = [];
// ownerDir → file publishes in flight, so a wipe can wait for them.
const publishing = new Map<string, Set<Promise<void>>>();
const wiping = new Map<string, Promise<void>>();
const OWNER_WAIT_MS = 15_000;
let legacyCleanupTimer: ReturnType<typeof setTimeout> | null = null;

const hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

function cacheBase(): string | null {
  if (!cacheDirectory) return null;
  return cacheDirectory.endsWith('/') ? cacheDirectory : `${cacheDirectory}/`;
}

/**
 * The directory name for an owner. A hash keeps the raw pubkey out of the
 * path, but an unsalted sha256 of a public key is still linkable to it —
 * this is tidiness, not anonymity.
 */
export function ownerDirName(owner: string): string {
  return hex(owner.toLowerCase());
}

function ownerDirUri(owner: string): string | null {
  const base = cacheBase();
  return base ? `${base}${ROOT_DIR}/${ownerDirName(owner)}/` : null;
}

/** Hash of the URL plus every piece of key material (see the header). */
export function mediaCacheKey(ref: EncryptedMediaRef): string {
  const m = ref.marmot;
  return hex(
    JSON.stringify([
      ref.url,
      ...(ref.kind === 'file'
        ? [['safe-file-v2', ref.encrypted, ref.plaintextSha256, ref.size, ref.plainUrl]]
        : []),
      ref.keyHex ?? '',
      ref.nonceHex ?? '',
      ref.sha256 === undefined ? null : ref.sha256,
      ref.mime ?? '',
      ref.size ?? null,
      m ? [m.version, m.keysHex, m.filename, m.plaintextSha256, m.ciphertextSha256] : null,
    ]),
  );
}

function hasValidDeclaredHash(ref: EncryptedMediaRef): boolean {
  return (
    ref.sha256 === undefined ||
    (typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(ref.sha256))
  );
}

function extensionFor(kind: DecryptedMediaKind, mime?: string): string {
  if (kind === 'file') return mime === 'application/pdf' ? 'pdf' : 'bin';
  if (kind === 'image') {
    return (mime || 'image/jpeg').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'jpg';
  }
  // Container hint for the audio player; m4a is our recorder's format.
  switch (mime) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/aac':
      return 'aac';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
      return 'wav';
    default:
      return 'm4a';
  }
}

const generationOf = (ownerDir: string) => generations.get(ownerDir) ?? 0;
const bump = (ownerDir: string) => generations.set(ownerDir, generationOf(ownerDir) + 1);

function remember(memoKey: string, uri: string): void {
  memory.set(memoKey, uri);
  while (memory.size > MEMORY_CAP) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    const uri = memory.get(oldest);
    if (uri) verifiedFiles.delete(uri);
    memory.delete(oldest);
  }
}

/**
 * Point the cache at the active account. Changing owner ends the previous
 * owner's session: its in-flight decrypts are cancelled and the memory cache
 * is dropped and its decrypted files are deleted.
 */
export function setDecryptedMediaOwner(pubkey: string | null): void {
  const next = pubkey ? pubkey.toLowerCase() : null;
  if (next === activeOwner) return;
  const previous = activeOwner;
  if (previous) bump(ownerDirName(previous));
  memory.clear();
  verifiedFiles.clear();
  inflight.clear();
  activeOwner = next;
  sessionEpoch++;
  // Best-effort: the switch must complete even if the folder delete fails.
  if (previous) clearDecryptedMediaCache(previous).catch(() => {});
  if (next) {
    everHadOwner = true;
    const waiters = ownerWaiters;
    ownerWaiters = [];
    waiters.forEach((wake) => wake(next, sessionEpoch));
  }
  if (next && !legacyCleanupTimer) {
    // Off the startup path; a one-off directory listing.
    legacyCleanupTimer = setTimeout(() => {
      cleanupLegacyDecryptedMedia().catch(() => {});
      const dir = ownerDirUri(next);
      if (dir)
        getInfoAsync(dir)
          .then((info) => (info.exists ? evictDiskFiles(dir) : undefined))
          .catch(() => {});
    }, LEGACY_CLEANUP_DELAY_MS);
  }
}

/** Drop the in-memory cache and cancel in-flight decrypts (identity reset). */
export function clearDecryptedMediaMemory(): void {
  if (activeOwner) bump(ownerDirName(activeOwner));
  memory.clear();
  verifiedFiles.clear();
  inflight.clear();
}

/** Synchronous memory lookup (for seeding a bubble without a spinner). */
export function peekDecryptedMedia(ref: EncryptedMediaRef): string | null {
  if (!activeOwner || !hasValidDeclaredHash(ref)) return null;
  return memory.get(`${ownerDirName(activeOwner)}/${mediaCacheKey(ref)}`) ?? null;
}

/** Capture synchronously before any await; an account round trip also retires this token. */
export function captureDecryptedMediaSession(expectedOwner = activeOwner) {
  const owner = expectedOwner;
  const epoch = sessionEpoch;
  const gen = owner ? generationOf(ownerDirName(owner)) : 0;
  return {
    owner,
    assertCurrent() {
      if (
        !owner ||
        owner !== activeOwner ||
        epoch !== sessionEpoch ||
        generationOf(ownerDirName(owner)) !== gen
      )
        throw new DecryptedMediaCancelledError();
    },
  };
}

/** Cold start only: wait up to OWNER_WAIT_MS for the first owner. */
function waitForOwner(): Promise<{ owner: string; epoch: number }> {
  return new Promise((resolve, reject) => {
    const wake: OwnerWaiter = (owner, epoch) => {
      clearTimeout(timer);
      if (owner) resolve({ owner, epoch });
      else reject(new Error('No active account for decrypted media'));
    };
    const timer = setTimeout(() => {
      ownerWaiters = ownerWaiters.filter((w) => w !== wake);
      wake(null, sessionEpoch);
    }, OWNER_WAIT_MS);
    ownerWaiters.push(wake);
  });
}

/** The account a new request belongs to (see `everHadOwner`). */
async function requestOwner(): Promise<{ owner: string; epoch: number }> {
  if (activeOwner) return { owner: activeOwner, epoch: sessionEpoch };
  // Between sessions (after a sign-out / switch to nobody): the request
  // belongs to an account that's gone, so it must never land in the next one.
  if (everHadOwner) throw new DecryptedMediaCancelledError();
  // A cold start can mount a bubble (e.g. a restored group chat, whose
  // messages aren't per-account yet) before the session's pubkey lands.
  const { owner, epoch } = await waitForOwner();
  if (epoch !== sessionEpoch) throw new DecryptedMediaCancelledError();
  return { owner, epoch };
}

/**
 * Resolve an encrypted attachment to a decrypted `file://` URI for the active
 * account: memory → this account's disk cache → fetch + decrypt + write.
 * Rejects on fetch / decrypt failure (wrong keys, bad hashes) and with
 * `DecryptedMediaCancelledError` if the account's session ended meanwhile.
 */
export async function resolveDecryptedMedia(
  ref: EncryptedMediaRef,
  expectedOwner?: string | null,
): Promise<string> {
  if (!checkRemoteUrl(ref.url, { kind: 'media' }).ok) throw new Error('Blocked remote URL');
  if (
    ref.size !== undefined &&
    (!Number.isSafeInteger(ref.size) || ref.size <= 0 || ref.size > MEDIA_MAX_BYTES)
  )
    throw new Error('Invalid media size');
  if (!hasValidDeclaredHash(ref))
    throw ref.kind === 'file'
      ? new FileVerificationError()
      : new Error('Media ciphertext hash mismatch');
  if (expectedOwner !== undefined && (!expectedOwner || activeOwner !== expectedOwner))
    throw new DecryptedMediaCancelledError();
  const { owner, epoch } = await requestOwner();
  if (expectedOwner !== undefined && owner !== expectedOwner)
    throw new DecryptedMediaCancelledError();
  const ownerDir = ownerDirName(owner);
  await wiping.get(ownerDir);
  if (epoch !== sessionEpoch || activeOwner !== owner) throw new DecryptedMediaCancelledError();
  const memoKey = `${ownerDir}/${mediaCacheKey(ref)}`;
  const pending = inflight.get(memoKey);
  if (pending) return pending;
  const run = resolveUncached(ref, owner, ownerDir, memoKey).finally(() => {
    if (inflight.get(memoKey) === run) inflight.delete(memoKey);
  });
  inflight.set(memoKey, run);
  return run;
}

async function resolveUncached(
  ref: EncryptedMediaRef,
  owner: string,
  ownerDir: string,
  memoKey: string,
): Promise<string> {
  const gen = generationOf(ownerDir);
  const assertCurrent = () => {
    if (generationOf(ownerDir) !== gen) throw new DecryptedMediaCancelledError();
  };
  // A memory hit isn't proof the file survives: the OS can evict cacheDirectory.
  const memo = memory.get(memoKey);
  if (memo && (ref.kind !== 'file' || verifiedFiles.has(memo))) {
    if ((await getInfoAsync(memo)).exists) {
      assertCurrent();
      return memo;
    }
    memory.delete(memoKey);
  }
  const dir = ownerDirUri(owner);
  if (!dir) throw new Error('No cache directory available for decrypted media');
  const { keyHex, nonceHex, marmot } = ref;
  const unencrypted = ref.kind === 'file' && ref.encrypted === false && !keyHex && !marmot;
  if (!unencrypted && ((!keyHex && !marmot) || !nonceHex))
    throw new Error('Missing media key material');
  const uri = `${dir}${ref.kind}-${mediaCacheKey(ref)}.${extensionFor(ref.kind, ref.mime)}`;
  // A restored file must prove its plaintext hash again before being shared.
  const disk = await getInfoAsync(uri);
  const expectedHash = unencrypted ? ref.plaintextSha256 : marmot?.plaintextSha256;
  if (ref.kind === 'file' && disk.exists && expectedHash) {
    if (disk.size > MAX_FILE_BYTES) {
      await deleteDecryptedFile(uri);
      throw new FileVerificationError();
    }
    const bytes = new Uint8Array(
      Buffer.from(await readAsStringAsync(uri, { encoding: 'base64' }), 'base64'),
    );
    if (bytes.length > MAX_FILE_BYTES || bytesToHex(sha256(bytes)) !== expectedHash.toLowerCase()) {
      await deleteDecryptedFile(uri);
      throw new FileVerificationError();
    }
    assertCurrent();
    verifiedFiles.set(uri, { size: bytes.length, mime: sniffFileMime(bytes) });
    remember(memoKey, uri);
    return uri;
  }
  // Voice and image disk entries remain keyed to their authenticated decrypt.
  if (ref.kind === 'file' || !disk.exists) {
    const { bytes: cipher } = await fetchBounded(ref.url, {
      maxBytes: ref.size ?? MEDIA_MAX_BYTES,
      timeoutMs: 30000,
      redirects: 'https-only',
      maxRedirects: 3,
    });
    // A kind-15 that declares its ciphertext hash (`x` tag) must match it —
    // and a declared-but-malformed hash is a mismatch, never "no hash".
    if (ref.sha256 !== undefined && bytesToHex(sha256(cipher)) !== ref.sha256.toLowerCase()) {
      throw ref.kind === 'file'
        ? new FileVerificationError()
        : new Error('Media ciphertext hash mismatch');
    }
    let plain: Uint8Array;
    try {
      plain = unencrypted
        ? cipher
        : marmot
          ? decryptMarmotMedia(cipher, {
              mime: ref.mime ?? (ref.kind === 'voice' ? 'audio/mp4' : 'image/jpeg'),
              nonceHex,
              marmot,
            })
          : decryptFile(cipher, keyHex as string, nonceHex as string);
    } catch (error) {
      // File bubbles distinguish integrity/authentication failures from sharing errors.
      if (ref.kind === 'file') throw new FileVerificationError();
      throw error;
    }
    if (
      unencrypted &&
      (!ref.plainUrl || ref.plaintextSha256 !== undefined) &&
      (!ref.plaintextSha256 || bytesToHex(sha256(plain)) !== ref.plaintextSha256.toLowerCase())
    ) {
      await deleteDecryptedFile(uri);
      throw new FileVerificationError();
    }
    assertCurrent();
    if (ref.kind === 'file') {
      await makeDirectoryAsync(dir, { intermediates: true });
      await evictDiskFiles(dir);
      await deleteDecryptedFile(uri);
      assertCurrent();
    }
    // Registered in the same tick as the check above, so a wipe that bumps
    // the generation after it will wait for this publish to settle.
    await trackPublish(ownerDir, publishFile(dir, uri, plain, ownerDir, gen));
    assertCurrent();
    if (ref.kind === 'file')
      verifiedFiles.set(uri, { size: plain.byteLength, mime: sniffFileMime(plain) });
  }
  assertCurrent();
  remember(memoKey, uri);
  return uri;
}

/**
 * Write to this writer's own temp file, then move it into place: a reader
 * never sees a half-written file, and a cancelled writer only ever deletes its
 * own temp — never a file a newer request already published.
 */
async function publishFile(
  dir: string,
  uri: string,
  plain: Uint8Array,
  ownerDir: string,
  gen: number,
): Promise<void> {
  const tmp = `${uri}.${gen}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await makeDirectoryAsync(dir, { intermediates: true });
    await writeAsStringAsync(tmp, Buffer.from(plain).toString('base64'), { encoding: 'base64' });
    // Wiped / switched while writing: don't publish.
    if (generationOf(ownerDir) !== gen) throw new DecryptedMediaCancelledError();
    if (!(await getInfoAsync(uri)).exists) await moveAsync({ from: tmp, to: uri });
  } finally {
    // Already gone after a successful move; on any failure (partial write,
    // cancelled, move error) never leave the plaintext temp behind.
    await deleteAsync(tmp, { idempotent: true }).catch(() => {});
  }
}

function trackPublish(ownerDir: string, publish: Promise<void>): Promise<void> {
  let set = publishing.get(ownerDir);
  if (!set) publishing.set(ownerDir, (set = new Set()));
  set.add(publish);
  const done = () => {
    set.delete(publish);
    if (set.size === 0 && publishing.get(ownerDir) === set) publishing.delete(ownerDir);
  };
  publish.then(done, done);
  return publish;
}

/**
 * Delete every decrypted file belonging to `pubkey` and forget its memory
 * entries; cancels its in-flight decrypts. Called from `wipeAccountCaches`.
 */
export function clearDecryptedMediaCache(pubkey: string): Promise<void> {
  const ownerDir = ownerDirName(pubkey);
  const pending = wiping.get(ownerDir);
  if (pending) return pending;
  const run = wipeOwner(pubkey).finally(() => {
    if (wiping.get(ownerDir) === run) wiping.delete(ownerDir);
  });
  wiping.set(ownerDir, run);
  return run;
}

async function wipeOwner(pubkey: string): Promise<void> {
  const ownerDir = ownerDirName(pubkey);
  bump(ownerDir);
  // Signing out the active account retires its session right away: a bubble
  // mounting during the rest of the logout is cancelled, never decrypted for
  // it again — nor parked until the next account (whose folder it'd land in).
  if (activeOwner === pubkey.toLowerCase()) {
    activeOwner = null;
    sessionEpoch++;
  }
  for (const k of [...memory.keys()]) if (k.startsWith(`${ownerDir}/`)) memory.delete(k);
  for (const k of [...inflight.keys()]) if (k.startsWith(`${ownerDir}/`)) inflight.delete(k);
  // A publish already past its generation check may still move a file into
  // place; let it settle so the folder delete below catches it.
  await Promise.allSettled([...(publishing.get(ownerDir) ?? [])]);
  const dir = ownerDirUri(pubkey);
  if (dir) {
    for (const [uri, lease] of retainedFiles) {
      if (!uri.startsWith(dir)) continue;
      if (lease.timer) clearTimeout(lease.timer);
      retainedFiles.delete(uri);
    }
  }
  if (dir) await deleteAsync(dir, { idempotent: true }).catch(() => {});
  // Legacy files aren't attributable to an owner — any sign-out removes them.
  await cleanupLegacyDecryptedMedia().catch(() => {});
}

/** One-time removal of the pre-#1241 device-wide `lp-voice-*` / `lp-img-*` files. */
export async function cleanupLegacyDecryptedMedia(): Promise<void> {
  if (await AsyncStorage.getItem(LEGACY_CLEANUP_FLAG_KEY)) return;
  const base = cacheBase();
  if (!base) return;
  const names = await readDirectoryAsync(base);
  const results = await Promise.allSettled(
    names
      .filter((n) => LEGACY_FILE_RE.test(n))
      .map((n) => deleteAsync(`${base}${n}`, { idempotent: true })),
  );
  // Only mark it done once every file is gone; otherwise retry next time.
  if (results.every((r) => r.status === 'fulfilled')) {
    await AsyncStorage.setItem(LEGACY_CLEANUP_FLAG_KEY, '1');
  }
}

/** Test-only: reset module state between cases. */
export function __resetDecryptedMediaCacheForTests(): void {
  for (const lease of retainedFiles.values()) if (lease.timer) clearTimeout(lease.timer);
  retainedFiles.clear();
  memory.clear();
  verifiedFiles.clear();
  inflight.clear();
  generations.clear();
  activeOwner = null;
  everHadOwner = false;
  sessionEpoch = 0;
  ownerWaiters = [];
  publishing.clear();
  wiping.clear();
  if (legacyCleanupTimer) clearTimeout(legacyCleanupTimer);
  legacyCleanupTimer = null;
}

/** Compatibility for existing consumers. */
export const wipeDecryptedMediaForOwner = clearDecryptedMediaCache;
