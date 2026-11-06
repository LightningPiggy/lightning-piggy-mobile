import { parseBoltzPair } from './boltzPair';
/**
 * Boltz Exchange reverse submarine swap service.
 *
 * Enables sending from Lightning to on-chain Bitcoin addresses using
 * Boltz v2 reverse swaps with script-path (non-cooperative) claiming.
 *
 * Flow:
 *   1. Generate preimage + claim keypair
 *   2. Create reverse swap via Boltz API (returns LN invoice + lockup details)
 *   3. User pays the Lightning invoice via NWC
 *   4. Boltz locks BTC on-chain in a Taproot HTLC
 *   5. We construct a script-path claim transaction (sig + preimage)
 *   6. Broadcast claim tx → funds arrive at destination address
 *
 * Uses script-path spending (not cooperative MuSig2 key-path) to avoid
 * needing MuSig2 nonce exchange. Slightly larger on-chain footprint but
 * works with pure JS crypto (@noble/curves Schnorr + @scure/btc-signer).
 *
 * API docs: https://docs.boltz.exchange
 */

import * as ecc from '@bitcoinerlab/secp256k1';
import BIP32Factory from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { keyAggregate, keyAggExport } from '@scure/btc-signer/musig2.js';
import {
  verifyReverseSwap,
  verifyReverseLockup,
  REVERSE_CLAIM_VBYTES,
  REVERSE_CLAIM_MARGIN,
} from '../utils/reverseSwapVerify';
import { verifyReverseSwapInvoice } from '../utils/boltzVerify';
import {
  CLAIM_TX_MAX_VSIZE,
  planReverseClaim,
  quoteClaimFeeRate,
  quoteExactRecipient,
} from '../utils/reverseSwapAmounts';
import { singleFlightClaim } from '../utils/swapClaimSingleFlight';
import { verifySubmarineSwap } from '../utils/submarineSwapVerify';
import { amountSatsFromBolt11 } from '../utils/bolt11';
import { extractLockupFromTxHex } from '../utils/lockupTx';
import { fetchWithTimeout } from './boltzApi';
import { requireSwapBackend, getSwapBackendForId, pinSwapBackend } from './swapBackendService';
import { waitForSwapStatus } from './boltzSwapStatus';
import {
  CLAIM_MISSING_INPUTS_WINDOW_MS,
  broadcastWithRetry,
  waitForTxVisible,
} from './swapBroadcast';
import {
  CLAIM_FEE_TARGET_BLOCKS,
  claimFeeCap,
  claimFeeSats,
  selectClaimFeeRate,
} from '../utils/swapClaimFee';

// Re-exported for back-compat: the HTTP transport and the swap-status
// subscription/classification layer now live in dedicated modules, but
// existing callers (and Jest module mocks) still reach them through the
// boltzService namespace.
export { fetchWithTimeout } from './boltzApi';
export {
  watchSubmarineSwapStatus,
  classifySubmarineSwapStatus,
  fetchSwapStatus,
  type SubmarineSwapPhase,
} from './boltzSwapStatus';

const bip32 = BIP32Factory(ecc);

// Boltz BTC swap limits (from API — these are fallback defaults)
export const BOLTZ_MIN_SATS = 25_000;
export const BOLTZ_MAX_SATS = 25_000_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SwapFees {
  pairHash?: string;
  /** Server lockup fee, separate from our claim fee, for reverse swaps. */
  lockupMinerFee?: number;
  claimFeeRate?: number;
  backend?: string;
  percentage: number;
  minerFee: number;
  minAmount: number;
  maxAmount: number;
}

export interface ReverseSwapResult {
  claimFeeRate?: number;
  id: string;
  /** Lightning invoice the user must pay via NWC */
  invoice: string;
  /** On-chain amount Boltz will lock (after their fees) */
  onchainAmount: number;
  /** Exact-recipient swaps (#1175): what the claim pays the destination.
   *  Absent on invoice-amount swaps, whose claim fee comes off the lockup. */
  recipientAmount?: number;
  /** The hold invoice's amount — what the paying wallet is charged. */
  invoiceAmount?: number;
  timeoutBlockHeight: number;
  /** Lockup Bitcoin address (base58/bech32 string) — not hex */
  lockupAddress: string;
  /** Boltz's refund public key (hex) */
  refundPublicKey: string;
  /** Serialized swap tree for script-path spending */
  swapTree: SwapTree;
  /** Our preimage (hex) — needed to claim */
  preimage: string;
  /** Our claim private key (hex) — needed to sign the claim tx */
  claimPrivateKey: string;
}

interface SwapTree {
  claimLeaf: { version: number; output: string };
  refundLeaf: { version: number; output: string };
}

// Boltz v2 swap statuses (from https://api.docs.boltz.exchange/lifecycle.html)
export type SwapStatus =
  // Shared
  | 'swap.created'
  | 'transaction.mempool'
  | 'transaction.confirmed'
  | 'swap.expired'
  // Submarine (on-chain → LN)
  | 'invoice.set'
  | 'invoice.pending'
  | 'invoice.paid'
  | 'invoice.failedToPay'
  | 'transaction.claim.pending'
  | 'transaction.claimed'
  | 'transaction.lockupFailed'
  // Reverse (LN → on-chain)
  | 'invoice.settled'
  | 'invoice.expired'
  | 'transaction.failed'
  | 'transaction.refunded';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Bitcoin CompactSize varint encoding for script lengths in tapleaf hashes. */
function compactSize(len: number): Buffer {
  if (len < 0xfd) return Buffer.from([len]);
  if (len <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(len, 1);
    return buf;
  }
  throw new Error(`Script too large for CompactSize: ${len}`);
}

function toHex(arr: Uint8Array): string {
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hash using bitcoinjs-lib's crypto (already works in RN) */
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(bitcoin.crypto.sha256(Buffer.from(data)));
}

/** Generate a claim keypair using bip32 */
function generateClaimKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const node = bip32.fromSeed(Buffer.from(seed));
  return {
    privateKey: new Uint8Array(node.privateKey!),
    publicKey: new Uint8Array(node.publicKey),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch current reverse swap fee schedule (BTC Lightning → BTC on-chain).
 */
export async function getReverseSwapFees(backend?: string): Promise<SwapFees> {
  backend ??= await requireSwapBackend();
  const res = await fetchWithTimeout(`${backend}/swap/reverse`);
  if (!res.ok) throw new Error(`Boltz API error: ${res.status}`);
  const data = await res.json();

  const pair = parseBoltzPair(data?.BTC?.BTC, 'reverse');
  const { getClaimFeeEstimate } = require('./onchainService') as typeof import('./onchainService');
  // Price the claim the way it will be built (#1174, #1175): the live
  // ~30-minute estimate (rounded up to a stable whole rate) on the measured
  // claim size — not the old 2-block × 180 vB over-estimate.
  const claimFeeRate = quoteClaimFeeRate(await getClaimFeeEstimate(CLAIM_FEE_TARGET_BLOCKS));
  return {
    ...pair,
    minerFee: claimFeeSats(CLAIM_TX_MAX_VSIZE, claimFeeRate),
    claimFeeRate,
    backend,
  };
}

/** @deprecated Use getReverseSwapFees instead */
export const getSwapFees = getReverseSwapFees;

/**
 * Fetch current submarine swap fee schedule (BTC on-chain → BTC Lightning).
 */
export async function getSubmarineSwapFees(backend?: string): Promise<SwapFees> {
  backend ??= await requireSwapBackend();
  const res = await fetchWithTimeout(`${backend}/swap/submarine`);
  if (!res.ok) throw new Error(`Boltz API error: ${res.status}`);
  const data = await res.json();

  return { ...parseBoltzPair(data?.BTC?.BTC, 'submarine'), backend };
}

/**
 * Calculate the total fee for a reverse swap of a given amount.
 */
export function calculateSwapFee(amountSats: number, fees: SwapFees): number {
  return (
    Math.ceil(amountSats * (fees.percentage / 100)) + fees.minerFee + (fees.lockupMinerFee ?? 0)
  );
}

/**
 * The approved reverse-swap quote no longer matches the server's. Thrown before
 * any swap is created or paid; `quote` is the server's current quote for the
 * caller to show — the user must review it and retry explicitly.
 */
export class QuoteChangedError extends Error {
  readonly quote: SwapFees;
  constructor(quote: SwapFees) {
    super('Swap fees or server changed. Review the new quote before sending.');
    this.name = 'QuoteChangedError';
    this.quote = quote;
  }
}

export function isQuoteChangedError(error: unknown): error is QuoteChangedError {
  return (error as Error)?.name === 'QuoteChangedError' && !!(error as QuoteChangedError).quote;
}

/** Creating a reverse swap makes Boltz mint a hold invoice on its node, which
 *  is slower than a quote — allow more than the default 10 s request budget. */
export const REVERSE_SWAP_CREATE_TIMEOUT_MS = 30_000;

/** Which side of a reverse swap the caller's amount fixes. */
export type ReverseSwapAmountSide = 'invoice' | 'recipient';

/**
 * Create a reverse submarine swap: Lightning → on-chain.
 *
 * `amountIs: 'recipient'` (#1175) makes `amountSats` exactly what reaches
 * `onchainAddress`: we ask Boltz to lock it plus our claim fee (v2
 * `onchainAmount`) and every fee lands on the invoice. `'invoice'` keeps the
 * legacy meaning — the invoice is `amountSats` and fees come off the
 * on-chain side.
 *
 * Returns swap details including the Lightning invoice to pay and the
 * data needed to later claim the on-chain funds.
 */
export async function createReverseSwap(
  onchainAddress: string,
  amountSats: number,
  approvedQuote?: SwapFees,
  amountIs: ReverseSwapAmountSide = 'invoice',
  signal?: AbortSignal,
): Promise<ReverseSwapResult> {
  const backend = await requireSwapBackend();
  console.log(
    `[Boltz] Creating reverse swap (LN → on-chain) for ${amountSats} sats to ${onchainAddress}`,
  );
  if (!isBitcoinAddress(onchainAddress)) {
    throw new Error('Invalid destination Bitcoin address');
  }

  if (!Number.isSafeInteger(amountSats) || amountSats <= 0)
    throw new Error('Invalid reverse swap amount');
  const { getBlockHeight } = require('./onchainService') as typeof import('./onchainService');
  const [fees, currentBlockHeight] = await Promise.all([
    getReverseSwapFees(backend),
    getBlockHeight(),
  ]);
  if (
    approvedQuote &&
    (approvedQuote.backend !== backend ||
      approvedQuote.pairHash !== fees.pairHash ||
      approvedQuote.minerFee < fees.minerFee)
  )
    throw new QuoteChangedError(fees);
  if (!fees.pairHash || fees.lockupMinerFee === undefined)
    throw new Error('Incomplete reverse swap fee quote');
  // Exact-recipient: price the claim at the approved budget (never below the
  // live one — checked above) so the invoice matches what the user approved.
  const recipientQuote =
    amountIs === 'recipient'
      ? quoteExactRecipient(amountSats, {
          ...fees,
          minerFee: Math.max(fees.minerFee, approvedQuote?.minerFee ?? 0),
          claimFeeRate:
            Math.max(fees.claimFeeRate ?? 0, approvedQuote?.claimFeeRate ?? 0) || undefined,
        })
      : null;
  // Boltz applies its limits to the invoice (hold invoice) amount.
  const invoiceAmount = recipientQuote?.invoiceSats ?? amountSats;
  if (invoiceAmount < fees.minAmount || invoiceAmount > fees.maxAmount)
    throw new Error('Reverse swap amount is outside the server limits');
  const expectedAmount =
    recipientQuote?.lockupSats ??
    amountSats - Math.ceil(amountSats * (fees.percentage / 100)) - fees.lockupMinerFee;

  // Generate preimage and its SHA-256 hash
  const preimageBytes = new Uint8Array(32);
  crypto.getRandomValues(preimageBytes);
  const preimage = toHex(preimageBytes);
  const preimageHashBytes = sha256(preimageBytes);
  const preimageHash = toHex(preimageHashBytes);

  // Generate temporary claim keypair
  const claimKeys = generateClaimKeyPair();
  const claimPublicKey = toHex(claimKeys.publicKey);

  // The caller's signal lets Cancel abort the request; the deadline covers
  // the body read too. A timeout or cancel here is pre-commit: nothing has
  // been paid, and any swap Boltz created anyway just expires unpaid.
  const data: unknown = await fetchWithTimeout(
    `${backend}/swap/reverse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BTC',
        to: 'BTC',
        preimageHash,
        claimPublicKey,
        claimAddress: onchainAddress,
        ...(recipientQuote
          ? { onchainAmount: recipientQuote.lockupSats }
          : { invoiceAmount: amountSats }),
        pairHash: fees.pairHash,
      }),
      signal,
    },
    REVERSE_SWAP_CREATE_TIMEOUT_MS,
    async (res) => {
      if (!res.ok) throw new Error(`Boltz swap creation failed: ${await res.text()}`);
      return res.json();
    },
  );
  // Boltz only echoes `onchainAmount` when we fixed the invoice; when we fixed
  // the lockup it is ours by definition. A present-but-different value still
  // fails verification, and the lockup tx itself is later checked against it.
  if (recipientQuote && data && typeof data === 'object' && !('onchainAmount' in data))
    (data as { onchainAmount?: number }).onchainAmount = recipientQuote.lockupSats;
  verifyReverseSwap(data, {
    preimageHash: preimageHashBytes,
    claimPublicKey: claimKeys.publicKey,
    expectedAmount,
    currentBlockHeight,
    claimFeeSats: fees.minerFee,
  });
  console.log(
    `[Boltz] Reverse swap created: id=${data.id} lockup=${data.lockupAddress} onchainAmount=${data.onchainAmount}`,
  );
  // Trust boundary: the swap is only trustless if the invoice binds to OUR
  // preimage for OUR amount. Verify BEFORE returning (and thus before any
  // caller pays) — throwing here is a clean pre-commit failure.
  verifyReverseSwapInvoice({
    invoice: data.invoice,
    expectedPaymentHash: preimageHash,
    expectedAmountSats: invoiceAmount,
  });
  await pinSwapBackend(data.id, backend);
  return {
    id: data.id,
    invoice: data.invoice,
    onchainAmount: data.onchainAmount,
    ...(recipientQuote ? { recipientAmount: recipientQuote.recipientSats } : {}),
    invoiceAmount,
    claimFeeRate: fees.claimFeeRate,
    timeoutBlockHeight: data.timeoutBlockHeight,
    lockupAddress: data.lockupAddress,
    refundPublicKey:
      data.refundPublicKey.length === 64 ? `02${data.refundPublicKey}` : data.refundPublicKey,
    swapTree: data.swapTree,
    preimage,
    claimPrivateKey: toHex(claimKeys.privateKey),
  };
}

/**
 * Wait for reverse swap lockup transaction to appear on-chain.
 * Uses WebSocket with polling fallback.
 */
export async function waitForLockup(
  swap: ReverseSwapResult,
  timeoutMs = 60000,
  signal?: AbortSignal,
) {
  const failed = ['swap.expired', 'transaction.refunded', 'transaction.failed', 'invoice.expired'];
  const data = await waitForSwapStatus(
    swap.id,
    (status) => {
      if (failed.includes(status)) throw new Error(`Swap failed with status: ${status}`);
      return status === 'transaction.mempool' || status === 'transaction.confirmed';
    },
    timeoutMs,
    signal,
  );
  let txHex = data.transaction?.hex;
  if (!txHex) {
    const backend = await getSwapBackendForId(swap.id);
    const res = await fetchWithTimeout(`${backend}/swap/reverse/${swap.id}/transaction`, {
      signal,
    });
    if (!res.ok) throw new Error('Reverse lockup transaction unavailable');
    txHex = (await res.json()).hex;
  }
  if (typeof txHex !== 'string') throw new Error('Reverse lockup missing transaction hex');
  return verifyReverseLockup(txHex, swap);
}

/**
 * Build and broadcast a script-path claim transaction for a reverse swap.
 *
 * After Boltz locks BTC on-chain in a Taproot HTLC, we claim it by
 * revealing the preimage and signing with our claim key via script-path.
 */
/** A broadcast claim: its txid and what it paid the destination. */
export interface ReverseClaim {
  txId: string;
  outputSats: number;
}

export async function claimSwap(
  swap: ReverseSwapResult,
  lockup: { txId: string; vout: number; amount: number; txHex: string },
  destinationAddress: string,
): Promise<ReverseClaim> {
  return singleFlightClaim(`${swap.id}:${lockup.txId}:${lockup.vout}`, () =>
    broadcastClaim(swap, lockup, destinationAddress),
  );
}

async function broadcastClaim(
  swap: ReverseSwapResult,
  lockup: { txId: string; vout: number; amount: number; txHex: string },
  destinationAddress: string,
): Promise<ReverseClaim> {
  const onchainService = require('./onchainService') as typeof import('./onchainService');
  // Live ~30-min estimate, unrounded; if Electrum can't answer, fall back to
  // the rate the swap was quoted with. Capped only against a bogus estimate (#1174).
  let liveRate: number | null = null;
  try {
    liveRate = await onchainService.getClaimFeeEstimate(CLAIM_FEE_TARGET_BLOCKS);
  } catch (error) {
    console.warn('[Boltz] Claim fee estimate unavailable; using the quoted rate:', error);
  }
  const feeRate = selectClaimFeeRate(liveRate, swap.claimFeeRate);
  const feeCap = claimFeeCap(swap.claimFeeRate);
  // Repeat structural/deadline checks immediately before disclosing our preimage.
  const claimKey = ecc.pointFromScalar(Buffer.from(swap.claimPrivateKey, 'hex'), true);
  if (!claimKey) throw new Error('Invalid saved reverse claim key');
  const exactBudgetSats =
    swap.recipientAmount !== undefined ? swap.onchainAmount - swap.recipientAmount : undefined;
  verifyReverseSwap(swap, {
    preimageHash: sha256(Buffer.from(swap.preimage, 'hex')),
    claimPublicKey: claimKey,
    expectedAmount: swap.onchainAmount,
    currentBlockHeight: await onchainService.getBlockHeight(),
    minClaimBlocks: REVERSE_CLAIM_MARGIN,
    // Upper bound on the live claim fee — or the smaller exact-recipient
    // budget (#1175), which is planned against the measured size below.
    claimFeeSats: Math.max(
      0,
      Math.min(claimFeeSats(REVERSE_CLAIM_VBYTES, feeRate, feeCap), exactBudgetSats ?? Infinity),
    ),
  });
  const verifiedLockup = verifyReverseLockup(lockup.txHex, swap);
  if (
    verifiedLockup.txId !== lockup.txId ||
    verifiedLockup.vout !== lockup.vout ||
    verifiedLockup.amount !== lockup.amount
  )
    throw new Error('Reverse lockup metadata mismatch');

  const claimScript = Buffer.from(swap.swapTree.claimLeaf.output, 'hex');
  const refundScript = Buffer.from(swap.swapTree.refundLeaf.output, 'hex');
  const claimPrivKey = Buffer.from(swap.claimPrivateKey, 'hex');
  const preimageBytes = Buffer.from(swap.preimage, 'hex');
  const refundPubKey = Buffer.from(swap.refundPublicKey, 'hex');
  const claimLeafVersion = swap.swapTree.claimLeaf.version ?? 0xc0;
  const refundLeafVersion = swap.swapTree.refundLeaf.version ?? 0xc0;

  // Build transaction. The output value is set once the fee is known.
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(lockup.txId, 'hex').reverse(), lockup.vout, 0xfffffffd);
  tx.addOutput(bitcoin.address.toOutputScript(destinationAddress), 0n);

  // Compute tapleaf hashes
  const claimLeafHash = bitcoin.crypto.taggedHash(
    'TapLeaf',
    Buffer.concat([Buffer.from([claimLeafVersion]), compactSize(claimScript.length), claimScript]),
  );
  const refundLeafHash = bitcoin.crypto.taggedHash(
    'TapLeaf',
    Buffer.concat([
      Buffer.from([refundLeafVersion]),
      compactSize(refundScript.length),
      refundScript,
    ]),
  );

  // Boltz v2 Taproot internal key is the MuSig2 aggregate of the claim
  // pubkey (ours) and the refund pubkey (theirs) — BIP-327. It is NOT just
  // the refund pubkey. Both inputs must be 33-byte compressed pubkeys.
  // See: https://docs.boltz.exchange and @scure/btc-signer musig2.
  const claimPubKeyCompressed = Buffer.from(ecc.pointFromScalar(claimPrivKey, true) as Uint8Array);
  const refundPubKeyCompressed =
    refundPubKey.length === 33 ? refundPubKey : Buffer.concat([Buffer.from([2]), refundPubKey]);
  // Boltz v2 MuSig2 key aggregation: "Boltz's public key always coming first".
  // For reverse swaps Boltz is the refunder, so refund key is passed first,
  // then claim key (the user's). Confirmed against chain via p2tr diagnostic.
  // See https://api.docs.boltz.exchange/claiming-swaps.html
  const aggCtx = keyAggregate([
    new Uint8Array(refundPubKeyCompressed),
    new Uint8Array(claimPubKeyCompressed),
  ]);
  const internalKey = Buffer.from(keyAggExport(aggCtx));

  // Compute the Taproot tweak to determine output key parity (BIP-341)
  // Merkle root: sort and hash the two leaf hashes
  const merkleRoot =
    Buffer.compare(claimLeafHash, refundLeafHash) < 0
      ? bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([claimLeafHash, refundLeafHash]))
      : bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([refundLeafHash, claimLeafHash]));

  // Compute the tweak: taggedHash('TapTweak', internalKey || merkleRoot)
  const tweak = bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([internalKey, merkleRoot]));

  // Derive the tweaked public key to get the output parity bit
  const tweakedKey = ecc.xOnlyPointAddTweak(new Uint8Array(internalKey), new Uint8Array(tweak));
  if (!tweakedKey) throw new Error('Failed to compute tweaked key');
  const parityBit = tweakedKey.parity;

  // Control block: <leaf_version | parity> <internal_key> <merkle_sibling>
  const controlBlock = Buffer.concat([
    Buffer.from([claimLeafVersion | parityBit]),
    internalKey,
    refundLeafHash, // merkle proof (sibling of claim leaf)
  ]);

  // Size the claim exactly (#1174): a BIP-340 signature is always 64 bytes,
  // so a placeholder gives the final witness size.
  tx.setWitness(0, [Buffer.alloc(64), preimageBytes, claimScript, controlBlock]);
  const vsize = tx.virtualSize();
  const requiredFeeSats = claimFeeSats(vsize, feeRate, feeCap);
  // Exact-recipient swaps (#1175) pay the destination precisely when their
  // budget covers that fee; otherwise, and for legacy swaps, the fee comes
  // out of the lockup — confirming before Boltz can refund wins.
  const plan = planReverseClaim({
    lockupSats: lockup.amount,
    requiredFeeSats,
    recipientSats: swap.recipientAmount,
  });
  if (swap.recipientAmount !== undefined && !plan.exact)
    console.warn(
      `[Boltz] Claim fee for ${swap.id} rose past its budget; paying ${plan.outputSats} not ${swap.recipientAmount}`,
    );
  const outputAmount = plan.outputSats;
  if (outputAmount <= 546) {
    throw new Error(`Claim amount (${lockup.amount}) too small after fee (${plan.feeSats})`);
  }
  tx.outs[0].value = BigInt(outputAmount);
  console.log(
    `[Boltz] Claim fee ${plan.feeSats} sats (${vsize} vB, live ${feeRate.toFixed(2)} sat/vB, cap ${feeCap ?? 'none'})`,
  );

  // Compute sighash for Taproot script-path (BIP-341, SIGHASH_DEFAULT)
  const prevOutScript = bitcoin.address.toOutputScript(swap.lockupAddress);
  const sighash = tx.hashForWitnessV1(
    0,
    [prevOutScript],
    [BigInt(lockup.amount)],
    0x00, // SIGHASH_DEFAULT — 64-byte sig, no sighash byte appended
    claimLeafHash,
  );

  // Schnorr sign — no sighash byte appended (SIGHASH_DEFAULT)
  const sig = Buffer.from(ecc.signSchnorr(new Uint8Array(sighash), new Uint8Array(claimPrivKey)));

  // Set witness: <sig> <preimage> <claim_script> <control_block>
  tx.setWitness(0, [sig, preimageBytes, claimScript, controlBlock]);

  // Broadcast via the configured Electrum server (BDK). When waitForLockup
  // returns at `transaction.mempool`, Boltz broadcast the lockup moments ago
  // and our backend may not have it yet (#481, #1174). Wait (bounded) until
  // it does, then retry "missing inputs" rejections over a longer bounded
  // window. Exhausting it throws; the caller treats that as still settling
  // and recovery re-claims from the persisted record.
  const txId = tx.getId();
  const lockupVisible = await waitForTxVisible(() => onchainService.isTxKnown(lockup.txId));
  if (!lockupVisible)
    console.log(`[Boltz] Lockup ${lockup.txId} not seen yet; broadcasting anyway`);
  console.log(`[Boltz] Broadcasting claim tx: ${txId} (${tx.toHex().length / 2} bytes)`);
  await broadcastWithRetry(() => onchainService.broadcastRawTx(tx.toHex()), 'claim', txId, {
    missingInputsWindowMs: CLAIM_MISSING_INPUTS_WINDOW_MS,
  });
  console.log(`[Boltz] Claim tx broadcast successfully: ${txId}`);
  return { txId, outputSats: outputAmount };
}

/**
 * Validate that a string is a valid Bitcoin on-chain address (with checksum).
 * Uses bitcoinjs-lib's address.toOutputScript which validates format + checksum.
 */
export function isBitcoinAddress(input: string): boolean {
  const trimmed = input.trim();
  try {
    bitcoin.address.toOutputScript(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch lockup transaction details for a submarine swap.
 * Used to get the UTXO needed for refund transaction construction.
 *
 * The v2 endpoint returns only `{ id, hex, timeoutBlockHeight }` — it has NO
 * `index` (vout) or amount fields, so the previous `data.index ?? 0` /
 * `statusData.onchainAmount ?? 0` reads guessed vout 0 with amount 0 and the
 * refund either threw "amount too small" or signed the wrong outpoint (swap
 * audit finding, 2026-07-02). Instead, parse the returned raw tx and locate
 * the output paying `lockupAddress` — which also verifies the lockup really
 * pays the address we hold the refund script for.
 */
export async function getSubmarineSwapLockup(
  swapId: string,
  lockupAddress: string,
): Promise<{ txId: string; vout: number; amount: number } | null> {
  const backend = await getSwapBackendForId(swapId);
  try {
    const res = await fetchWithTimeout(`${backend}/swap/submarine/${swapId}/transaction`);
    if (!res.ok) return null;
    const data = await res.json();
    const txHex = data.hex;
    if (typeof txHex !== 'string' || !txHex) return null;
    const lockup = extractLockupFromTxHex(txHex, lockupAddress);
    if (!lockup) return null;
    // Refund the outpoint the raw tx actually creates; an advertised id that
    // disagrees with the hex means the response can't be trusted at all.
    const advertisedTxId = data.transactionId ?? data.id;
    if (advertisedTxId && String(advertisedTxId).toLowerCase() !== lockup.txId) return null;
    return { txId: lockup.txId, vout: lockup.vout, amount: lockup.amount };
  } catch {
    return null;
  }
}

/**
 * Build and broadcast a script-path refund transaction for a failed submarine swap.
 *
 * After the timeout block height, the user can reclaim their on-chain BTC
 * by spending the HTLC via the refund script path.
 */
export async function refundSwap(
  swap: SubmarineSwapResult,
  lockup: { txId: string; vout: number; amount: number },
  destinationAddress: string,
  feeRate: number = 2,
): Promise<string> {
  console.log(`[Boltz] Building refund tx for swap ${swap.id} to ${destinationAddress}`);

  const refundScript = Buffer.from(swap.swapTree.refundLeaf.output, 'hex');
  const claimScript = Buffer.from(swap.swapTree.claimLeaf.output, 'hex');
  const refundPrivKey = Buffer.from(swap.refundPrivateKey, 'hex');
  const claimPubKey = Buffer.from(swap.claimPublicKey, 'hex');
  const refundLeafVersion = swap.swapTree.refundLeaf.version ?? 0xc0;
  const claimLeafVersion = swap.swapTree.claimLeaf.version ?? 0xc0;

  const fee = Math.ceil(150 * feeRate);
  const outputAmount = lockup.amount - fee;
  if (outputAmount <= 546) {
    throw new Error(`Refund amount (${lockup.amount}) too small after fee (${fee})`);
  }

  // Build transaction with nLockTime for timelock
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = swap.timeoutBlockHeight;
  // Sequence 0xFFFFFFFE enables nLockTime (BIP-125 RBF compatible)
  tx.addInput(Buffer.from(lockup.txId, 'hex').reverse(), lockup.vout, 0xfffffffe);
  tx.addOutput(bitcoin.address.toOutputScript(destinationAddress), BigInt(outputAmount));

  // Compute tapleaf hashes (same as claimSwap but we spend refundLeaf)
  const refundLeafHash = bitcoin.crypto.taggedHash(
    'TapLeaf',
    Buffer.concat([
      Buffer.from([refundLeafVersion]),
      compactSize(refundScript.length),
      refundScript,
    ]),
  );
  const claimLeafHash = bitcoin.crypto.taggedHash(
    'TapLeaf',
    Buffer.concat([Buffer.from([claimLeafVersion]), compactSize(claimScript.length), claimScript]),
  );

  // Boltz v2 Taproot internal key is the MuSig2 aggregate of Boltz's pubkey
  // and the user's pubkey, with "Boltz's public key always coming first".
  // For submarine swaps Boltz is the claimer, so the claim key is passed
  // first, then the user's refund pubkey. Mirrors claimSwap() for reverse
  // swaps (where Boltz is the refunder and the order is inverted).
  // See https://api.docs.boltz.exchange/claiming-swaps.html
  const refundPubKeyCompressed = Buffer.from(
    ecc.pointFromScalar(refundPrivKey, true) as Uint8Array,
  );
  const claimPubKeyCompressed =
    claimPubKey.length === 32 ? Buffer.concat([Buffer.from([2]), claimPubKey]) : claimPubKey;
  const aggCtx = keyAggregate([
    new Uint8Array(claimPubKeyCompressed),
    new Uint8Array(refundPubKeyCompressed),
  ]);
  const internalKey = Buffer.from(keyAggExport(aggCtx));

  // Merkle root (sorted)
  const merkleRoot =
    Buffer.compare(claimLeafHash, refundLeafHash) < 0
      ? bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([claimLeafHash, refundLeafHash]))
      : bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([refundLeafHash, claimLeafHash]));

  const tweak = bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([internalKey, merkleRoot]));
  const tweakedKey = ecc.xOnlyPointAddTweak(new Uint8Array(internalKey), new Uint8Array(tweak));
  if (!tweakedKey) throw new Error('Failed to compute tweaked key for refund');
  const parityBit = tweakedKey.parity;

  // Control block: refund leaf version | parity, internal key, claim leaf hash (merkle sibling)
  const controlBlock = Buffer.concat([
    Buffer.from([refundLeafVersion | parityBit]),
    internalKey,
    claimLeafHash,
  ]);

  // Sighash for Taproot script-path
  const prevOutScript = bitcoin.address.toOutputScript(swap.address);
  const sighash = tx.hashForWitnessV1(
    0,
    [prevOutScript],
    [BigInt(lockup.amount)],
    0x00, // SIGHASH_DEFAULT
    refundLeafHash,
  );

  const sig = ecc.signSchnorr(new Uint8Array(sighash), new Uint8Array(refundPrivKey));

  // Witness: <sig> <refund_script> <control_block> (no preimage for refund)
  tx.setWitness(0, [Buffer.from(sig), refundScript, controlBlock]);

  const txId = tx.getId();
  console.log(`[Boltz] Broadcasting refund tx: ${txId}`);
  const onchainService = await import('./onchainService');
  await broadcastWithRetry(() => onchainService.broadcastRawTx(tx.toHex()), 'refund', txId);
  console.log(`[Boltz] Refund tx broadcast successfully: ${txId}`);
  return txId;
}

// ─── Submarine swap (on-chain → Lightning) ───────────────────────────────────

export interface SubmarineSwapResult {
  id: string;
  /** On-chain address the user must send BTC to */
  address: string;
  /** Expected amount in sats to send on-chain (includes Boltz fee) */
  expectedAmount: number;
  /** Timeout block height — refund possible after this */
  timeoutBlockHeight: number;
  /** Refund private key (hex) — needed if swap fails and we need to reclaim on-chain funds */
  refundPrivateKey: string;
  /** Boltz's claim public key (hex) — Taproot internal key for refund tree */
  claimPublicKey: string;
  /** Swap tree for script-path refund */
  swapTree: SwapTree;
}

/**
 * Create a submarine swap: on-chain → Lightning.
 *
 * Flow:
 *   1. Generate an LN invoice on the destination NWC wallet (caller does this)
 *   2. Create swap with Boltz, providing the invoice
 *   3. Boltz returns an on-chain address + expected amount
 *   4. Send BTC on-chain to that address from the hot wallet (caller does this)
 *   5. Boltz detects the on-chain payment and pays the LN invoice
 */
export async function createSubmarineSwapForward(
  invoice: string,
  requestedAmountSats: number,
  approvedQuote?: SwapFees,
): Promise<SubmarineSwapResult> {
  const backend = await requireSwapBackend();
  console.log('[Boltz] Creating submarine swap (on-chain → LN)');
  const amount = amountSatsFromBolt11(invoice);
  if (
    !Number.isSafeInteger(requestedAmountSats) ||
    requestedAmountSats <= 0 ||
    amount !== requestedAmountSats
  ) {
    throw new Error('Submarine swap invoice amount does not match the requested payment');
  }
  // Quote independently of the creation response; fail closed if either the
  // fee schedule or our configured Electrum server is unavailable.
  const { getBlockHeight } = require('./onchainService') as typeof import('./onchainService');
  const [fees, currentBlockHeight] = await Promise.all([
    getSubmarineSwapFees(backend),
    getBlockHeight(),
  ]);
  if (
    approvedQuote &&
    (approvedQuote.backend !== backend ||
      approvedQuote.pairHash !== fees.pairHash ||
      approvedQuote.percentage !== fees.percentage ||
      approvedQuote.minerFee !== fees.minerFee ||
      approvedQuote.minAmount !== fees.minAmount ||
      approvedQuote.maxAmount !== fees.maxAmount)
  )
    throw new QuoteChangedError(fees);
  if (amount < fees.minAmount || amount > fees.maxAmount)
    throw new Error('Submarine swap amount is outside the server limits');
  const expectedAmount = amount + calculateSwapFee(amount, fees);
  const refundKeys = generateClaimKeyPair();

  const res = await fetchWithTimeout(`${backend}/swap/submarine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BTC',
      to: 'BTC',
      invoice,
      pairHash: fees.pairHash,
      refundPublicKey: toHex(refundKeys.publicKey),
      // Match the un-referred quote used for the pair hash and expected amount.
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Boltz submarine swap creation failed: ${errBody}`);
  }

  const data: unknown = await res.json();
  verifySubmarineSwap(data, {
    invoice,
    refundPublicKey: refundKeys.publicKey,
    expectedAmount,
    currentBlockHeight,
  });
  console.log(
    `[Boltz] Submarine swap created: id=${data.id} address=${data.address} amount=${data.expectedAmount}`,
  );
  await pinSwapBackend(data.id, backend);
  return {
    id: data.id,
    address: data.address,
    expectedAmount: data.expectedAmount,
    timeoutBlockHeight: data.timeoutBlockHeight,
    refundPrivateKey: toHex(refundKeys.privateKey),
    claimPublicKey:
      data.claimPublicKey.length === 64 ? `02${data.claimPublicKey}` : data.claimPublicKey,
    swapTree: data.swapTree,
  };
}

/**
 * True only for an EXPLICIT Boltz fail status thrown by `waitForLockup` /
 * `waitForSubmarineSwapComplete` (`Swap failed with status: <FAIL_STATUS>`) —
 * i.e. a TERMINAL failure that warrants the refund path.
 *
 * Timeouts (`Timeout waiting for swap …` / `Timeout polling swap …`) and
 * transient/network errors (`Boltz status check failed: 500`, fetch failures)
 * are AMBIGUOUS — the swap may still settle — and must NOT be treated as
 * failures (#894).
 */
export function isExplicitSwapFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.startsWith('Swap failed with status: ');
}

/**
 * Poll submarine swap status until Boltz has paid the Lightning invoice.
 */
export async function waitForSubmarineSwapComplete(
  swapId: string,
  timeoutMs: number = 120000,
  /** Every status Boltz reports on the way, e.g. to narrate the 1-conf wait. */
  onStatus?: (status: string) => void,
): Promise<void> {
  console.log(
    `[Boltz] Waiting for submarine swap completion: ${swapId} (timeout ${timeoutMs / 1000}s)`,
  );

  const FAIL_STATUSES = [
    'swap.expired',
    'transaction.refunded',
    'invoice.failedToPay',
    'transaction.lockupFailed',
  ];

  await waitForSwapStatus(
    swapId,
    (status) => {
      try {
        onStatus?.(status);
      } catch {
        // A caller's progress callback must never fail the swap watch.
      }
      if (
        status === 'invoice.settled' ||
        status === 'transaction.claimed' ||
        status === 'invoice.paid' ||
        status === 'transaction.claim.pending'
      ) {
        console.log(`[Boltz] Submarine swap ${swapId} complete: ${status}`);
        return true;
      }
      if (FAIL_STATUSES.includes(status)) {
        throw new Error(`Swap failed with status: ${status}`);
      }
      return false;
    },
    timeoutMs,
  );
}

// ─── Receive-side helpers (issue #92) ────────────────────────────────────────

/**
 * Build a BIP-21 payment URI from a Boltz submarine-swap lockup address +
 * expected amount. Used by the Receive sheet so external senders get a QR
 * that wallets parse with the amount pre-filled — under-/over-payment is
 * the single biggest support footgun for forward swaps.
 *
 * Boltz fee includes a percentage charge on the input amount, so the
 * `expectedAmount` returned by `createSubmarineSwapForward` is what we
 * must hand to the sender — never the raw invoice amount.
 *
 * BIP-21 amount is denominated in BTC, encoded with up to 8 decimal places
 * and trailing-zero stripped (per the spec; some wallets get confused by
 * trailing zeros even though the spec allows them).
 */
export { buildBoltzBip21Uri } from '../utils/externalSwapPayment';

// ─── Legacy alias for backward compatibility ──────────────────────────────────

/** @deprecated Use createReverseSwap instead */
export const createSubmarineSwap = async (
  onchainAddress: string,
  amountSats: number,
): Promise<{ id: string; invoice: string; expectedAmount: number }> => {
  const swap = await createReverseSwap(onchainAddress, amountSats);
  return {
    id: swap.id,
    invoice: swap.invoice,
    expectedAmount: swap.onchainAmount,
  };
};
