/**
 * On-chain Bitcoin wallet service using BDK (Bitcoin Development Kit).
 *
 * BDK handles: xpub derivation, Electrum sync, balance, transaction
 * history with amounts/directions/timestamps, UTXO management.
 *
 * Forked from Peach2Peach/bdk-rn with RN 0.83 fix.
 */

import {
  Wallet,
  Blockchain,
  Descriptor,
  DatabaseConfig,
  DescriptorSecretKey,
  Mnemonic,
  Transaction,
  TxBuilder,
  Address,
} from 'bdk-rn';
import { Network, AddressIndex, KeychainKind } from 'bdk-rn/lib/lib/enums';
import AsyncStorage from '@react-native-async-storage/async-storage';
import bs58check from 'bs58check';
import { getXpub, getMnemonic, getElectrumServer } from './walletStorageService';
import { classifySendFeeError, type SendFeeEstimate } from '../utils/sendFeeEstimate';

import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { yieldMacrotask } from '../utils/yieldingBatch';
import { noteOnchainSyncSuccess } from './onchainSyncBackoff';

const ADDRESS_INDEX_PREFIX = 'onchain_addr_index_';

const ESPLORA_TIMEOUT_MS = 8000;

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the Esplora REST base URL from the user's configured Electrum
 * server, so single-address syncs use the same provider as the rest of the
 * wallet. Both Blockstream and mempool.space publish an Esplora-compatible
 * REST API alongside their Electrum service. Custom Electrum hosts with no
 * known Esplora counterpart throw so the user knows to pick a supported
 * server rather than silently routing their address to a third party.
 */
async function getEsploraBase(): Promise<string> {
  const electrum = await getElectrumServer();
  const host = electrum.split(':')[0].toLowerCase();
  if (host.includes('blockstream.info')) return 'https://blockstream.info/api';
  if (host.includes('mempool.space')) return 'https://mempool.space/api';
  throw new Error(
    `No Esplora REST endpoint known for Electrum host "${host}". ` +
      `Set the Electrum server to electrum.blockstream.info or a mempool.space host.`,
  );
}

// ─── xpub conversion ─────────────────────────────────────────────────────────

const YPUB_HEX = '049d7cb2';
const ZPUB_HEX = '04b24746';

function byteToHex(b: number): string {
  return b.toString(16).padStart(2, '0');
}

function toXpub(extPubKey: string): string {
  const trimmed = extPubKey.trim();
  // Case-insensitive check so pasted/scanned XPUB… variants don't fall
  // through to bs58check.decode and throw on the first uppercase char.
  if (trimmed.slice(0, 4).toLowerCase() === 'xpub') return trimmed;

  const decoded = bs58check.decode(trimmed);
  const versionHex =
    byteToHex(decoded[0]) + byteToHex(decoded[1]) + byteToHex(decoded[2]) + byteToHex(decoded[3]);

  if (versionHex === YPUB_HEX || versionHex === ZPUB_HEX) {
    const data = new Uint8Array(decoded);
    data[0] = 0x04;
    data[1] = 0x88;
    data[2] = 0xb2;
    data[3] = 0x1e;
    return bs58check.encode(data);
  }
  return trimmed;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OnchainTransaction {
  txid: string;
  type: 'incoming' | 'outgoing';
  amount: number;
  confirmed: boolean;
  blockHeight: number | null;
  timestamp: number | null;
}

/** Map a BDK transaction to our OnchainTransaction type and sort: pending (no timestamp) first, then confirmed in newest-first order. */
async function mapAndSortTransactions(txList: any[]): Promise<OnchainTransaction[]> {
  const pacing = createYieldScheduler({ safetyEvery: 32 });
  const transactions: OnchainTransaction[] = [];
  try {
    for (const tx of txList) {
      const net = tx.received - tx.sent;
      transactions.push({
        txid: tx.txid,
        type: net >= 0 ? 'incoming' : 'outgoing',
        amount: Math.abs(net),
        confirmed: tx.confirmationTime != null,
        blockHeight: tx.confirmationTime?.height ?? null,
        timestamp: tx.confirmationTime?.timestamp ?? null,
      });
      await pacing.maybeYield();
    }
    return sortTransactions(transactions);
  } finally {
    pacing.dispose();
  }
}

function sortTransactions(transactions: OnchainTransaction[]): OnchainTransaction[] {
  return transactions.sort((a, b) => {
    if (a.timestamp === null && b.timestamp === null) return 0;
    if (a.timestamp === null) return -1;
    if (b.timestamp === null) return 1;
    return b.timestamp - a.timestamp;
  });
}

/** BDK's Electrum/script scan runs on a native worker. Return control to
 * the UI before dispatch and after completion, before processing its result. */
async function syncWallet(wallet: Wallet, chain: Blockchain): Promise<void> {
  await yieldMacrotask();
  await wallet.sync(chain);
  await yieldMacrotask();
}

// ─── Internal state ───────────────────────────────────────────────────────────

const bdkWallets = new Map<string, Wallet>();
let blockchain: Blockchain | null = null;
let blockchainGeneration = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseElectrumUrl(server: string): string {
  const parts = server.split(':');
  const host = parts[0];
  const port = parseInt(parts[1], 10) || 50002;
  const protocol = parts[2] || 's';
  return `${protocol === 's' ? 'ssl' : 'tcp'}://${host}:${port}`;
}

async function getBlockchain(): Promise<Blockchain> {
  if (blockchain) return blockchain;

  const generation = blockchainGeneration;
  const serverStr = await getElectrumServer();
  if (generation !== blockchainGeneration) throw new Error('Electrum settings changed');
  const url = parseElectrumUrl(serverStr);

  const created = await new Blockchain().create({
    url,
    sock5: null,
    retry: 3,
    timeout: 10,
    stopGap: 20,
    // Verify the TLS certificate hostname matches the server. The BDK
    // default is false — leaving it off allows a network attacker to MITM
    // balance reads and silently drop/alter broadcast calls. We require
    // hostname verification on all Electrum SSL connections.
    validateDomain: true,
  });
  // A native connection can finish after settings changed. Never publish that
  // stale endpoint into the shared wallet client cache.
  if (generation !== blockchainGeneration) throw new Error('Electrum settings changed');
  blockchain = created;
  return created;
}

/** Independent chain tip for validating swap refund deadlines; no wallet required. */
export async function getBlockHeight(): Promise<number> {
  const chain = await getBlockchain();
  try {
    return await chain.getHeight();
  } catch (error) {
    // A suspended app or changed network can leave the cached socket dead.
    // Do not discard a newer connection installed by a concurrent request.
    if (blockchain === chain) disconnectElectrum();
    throw error;
  }
}

/** Unrounded sat/vB estimate from the configured Electrum server for
 *  `targetBlocks`. The reverse-swap claim is built with this (#1174). */
export async function getClaimFeeEstimate(targetBlocks: number): Promise<number> {
  const chain = await getBlockchain();
  try {
    const rate = (await chain.estimateFee(targetBlocks)).asSatPerVb();
    if (!Number.isFinite(rate) || rate <= 0 || rate > 5000)
      throw new Error('Invalid Electrum claim fee estimate');
    return rate;
  } catch (error) {
    if (blockchain === chain) disconnectElectrum();
    throw error;
  }
}

/** Fee estimate from the configured Electrum server, not the swap operator. */
export async function getSwapClaimFeeRate(): Promise<number> {
  return Math.max(2, Math.ceil(await getClaimFeeEstimate(2)));
}

/**
 * Whether the configured backend's Esplora REST twin already knows `txId`
 * (mempool or chain). `null` when it can't tell — a custom Electrum host
 * with no Esplora counterpart, or a network/HTTP error — so callers treat
 * it as "unknown", never as "absent".
 */
export async function isTxKnown(txId: string): Promise<boolean | null> {
  if (!/^[0-9a-f]{64}$/i.test(txId)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESPLORA_TIMEOUT_MS);
  try {
    const base = await getEsploraBase();
    // Not `/tx/:txid/status`: Esplora answers that 200 `{confirmed:false}`
    // even for a tx it has never seen. `/tx/:txid` is 404 until it's known.
    const res = await fetch(`${base}/tx/${txId}`, { signal: controller.signal });
    if (res.ok) return true;
    return res.status === 404 ? false : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Heuristic check for a Bitcoin mainnet on-chain address (P2PKH, P2SH,
 * native SegWit v0, Taproot). Doesn't verify checksum — that's done by
 * BDK when the descriptor is built. Used to branch between xpub import
 * and single-address import in getBdkWallet.
 */
function looksLikeBitcoinAddress(s: string): boolean {
  const trimmed = s.trim();
  return (
    /^bc1[qp][a-z0-9]{6,87}$/.test(trimmed) || /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(trimmed)
  );
}

async function getBdkWallet(walletId: string): Promise<Wallet> {
  const cached = bdkWallets.get(walletId);
  if (cached) return cached;

  let descriptor: Descriptor;
  let changeDescriptor: Descriptor;

  // Try mnemonic first (hot wallet), then xpub (watch-only)
  const mnemonic = await getMnemonic(walletId);
  if (mnemonic) {
    if (__DEV__) console.log('[BDK] Creating hot wallet from mnemonic');
    const bdkMnemonic = await new Mnemonic().fromString(mnemonic);
    const secretKey = await new DescriptorSecretKey().create(Network.Bitcoin, bdkMnemonic);
    descriptor = await new Descriptor().newBip84(secretKey, KeychainKind.External, Network.Bitcoin);
    changeDescriptor = await new Descriptor().newBip84(
      secretKey,
      KeychainKind.Internal,
      Network.Bitcoin,
    );
  } else {
    const raw = await getXpub(walletId);
    if (!raw) throw new Error(`No xpub, mnemonic, or address found for wallet ${walletId}`);
    const trimmed = raw.trim();

    if (looksLikeBitcoinAddress(trimmed)) {
      // Single-address watch-only wallet. Use BDK's `addr()` descriptor
      // for both external and change so the wallet tracks just this one
      // UTXO set. We can never send from it (no keys), and
      // `getNextReceiveAddress` always returns the same address — that's
      // the whole point for this mode.
      if (__DEV__) console.log('[BDK] Creating watch-only wallet from single address');
      const addrDescriptor = `addr(${trimmed})`;
      descriptor = await new Descriptor().create(addrDescriptor, Network.Bitcoin);
      changeDescriptor = await new Descriptor().create(addrDescriptor, Network.Bitcoin);
    } else {
      const xpub = toXpub(trimmed);
      if (__DEV__) console.log('[BDK] Creating watch-only wallet from xpub');
      descriptor = await new Descriptor().create(`wpkh(${xpub}/0/*)`, Network.Bitcoin);
      changeDescriptor = await new Descriptor().create(`wpkh(${xpub}/1/*)`, Network.Bitcoin);
    }
  }

  const dbConfig = await new DatabaseConfig().memory();
  const wallet = await new Wallet().create(descriptor, changeDescriptor, Network.Bitcoin, dbConfig);

  if (__DEV__) console.log('[BDK] Wallet created:', wallet.id);
  bdkWallets.set(walletId, wallet);
  return wallet;
}

// ─── Fee estimation ──────────────────────────────────────────────────────────

const MEMPOOL_API = 'https://mempool.space/api/v1/fees/recommended';
const TYPICAL_VBYTES = 140; // 1-in-1-out native SegWit

let cachedFees: { fast: number; medium: number; slow: number; timestamp: number } | null = null;
const FEE_CACHE_MS = 60_000; // 1 minute

/**
 * Fetch recommended fee rates from mempool.space.
 * Returns estimated transaction fees in sats for a typical 1-in-1-out tx.
 */
export async function estimateOnchainFee(): Promise<{
  fast: number;
  medium: number;
  slow: number;
}> {
  if (cachedFees && Date.now() - cachedFees.timestamp < FEE_CACHE_MS) {
    return cachedFees;
  }

  try {
    const res = await fetch(MEMPOOL_API);
    if (!res.ok) throw new Error(`mempool.space API error: ${res.status}`);
    const data = await res.json();

    const fees = {
      fast: Math.ceil((data.fastestFee ?? 5) * TYPICAL_VBYTES),
      medium: Math.ceil((data.halfHourFee ?? 3) * TYPICAL_VBYTES),
      slow: Math.ceil((data.hourFee ?? 1) * TYPICAL_VBYTES),
      timestamp: Date.now(),
    };
    cachedFees = fees;
    return fees;
  } catch (e) {
    console.warn('estimateOnchainFee failed:', e);
    // Fallback estimate
    return { fast: 700, medium: 420, slow: 140 };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a watch-only import — either an extended public key (xpub/ypub/
 * zpub) or a single Bitcoin mainnet on-chain address (bech32m Taproot,
 * native SegWit, or legacy). Returns `null` if valid, a user-friendly
 * error string otherwise.
 */
export function validateOnchainImport(input: string): string | null {
  const trimmed = input.trim();
  if (looksLikeBitcoinAddress(trimmed)) {
    // Address looks syntactically plausible. BDK will reject a bad
    // checksum when the descriptor is built; surfacing a pre-check error
    // here would duplicate that without adding value.
    return null;
  }
  return validateXpub(trimmed);
}

export function validateXpub(extPubKey: string): string | null {
  const trimmed = extPubKey.trim();
  if (!/^[xyzXYZ]pub[A-Za-z0-9]{100,112}$/.test(trimmed)) {
    return 'Invalid extended public key or on-chain address.';
  }
  // Decode with bs58check so we validate both the base58 charset and the
  // checksum. A typo-ridden xpub that passes the shape regex would otherwise
  // throw later from toXpub() / Descriptor.create with a confusing native
  // error; catch it here and return a user-friendly message.
  try {
    const decoded = bs58check.decode(trimmed);
    // Must be 78 bytes: 4 version + 1 depth + 4 fingerprint + 4 child + 32 chain + 33 key.
    if (decoded.length !== 78) {
      return 'Invalid extended public key (wrong length after decode).';
    }
    const versionHex =
      byteToHex(decoded[0]) + byteToHex(decoded[1]) + byteToHex(decoded[2]) + byteToHex(decoded[3]);
    const isXpub = versionHex === '0488b21e';
    if (!isXpub && versionHex !== YPUB_HEX && versionHex !== ZPUB_HEX) {
      return 'Unsupported extended public key version (expected xpub/ypub/zpub).';
    }
  } catch {
    return 'Invalid extended public key (checksum or encoding error).';
  }
  return null;
}

/**
 * If the wallet was imported as a single on-chain address, return it;
 * otherwise null. Used to branch single-address wallets onto a
 * BDK-independent path (see `syncSingleAddressViaEsplora`).
 */
async function getSingleAddress(walletId: string): Promise<string | null> {
  const raw = await getXpub(walletId);
  if (!raw) return null;
  const trimmed = raw.trim();
  return looksLikeBitcoinAddress(trimmed) ? trimmed : null;
}

/**
 * Fetch balance + tx history for a single address via an Esplora REST API
 * (Blockstream or mempool.space — whichever host the user has configured
 * their Electrum server with). We bypass BDK for single-address wallets
 * because BDK's `addr(...)` descriptor path has brittle behaviour with
 * bech32 addresses in bdk-rn 0.30 (issue #86: wallet stays Disconnected
 * with a null balance). A single address is trivially queryable over HTTP
 * — no descriptor, no sync loop, no Electrum TLS to manage — and
 * single-address imports are watch-only so we never need the sign /
 * derive features BDK provides.
 */
async function syncSingleAddressViaEsplora(address: string): Promise<{
  balance: number;
  transactions: OnchainTransaction[];
}> {
  const base = await getEsploraBase();
  const encoded = encodeURIComponent(address);

  // Balance is critical — fail the refresh if this hangs or errors.
  const addrData = await fetchJsonWithTimeout<{
    chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
  }>(`${base}/address/${encoded}`, ESPLORA_TIMEOUT_MS);
  const confirmed = addrData.chain_stats.funded_txo_sum - addrData.chain_stats.spent_txo_sum;
  const mempool = addrData.mempool_stats.funded_txo_sum - addrData.mempool_stats.spent_txo_sum;
  const balance = confirmed + mempool;

  // Tx history is best-effort — a slow /txs must never block the balance
  // we already have. Note: Esplora's /address/:addr/txs returns only the
  // most recent ~25 txs; for watch-only imports this is acceptable,
  // pagination via /txs/chain/:last_seen_txid is a future enhancement.
  let txsData: {
    txid: string;
    status: { confirmed: boolean; block_time?: number; block_height?: number };
    vin: { prevout?: { scriptpubkey_address?: string; value?: number } }[];
    vout: { scriptpubkey_address?: string; value: number }[];
  }[] = [];
  try {
    txsData = await fetchJsonWithTimeout(`${base}/address/${encoded}/txs`, ESPLORA_TIMEOUT_MS);
  } catch (error) {
    console.warn(`Esplora /txs fetch failed for ${address}`, error);
  }
  const transactions: OnchainTransaction[] = [];
  const pacing = createYieldScheduler({ safetyEvery: 32 });
  try {
    for (const tx of txsData) {
      let sent = 0;
      let received = 0;
      for (const input of tx.vin) {
        if (input.prevout?.scriptpubkey_address === address) sent += input.prevout.value ?? 0;
        await pacing.maybeYield();
      }
      for (const output of tx.vout) {
        if (output.scriptpubkey_address === address) received += output.value;
        await pacing.maybeYield();
      }
      const net = received - sent;
      transactions.push({
        txid: tx.txid,
        type: net >= 0 ? 'incoming' : 'outgoing',
        amount: Math.abs(net),
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height ?? null,
        timestamp: tx.status.block_time ?? null,
      });
      await pacing.maybeYield();
    }
    sortTransactions(transactions);
  } finally {
    pacing.dispose();
  }

  return { balance, transactions };
}

export async function getNextReceiveAddress(walletId: string): Promise<string> {
  // Single-address wallets have no key material, so there's no "next"
  // address to derive — always return the configured one.
  const single = await getSingleAddress(walletId);
  if (single) return single;

  const wallet = await getBdkWallet(walletId);
  const info = await wallet.getAddress(AddressIndex.New);
  return await info.address.asString();
}

/**
 * Sync once and return both balance and transactions.
 * Avoids double Electrum sync when fetching both.
 */
export async function syncAndRefresh(walletId: string): Promise<{
  balance: number | null;
  transactions: OnchainTransaction[];
  ok: boolean;
}> {
  try {
    const single = await getSingleAddress(walletId);
    if (single) {
      const result = await syncSingleAddressViaEsplora(single);
      noteOnchainSyncSuccess(walletId); // lifts the background poll's backoff
      return { balance: result.balance, transactions: result.transactions, ok: true };
    }

    const wallet = await getBdkWallet(walletId);
    const chain = await getBlockchain();
    await syncWallet(wallet, chain);

    const bal = await wallet.getBalance();
    const txList = await wallet.listTransactions(false);
    noteOnchainSyncSuccess(walletId);

    return { balance: bal.total, transactions: await mapAndSortTransactions(txList), ok: true };
  } catch (e) {
    // Return ok: false so callers can choose to keep their cached state
    // rather than overwriting it with empty values on transient Electrum
    // failures (the UI would otherwise flash to "No transactions").
    console.warn('onchainService.syncAndRefresh failed:', e);
    disconnectElectrum();
    return { balance: null, transactions: [], ok: false };
  }
}

export async function getBalance(walletId: string): Promise<number | null> {
  const result = await syncAndRefresh(walletId);
  return result.balance;
}

export async function getTransactions(walletId: string): Promise<OnchainTransaction[]> {
  try {
    const single = await getSingleAddress(walletId);
    if (single) {
      const result = await syncSingleAddressViaEsplora(single);
      return result.transactions;
    }

    const wallet = await getBdkWallet(walletId);
    const chain = await getBlockchain();
    await syncWallet(wallet, chain);

    const txList = await wallet.listTransactions(false);

    return await mapAndSortTransactions(txList);
  } catch (e) {
    console.warn('onchainService.getTransactions failed:', e);
    disconnectElectrum();
    return [];
  }
}

/** Check if a wallet is watch-only (no mnemonic stored). */
export async function isWatchOnly(walletId: string): Promise<boolean> {
  const mnemonic = await getMnemonic(walletId);
  return !mnemonic;
}

/**
 * Send on-chain Bitcoin from a hot wallet.
 * Only works for wallets with stored mnemonics (not watch-only).
 */
const MIN_FEE_RATE = 1;
const MAX_FEE_RATE = 500;
/** Fee rate (sat/vB) `sendTransaction` uses when the caller doesn't pick one. */
export const DEFAULT_SEND_FEE_RATE = 2;

// Placeholder scripts for fee dry-runs: a Taproot recipient (Boltz lockups are
// P2TR; BIP-86 test vector) and a P2WPKH change output (BIP-173 test vector,
// the same type as the BIP-84 wallet's change). Pinning the change script
// stops BDK deriving — and burning — a fresh change address per estimate.
const DRY_RUN_RECIPIENT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const DRY_RUN_CHANGE = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/**
 * Miner fee `sendTransaction` would pay to send `amountSats` from this wallet
 * to `toAddress` (default: a Taproot placeholder, e.g. a Boltz lockup) at
 * `feeRate`: builds (never signs or broadcasts) the transaction against the
 * wallet's last-synced UTXOs, so multi-input sends are priced honestly. A
 * guessed size could badly under-state a multi-input send, so a failed build
 * is reported, never estimated — `insufficient` when BDK can't fund it.
 */
export async function estimateSendFeeResult(
  walletId: string,
  amountSats: number,
  { toAddress = DRY_RUN_RECIPIENT, feeRate = DEFAULT_SEND_FEE_RATE } = {},
): Promise<SendFeeEstimate> {
  try {
    const wallet = await getBdkWallet(walletId);
    const recipient = await (await new Address().create(toAddress)).scriptPubKey();
    const change = await (await new Address().create(DRY_RUN_CHANGE)).scriptPubKey();
    let txBuilder = await new TxBuilder().create();
    txBuilder = await txBuilder.addRecipient(recipient, amountSats);
    txBuilder = await txBuilder.feeRate(feeRate);
    txBuilder = await txBuilder.drainTo(change);
    const result = await txBuilder.finish(wallet);
    const fee = result.txDetails.fee ?? (await result.psbt.feeAmount());
    if (Number.isSafeInteger(fee) && fee > 0) return { kind: 'fee', feeSats: fee };
  } catch (e) {
    const failure = classifySendFeeError(e);
    if (failure.kind === 'error') console.warn('estimateSendFee: dry-run failed:', e);
    return failure;
  }
  return { kind: 'error' };
}

/** {@link estimateSendFeeResult} as a bare fee — null when it can't be built. */
export async function estimateSendFee(
  walletId: string,
  amountSats: number,
  feeRate: number = DEFAULT_SEND_FEE_RATE,
): Promise<number | null> {
  const result = await estimateSendFeeResult(walletId, amountSats, { feeRate });
  return result.kind === 'fee' ? result.feeSats : null;
}

/**
 * `onBroadcastAttempted` fires just before the first broadcast. From then on
 * the transaction may already be in the mempool, so a caller must treat ANY
 * later error (including a lost Electrum reply) as an unknown outcome rather
 * than a failure (#1778). Errors before it — sync, build, insufficient funds —
 * mean nothing was sent.
 */
export async function sendTransaction(
  walletId: string,
  toAddress: string,
  amountSats: number,
  feeRate: number = DEFAULT_SEND_FEE_RATE,
  onBroadcastAttempted?: () => void,
): Promise<string> {
  console.log(
    `[BDK] sendTransaction enter walletId=${walletId} to=${toAddress} sats=${amountSats}`,
  );
  const watchOnly = await isWatchOnly(walletId);
  console.log(`[BDK] sendTransaction isWatchOnly=${watchOnly}`);
  if (watchOnly) {
    throw new Error('Cannot send from a watch-only wallet — no signing key available');
  }
  if (feeRate < MIN_FEE_RATE || feeRate > MAX_FEE_RATE) {
    throw new Error(
      `Fee rate must be between ${MIN_FEE_RATE} and ${MAX_FEE_RATE} sat/vB, got ${feeRate}`,
    );
  }

  const wallet = await getBdkWallet(walletId);
  console.log('[BDK] sendTransaction getBdkWallet complete');

  // Always create a fresh Electrum connection for sends to avoid stale state
  console.log('[BDK] sendTransaction: creating fresh Electrum connection');
  disconnectElectrum();
  const chain = await getBlockchain();
  console.log('[BDK] sendTransaction: syncing wallet');
  await syncWallet(wallet, chain);
  console.log('[BDK] sendTransaction: sync complete');

  console.log('[BDK] sendTransaction parsing address');
  const address = await new Address().create(toAddress);
  const script = await address.scriptPubKey();

  console.log('[BDK] sendTransaction building tx');
  let txBuilder = await new TxBuilder().create();
  txBuilder = await txBuilder.addRecipient(script, amountSats);
  txBuilder = await txBuilder.feeRate(feeRate);

  console.log('[BDK] sendTransaction finishing');
  const result = await txBuilder.finish(wallet);
  console.log('[BDK] sendTransaction signing');
  const signedPsbt = await wallet.sign(result.psbt);
  console.log('[BDK] sendTransaction extracting');
  const tx = await signedPsbt.extractTx();

  onBroadcastAttempted?.();
  try {
    console.log('[BDK] sendTransaction: broadcasting');
    await chain.broadcast(tx);
    console.log('[BDK] sendTransaction: broadcast complete');
  } catch (e) {
    console.warn('sendTransaction: broadcast failed, reconnecting:', e);
    disconnectElectrum();
    const freshChain = await getBlockchain();
    await freshChain.broadcast(tx);
  }

  return await signedPsbt.txid();
}

export async function removeWallet(walletId: string): Promise<void> {
  bdkWallets.delete(walletId);
  await AsyncStorage.removeItem(`${ADDRESS_INDEX_PREFIX}${walletId}`);
}

export function disconnectElectrum(): void {
  blockchainGeneration += 1;
  blockchain = null;
}

/**
 * Broadcast a raw transaction hex via the configured Electrum server.
 * Uses BDK's blockchain.broadcast which handles the Electrum protocol.
 */
export async function broadcastRawTx(txHex: string): Promise<void> {
  if (!txHex || txHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(txHex)) {
    throw new Error('Invalid transaction hex: must be a non-empty even-length hex string');
  }
  // Force a fresh Electrum connection. A stale/dropped socket can cause
  // broadcast() to fail in a way that masks the real error as a RN
  // DevSettings "Cannot read property 'reload' of undefined" crash. Matches
  // the pattern used in sendTransaction().
  disconnectElectrum();
  const chain = await getBlockchain();
  const bytes: number[] = [];
  for (let i = 0; i < txHex.length; i += 2) {
    bytes.push(parseInt(txHex.substring(i, i + 2), 16));
  }
  const tx = await new Transaction().create(bytes);
  await chain.broadcast(tx);
}
