import { clearEncryptionDecision } from './nwcEncryption';
import { invalidateBackgroundPaymentScope } from './backgroundPaymentScope';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { WalletMetadata } from '../types/wallet';
import { perAccountKey } from './perAccountStorage';
import { hasMigratedToPerAccountStorage } from './migrateToPerAccountStorage';
import { writeWalletOwnerHint } from './walletOwnerHint';
import { perfLog, perfOwnerTag } from '../utils/perfLog';

// Per-account namespacing landed with multi-account switching (#288).
// Wallets are scoped to the active Nostr identity so signing into a
// second identity gets a fresh wallet list rather than inheriting the
// previous user's NWC connections. Pre-multi-account installs ran the
// `migrateToPerAccountStorage` helper at first launch which copied the
// global `wallet_list` into `wallet_list_${activePubkey}`.
//
// `_activePubkey` is mirrored from NostrContext via
// `setActivePubkeyForWalletStorage`. When null (rare race during cold
// boot before identity hydrates) we fall back to the bare global key
// so legacy single-account installs keep working until the migration
// completes.
let _activePubkey: string | null = null;

// Subscribers (typically WalletContext) get notified whenever the
// active pubkey changes so they can tear down + re-hydrate the wallet
// list against the new account's namespaced storage. Without this,
// switching identities leaves the previous identity's wallets visible
// in-memory until the next cold start (see #288 review).
//
// `change.startup` is true for the one publish that opens the cold-start
// wallet gate below. WalletContext's startup hydration owns that load, so
// its identity-change hydration skips it rather than loading the list twice.
export interface ActivePubkeyChange {
  startup: boolean;
}
type ActivePubkeyListener = (pk: string | null, change?: ActivePubkeyChange) => void;
const _activePubkeyListeners = new Set<ActivePubkeyListener>();

// Cold-start wallet-owner gate. WalletContext waits here before its first
// wallet-list read, so it reads the real account's `wallet_list_${pubkey}`
// rather than the legacy unsuffixed key — the wallet-leak root cause (#461 /
// Copilot review on #442). It opens once per process, for the real owner:
//   - when NostrContext publishes a signed-in pubkey, or
//   - when auto-login reports its outcome via `resolveStartupWalletOwner` and
//     that owner is already the published one (logged out: null).
// NostrProvider's bootstrap `null` publish on first commit does NOT open it.
// It used to, which started a throwaway hydration for the signed-out key and
// then a second one when the real pubkey landed (#816).
type WalletGateState = 'pending' | 'timedOut' | 'open';
let _gateState: WalletGateState = 'pending';
let _startupOwnerDecided = false;
let _gateResolve: () => void = () => {};
let _gatePromise = new Promise<void>((resolve) => {
  _gateResolve = resolve;
});

/** Returns true when startup was still waiting (the timeout hadn't fired). */
function openWalletGate(owner: string | null): boolean {
  if (_gateState === 'open') return false;
  const startup = _gateState === 'pending';
  _gateState = 'open';
  _gateResolve();
  perfLog(`wallet gate resolved owner=${perfOwnerTag(owner)}${startup ? '' : ' (after timeout)'}`);
  return startup;
}

export function setActivePubkeyForWalletStorage(pk: string | null): void {
  // Same-value publishes are no-ops — including the bootstrap null, which
  // must not open the gate (see above).
  if (_activePubkey === pk) return;
  _activePubkey = pk;
  // A published signed-in pubkey is always the real owner.
  const startup = pk !== null && openWalletGate(pk);
  // Remember the owner for the next cold start once it's a real one.
  if (_gateState === 'open') writeWalletOwnerHint(pk);
  const change: ActivePubkeyChange = { startup };
  for (const listener of _activePubkeyListeners) {
    try {
      listener(pk, change);
    } catch (e) {
      // Don't let one buggy subscriber break the others.
      if (__DEV__) console.warn('[walletStorage] listener threw:', e);
    }
  }
}

/**
 * NostrContext's auto-login outcome: the account whose wallets cold start
 * should load (null = definitely logged out). First call wins. A signed-in
 * owner opens the gate when NostrContext publishes it, so wallets and every
 * other active-pubkey consumer flip to the account in the same commit.
 */
export function resolveStartupWalletOwner(owner: string | null): void {
  if (_startupOwnerDecided) return;
  _startupOwnerDecided = true;
  if (owner !== _activePubkey) return;
  openWalletGate(owner);
  writeWalletOwnerHint(owner);
}

export function isWalletOwnerGateOpen(): boolean {
  return _gateState === 'open';
}

/** Resolves when the gate opens for the real owner — no timeout. */
export function awaitWalletOwnerGateOpen(): Promise<void> {
  return _gateState === 'open' ? Promise.resolve() : _gatePromise;
}

/**
 * Resolves once the cold-start wallet owner is known (see the gate above).
 * Race-fixes the cold-start window where WalletProvider mounts before
 * NostrProvider and would otherwise read the wrong AsyncStorage key.
 *
 * Safe-fallback timeout (default 2 s) means a wedged NostrContext doesn't
 * permanently block wallet UI — the caller falls through to whatever
 * `_activePubkey` is (still null) and hits the legacy unsuffixed key,
 * matching pre-#288 behaviour. The owner's later publish is then an ordinary
 * account change, which re-hydrates for it.
 */
export async function awaitActivePubkeyHydrated(timeoutMs = 2000): Promise<void> {
  if (_gateState !== 'pending') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    _gatePromise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (_gateState === 'pending') {
    _gateState = 'timedOut';
    perfLog(`wallet gate timed out after ${timeoutMs}ms owner=${perfOwnerTag(_activePubkey)}`);
  }
}

/** Test-only: return the gate to its cold-start state. */
export function __resetWalletOwnerGateForTests(): void {
  _gateState = 'pending';
  _startupOwnerDecided = false;
  _gatePromise = new Promise<void>((resolve) => {
    _gateResolve = resolve;
  });
}

export function subscribeActivePubkey(listener: ActivePubkeyListener): () => void {
  _activePubkeyListeners.add(listener);
  return () => {
    _activePubkeyListeners.delete(listener);
  };
}

export function getActivePubkey(): string | null {
  return _activePubkey;
}
const WALLET_LIST_KEY_BASE = 'wallet_list';
const NWC_URL_PREFIX = 'nwc_url_';
const ONCHAIN_XPUB_PREFIX = 'onchain_xpub_';
const ELECTRUM_SERVER_KEY = 'electrum_server';
// Per-account: this points at a wallet id from `wallet_list`, which is
// itself namespaced per identity (see `getWalletList`). A global default
// would let one identity's choice clobber the other's, so mirror the
// same `perAccountKey(...)` scheme. New key (no shipped global value to
// migrate), so it's namespaced inline without a migration step.
const DEFAULT_ONCHAIN_WALLET_ID_KEY_BASE = 'default_onchain_wallet_id_v1';
function defaultOnchainWalletIdKey(): string {
  return perAccountKey(DEFAULT_ONCHAIN_WALLET_ID_KEY_BASE, _activePubkey);
}
const BLOSSOM_SERVER_KEY = 'blossom_server';
const LEGACY_NWC_KEY = 'nwc_connection_url';
const ONBOARDING_KEY = 'onboarding_complete';
const GLOBAL_LIGHTNING_ADDRESS_KEY = 'lightning_address';
// Bumped each time a new one-shot migration step is added to
// `migrateLegacy`. Stored as an integer; any step whose target version
// exceeds the persisted value runs once and then writes the new version.
const STORAGE_MIGRATION_VERSION_KEY = 'storage_migration_version';
const CURRENT_STORAGE_MIGRATION_VERSION = 1;

/** Default Electrum server for on-chain balance/tx lookups (Blockstream, SSL) */
export const DEFAULT_ELECTRUM_SERVER = 'electrum.blockstream.info:50002:s';

/** Default Blossom media server (BUD-01/BUD-02) for image uploads. */
export const DEFAULT_BLOSSOM_SERVER = 'https://blossom.primal.net';

/**
 * SecureStore options for credentials (mnemonics, xpubs, NWC URLs).
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` ensures keychain items are never
 * included in iCloud backups, are only readable after the first unlock
 * following a reboot, and cannot be migrated to a new device. Safer
 * default than the bare SecureStore defaults.
 */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function getWalletList(
  owner: string | null = _activePubkey,
): Promise<WalletMetadata[]> {
  const json = await AsyncStorage.getItem(perAccountKey(WALLET_LIST_KEY_BASE, owner));
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

// Serialize the entire read/modify/write per owner, not just native writes.
// Capture the owner before queuing so account switches cannot redirect a mutation.
const walletListUpdates = new Map<string, Promise<void>>();

function serializeWalletListUpdate<T>(owner: string | null, update: () => Promise<T>): Promise<T> {
  const key = perAccountKey(WALLET_LIST_KEY_BASE, owner);
  const run = (walletListUpdates.get(key) ?? Promise.resolve()).then(update);
  const tail = run.then(
    () => {},
    () => {},
  );
  walletListUpdates.set(key, tail);
  void tail.then(() => {
    if (walletListUpdates.get(key) === tail) walletListUpdates.delete(key);
  });
  return run;
}

async function writeWalletList(wallets: WalletMetadata[], owner: string | null): Promise<void> {
  invalidateBackgroundPaymentScope();
  try {
    await AsyncStorage.setItem(perAccountKey(WALLET_LIST_KEY_BASE, owner), JSON.stringify(wallets));
  } finally {
    invalidateBackgroundPaymentScope();
  }
}

/** Replace a list (initialization/tests). For metadata edits use updateWalletList. */
export function saveWalletList(
  wallets: WalletMetadata[],
  owner: string | null = _activePubkey,
): Promise<void> {
  return serializeWalletListUpdate(owner, () => writeWalletList(wallets, owner));
}

/** A null result skips persistence. The transform must not call queued wallet writes. */
export function updateWalletList(
  update: (wallets: WalletMetadata[]) => WalletMetadata[] | null,
  owner: string | null = _activePubkey,
): Promise<void> {
  return serializeWalletListUpdate(owner, async () => {
    const latest = await getWalletList(owner);
    const updated = update(latest);
    if (updated !== null) await writeWalletList(updated, owner);
  });
}

/**
 * Delete the legacy shared `wallet_list` once it is a pure duplicate (#1746):
 * the per-account migration (#288) copied it to the first account and never
 * removed it, so afterwards it only holds that account's metadata, which a
 * signed-out session or a cold-start gate timeout could render for someone
 * else. Deleted only when (a) the per-account migration has completed and
 * (b) every wallet in it is already in `owner`'s own list — so no account
 * depends on it. A list holding any wallet no account owns (one added while
 * signed out) is kept, as is a corrupt one. Credentials and per-wallet caches
 * are keyed by wallet id and shared with the per-account copy, so they are
 * never touched. Serialised with signed-out writes to the same key, and
 * idempotent: once the key is gone this is a single read.
 */
export function pruneMigratedLegacyWalletList(owner: string): Promise<void> {
  return serializeWalletListUpdate(null, async () => {
    const legacyJson = await AsyncStorage.getItem(WALLET_LIST_KEY_BASE);
    if (legacyJson === null || !(await hasMigratedToPerAccountStorage())) return;
    let legacy: unknown;
    try {
      legacy = JSON.parse(legacyJson);
    } catch {
      return;
    }
    if (!Array.isArray(legacy)) return;
    const owned = new Set((await getWalletList(owner)).map((w) => w.id));
    const duplicate = legacy.every(
      (w: Partial<WalletMetadata> | null) => typeof w?.id === 'string' && owned.has(w.id),
    );
    if (!duplicate) return;
    invalidateBackgroundPaymentScope();
    await AsyncStorage.removeItem(WALLET_LIST_KEY_BASE);
    perfLog(`legacy wallet_list pruned (${legacy.length} wallets owned by the active account)`);
  });
}

// --- NWC ---

export async function saveNwcUrl(walletId: string, url: string): Promise<void> {
  clearEncryptionDecision(`background:${walletId}`);
  invalidateBackgroundPaymentScope();
  try {
    await SecureStore.setItemAsync(`${NWC_URL_PREFIX}${walletId}`, url, SECURE_OPTIONS);
  } finally {
    clearEncryptionDecision(`background:${walletId}`);
    invalidateBackgroundPaymentScope();
  }
}

export async function getNwcUrl(walletId: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${NWC_URL_PREFIX}${walletId}`);
}

export async function deleteNwcUrl(walletId: string): Promise<void> {
  clearEncryptionDecision(`background:${walletId}`);
  invalidateBackgroundPaymentScope();
  try {
    await SecureStore.deleteItemAsync(`${NWC_URL_PREFIX}${walletId}`);
  } finally {
    clearEncryptionDecision(`background:${walletId}`);
    invalidateBackgroundPaymentScope();
  }
}

// --- On-chain (xpub) ---

export async function saveXpub(walletId: string, xpub: string): Promise<void> {
  await SecureStore.setItemAsync(`${ONCHAIN_XPUB_PREFIX}${walletId}`, xpub, SECURE_OPTIONS);
}

export async function getXpub(walletId: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${ONCHAIN_XPUB_PREFIX}${walletId}`);
}

export async function deleteXpub(walletId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${ONCHAIN_XPUB_PREFIX}${walletId}`);
}

// --- CoinOS managed-wallet recovery info (#287) ---
//
// Username + password for the coinos.io account that backs an NWC
// wallet auto-provisioned via `coinosService`. Persisted to SecureStore
// so Wallet Settings → "View recovery info" can re-display the same
// sheet after the initial mandatory recovery-info acknowledgement;
// without this the user has no way to recover the account if the
// device is wiped.

const COINOS_RECOVERY_PREFIX = 'coinos_recovery_';

export interface CoinosRecoveryInfo {
  /** Full API base URL — includes the `/api` path suffix (e.g.
   *  `https://coinos.io/api`) since that's what `coinosService` posts
   *  against. May be a self-hosted URL the user pointed LP at. To
   *  render a host for a lud16 / sign-in URL, strip the `/api` —
   *  `hostFromBaseUrl` in coinosService handles this. */
  baseUrl: string;
  username: string;
  password: string;
  /** ISO-8601 timestamp captured when the wallet was provisioned. */
  createdAt: string;
}

export async function saveCoinosRecovery(
  walletId: string,
  info: CoinosRecoveryInfo,
): Promise<void> {
  await SecureStore.setItemAsync(
    `${COINOS_RECOVERY_PREFIX}${walletId}`,
    JSON.stringify(info),
    SECURE_OPTIONS,
  );
}

export async function getCoinosRecovery(walletId: string): Promise<CoinosRecoveryInfo | null> {
  const raw = await SecureStore.getItemAsync(`${COINOS_RECOVERY_PREFIX}${walletId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CoinosRecoveryInfo>;
    if (!parsed.baseUrl || !parsed.username || !parsed.password) return null;
    return {
      baseUrl: parsed.baseUrl,
      username: parsed.username,
      password: parsed.password,
      createdAt: parsed.createdAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function deleteCoinosRecovery(walletId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${COINOS_RECOVERY_PREFIX}${walletId}`);
}

// --- On-chain (mnemonic) ---

const ONCHAIN_MNEMONIC_PREFIX = 'onchain_mnemonic_';

export async function saveMnemonic(walletId: string, mnemonic: string): Promise<void> {
  await SecureStore.setItemAsync(`${ONCHAIN_MNEMONIC_PREFIX}${walletId}`, mnemonic, SECURE_OPTIONS);
}

/** Existence check only: never expose signing material to metadata migrations. */
export async function hasMnemonic(walletId: string): Promise<boolean> {
  return (await SecureStore.getItemAsync(`${ONCHAIN_MNEMONIC_PREFIX}${walletId}`)) != null;
}

export async function getMnemonic(walletId: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${ONCHAIN_MNEMONIC_PREFIX}${walletId}`);
}

export async function deleteMnemonic(walletId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${ONCHAIN_MNEMONIC_PREFIX}${walletId}`);
}

// Best-effort AsyncStorage.multiRemove: if the batch rejects (a transient
// storage error), log once and fall back to per-key removeItem so one bad key
// can't strand the whole set — and the caller's wipe can still finish. Backs
// privacy wipes, so failures are never swallowed silently. Absent keys no-op.
export async function bestEffortMultiRemove(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await AsyncStorage.multiRemove(keys);
  } catch (err) {
    console.warn(`bestEffortMultiRemove: multiRemove failed (${keys.length} keys), per-key`, err);
    const results = await Promise.allSettled(keys.map((k) => AsyncStorage.removeItem(k)));
    // Surface any per-key failures too — a swallowed reject here could leave
    // sensitive residue on disk, defeating the point of the fallback.
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`bestEffortMultiRemove: removeItem failed for ${keys[i]}`, r.reason);
      }
    });
  }
}

// Per-wallet AsyncStorage caches keyed by walletId (balance / tx history /
// receipt-dedup set). Removed alongside the wallet so a deleted wallet leaves
// no balance or transaction residue behind — a privacy concern on shared
// devices.
export async function deleteWalletCaches(walletId: string): Promise<void> {
  await bestEffortMultiRemove([
    `balance_${walletId}`,
    `txs_${walletId}`,
    `seenReceipts_${walletId}`,
  ]);
}

// --- Electrum / block-explorer server ---

export async function getElectrumServer(): Promise<string> {
  const saved = await AsyncStorage.getItem(ELECTRUM_SERVER_KEY);
  return saved || DEFAULT_ELECTRUM_SERVER;
}

export async function setElectrumServer(url: string): Promise<void> {
  await AsyncStorage.setItem(ELECTRUM_SERVER_KEY, url);
}

// --- Default on-chain wallet (for Boltz refunds + future on-chain destinations) ---

export async function getDefaultOnchainWalletId(): Promise<string | null> {
  return AsyncStorage.getItem(defaultOnchainWalletIdKey());
}

export async function setDefaultOnchainWalletId(walletId: string | null): Promise<void> {
  if (walletId === null) {
    await AsyncStorage.removeItem(defaultOnchainWalletIdKey());
  } else {
    await AsyncStorage.setItem(defaultOnchainWalletIdKey(), walletId);
  }
}

// --- Blossom media server ---

export async function getBlossomServer(): Promise<string> {
  const saved = await AsyncStorage.getItem(BLOSSOM_SERVER_KEY);
  return (saved && saved.trim()) || DEFAULT_BLOSSOM_SERVER;
}

export async function setBlossomServer(url: string): Promise<void> {
  await AsyncStorage.setItem(BLOSSOM_SERVER_KEY, url);
}

// Ordered Blossom server list (#1149): the first is the primary, the rest
// are backups that uploads are mirrored to. Device-level, like the single
// server it replaces (which becomes the primary on first read).
const BLOSSOM_SERVERS_KEY = 'blossom_servers_v1';

/** The saved list, or null when the user has never set one on this device. */
export async function getSavedBlossomServers(): Promise<string[] | null> {
  try {
    const raw = await AsyncStorage.getItem(BLOSSOM_SERVERS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return null;
    const list = parsed.filter((u): u is string => typeof u === 'string' && u.trim() !== '');
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

/** The single server the user explicitly saved before lists existed, or
 * null if they never changed the default. */
export async function getSavedLegacyBlossomServer(): Promise<string | null> {
  const saved = await AsyncStorage.getItem(BLOSSOM_SERVER_KEY).catch(() => null);
  return saved && saved.trim() ? saved.trim() : null;
}

// The list an identity last published (or adopted from its published
// kind-10063), so the screen can tell whether the current list still needs
// publishing. Per account: one identity publishing says nothing about another.
export const BLOSSOM_SERVERS_PUBLISHED_KEY_BASE = 'blossom_servers_published_v1';

export async function getPublishedBlossomServers(pubkey: string): Promise<string[] | null> {
  try {
    const raw = await AsyncStorage.getItem(
      perAccountKey(BLOSSOM_SERVERS_PUBLISHED_KEY_BASE, pubkey),
    );
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : null;
  } catch {
    return null;
  }
}

// created_at of the newest kind-10063 an identity has seen or published, so a
// later publish is signed after it even when the pre-publish lookup fails.
export const BLOSSOM_SERVERS_CREATED_AT_KEY_BASE = 'blossom_servers_created_at_v1';

export async function getBlossomServersCreatedAt(pubkey: string): Promise<number> {
  const raw = await AsyncStorage.getItem(
    perAccountKey(BLOSSOM_SERVERS_CREATED_AT_KEY_BASE, pubkey),
  ).catch(() => null);
  return Number(raw) || 0;
}

export async function setBlossomServersCreatedAt(pubkey: string, createdAt: number): Promise<void> {
  await AsyncStorage.setItem(
    perAccountKey(BLOSSOM_SERVERS_CREATED_AT_KEY_BASE, pubkey),
    String(createdAt),
  ).catch(() => {});
}

export async function setPublishedBlossomServers(pubkey: string, urls: string[]): Promise<void> {
  await AsyncStorage.setItem(
    perAccountKey(BLOSSOM_SERVERS_PUBLISHED_KEY_BASE, pubkey),
    JSON.stringify(urls),
  );
}

/** Servers to upload to, primary first. Never empty. */
export async function getBlossomServers(): Promise<string[]> {
  return (await getSavedBlossomServers()) ?? [await getBlossomServer()];
}

export async function setBlossomServers(urls: string[]): Promise<void> {
  const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  await AsyncStorage.setItem(BLOSSOM_SERVERS_KEY, JSON.stringify(list));
  // Keep the legacy single-server key in step with the primary.
  if (list[0]) await AsyncStorage.setItem(BLOSSOM_SERVER_KEY, list[0]);
}

// --- Onboarding ---

export async function isOnboarded(): Promise<boolean> {
  const value = await AsyncStorage.getItem(ONBOARDING_KEY);
  return value === 'true';
}

export async function setOnboarded(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
}

// --- Utilities ---

export function generateWalletId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let _migrationQueue: Promise<void> = Promise.resolve();
/**
 * Migrate legacy single-wallet storage to multi-wallet format.
 * Also backfills `walletType` for wallets created before on-chain support.
 * Idempotent — safe to call on every startup.
 *
 * Deferred while no identity is published: NostrContext publishes null at
 * mount and the real pubkey later, so a null-owner run would write the wallet
 * under the unsuffixed key (never read once the pubkey lands) and then delete
 * the legacy credential. The legacy key stays put until WalletContext re-runs
 * this for the eventual identity. Runs are serialised so two identities
 * published back to back can't both claim the same legacy wallet.
 */
export function migrateLegacy(owner: string | null = _activePubkey): Promise<void> {
  const run = _migrationQueue.then(() => (owner ? migrateLegacyFor(owner) : undefined));
  _migrationQueue = run.catch(() => {});
  return run;
}

async function migrateLegacyFor(owner: string): Promise<void> {
  // 1. Legacy single-wallet → multi-wallet migration.
  // Order: write the new wallet list + persist the NWC URL first, then delete
  // the legacy key. If a crash interrupts the migration, the legacy key is
  // still present and the next startup retries from scratch. Deleting first
  // could permanently lose the user's NWC URL on a partial write.
  const legacyUrl = await SecureStore.getItemAsync(LEGACY_NWC_KEY);
  if (legacyUrl) {
    const existingList = await getWalletList(owner);
    if (existingList.length === 0) {
      const id = generateWalletId();
      const wallet: WalletMetadata = {
        id,
        alias: 'My Wallet',
        theme: 'lightning-piggy',
        order: 0,
        walletType: 'nwc',
        lightningAddress: null,
      };
      await saveNwcUrl(id, legacyUrl);
      await updateWalletList((list) => (list.length === 0 ? [wallet] : null), owner);
      await setOnboarded();
      // Only after the new records are durably written do we drop the
      // legacy key. If this delete fails, next startup sees existingList
      // non-empty and skips re-migration — we just clean up the orphan key.
      await SecureStore.deleteItemAsync(LEGACY_NWC_KEY);
    } else {
      // List is already populated — legacy key is a stale leftover. Safe
      // to delete: its data has already been migrated (or the user added
      // new wallets after). Not deleting would mean migrateLegacy re-reads
      // it forever but never acts on it; cleaning up is better.
      await SecureStore.deleteItemAsync(LEGACY_NWC_KEY);
    }
  }

  // 2. Backfill walletType for wallets that predate on-chain support
  await updateWalletList((wallets) => {
    if (wallets.every((w) => w.walletType)) return null;
    return wallets.map((w) => (w.walletType ? w : { ...w, walletType: 'nwc' as const }));
  }, owner);

  // 3. Versioned migrations. See #169 for the original driver.
  const persistedVersionRaw = await AsyncStorage.getItem(STORAGE_MIGRATION_VERSION_KEY);
  const persistedVersion = persistedVersionRaw ? parseInt(persistedVersionRaw, 10) || 0 : 0;

  // Each step sets this to `false` when it needs to defer (e.g. waiting
  // for prerequisite state to exist) so we don't advance the version
  // past work that hasn't run yet. Next cold start re-evaluates.
  let canAdvance = true;

  if (persistedVersion < 1) {
    // v1: Lightning Address moves from a single global field into each
    // wallet's metadata (#169). Copy the global value into any wallet
    // that doesn't already have its own address, preserving wallet-
    // specific addresses parsed from NWC `lud16=` query strings, then
    // remove the global storage key — nothing reads it anymore.
    const globalAddress = await AsyncStorage.getItem(GLOBAL_LIGHTNING_ADDRESS_KEY);
    if (globalAddress) {
      await updateWalletList((list) => {
        if (list.length === 0) {
          // Defer until a wallet exists to own the legacy address.
          canAdvance = false;
          return null;
        }
        return list.some((w) => !w.lightningAddress)
          ? list.map((w) => (w.lightningAddress ? w : { ...w, lightningAddress: globalAddress }))
          : null;
      }, owner);
      if (canAdvance) await AsyncStorage.removeItem(GLOBAL_LIGHTNING_ADDRESS_KEY);
    }
  }

  if (canAdvance && persistedVersion < CURRENT_STORAGE_MIGRATION_VERSION) {
    await AsyncStorage.setItem(
      STORAGE_MIGRATION_VERSION_KEY,
      String(CURRENT_STORAGE_MIGRATION_VERSION),
    );
  }
}
