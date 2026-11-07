/**
 * Ark wallet upkeep: the overview the screen renders (balance, coin expiry,
 * history), refreshing coins before they expire, moving funds in from and
 * out to on-chain, and the emergency (unilateral) exit.
 *
 * Ark coins (VTXOs) expire. Before then they must be refreshed in a round,
 * which the bark daemon does on its own while the app is open. If the
 * phone stays closed past expiry the server can sweep the coins, so the
 * screen warns early and offers a manual refresh. If the server ever goes
 * away, the emergency exit puts the coins on-chain without its help.
 */
import { getArkHandle, getArkReceiveAddress } from './arkService';
import {
  arkExpiryInfo,
  toArkHistory,
  type ArkExpiryInfo,
  type ArkHistoryItem,
} from '../utils/arkCoinHealth';

export interface ArkOverview {
  spendableSats: number;
  /** Boards waiting for confirmations, coins in a round, Lightning in flight. */
  pendingSats: number;
  /** Coins on their way out in an emergency exit. */
  exitingSats: number;
  /** bark's on-chain wallet (boarding funds, exit claims). */
  onchainSats: number;
  arkAddress: string;
  expiry: ArkExpiryInfo;
  coinsToRefresh: number;
  claimableExits: number;
  history: ArkHistoryItem[];
}

export interface ArkFeeQuote {
  feeSats: number;
  /** What arrives on-chain after fees. */
  netSats: number;
}

/** Sync, claim any Lightning receives that are ready, and read everything the screen shows. */
export async function getArkOverview(): Promise<ArkOverview> {
  const { wallet, onchain, server } = await getArkHandle();
  await wallet.sync();
  await onchain.sync().catch(() => 0n); // on-chain view is best effort
  await wallet.tryClaimAllLightningReceives(false).catch(() => []);
  const [balance, onchainBalance, firstExpiry, toRefresh, claimable, movements, tip] =
    await Promise.all([
      wallet.balance(),
      onchain.balance().catch(() => null),
      wallet.getFirstExpiringVtxoBlockheight(),
      wallet.getVtxosToRefresh(),
      wallet.listClaimableExits().catch(() => []),
      wallet.history(),
      onchain.tipHeight().catch(() => null),
    ]);
  const pending =
    balance.pendingInRoundSats +
    balance.pendingBoardSats +
    balance.claimableLightningReceiveSats +
    balance.pendingLightningSendSats;
  return {
    spendableSats: Number(balance.spendableSats),
    pendingSats: Number(pending),
    exitingSats: Number(balance.pendingExitSats),
    onchainSats: onchainBalance ? Number(onchainBalance.totalSats) : 0,
    arkAddress: await getArkReceiveAddress(wallet, server),
    expiry: arkExpiryInfo(tip, firstExpiry ?? null, toRefresh.length > 0),
    coinsToRefresh: toRefresh.length,
    claimableExits: claimable.filter((e) => e.isClaimable).length,
    history: toArkHistory(movements),
  };
}

/**
 * Refresh coins now: the ones bark says need it, or every spendable coin
 * when the user asks early. Resolves false when there was nothing to do.
 */
export async function refreshArkCoins(): Promise<boolean> {
  const { wallet } = await getArkHandle();
  const due = await wallet.getVtxosToRefresh();
  const coins = due.length > 0 ? due : await wallet.spendableVtxos();
  if (coins.length === 0) return false;
  await wallet.refreshVtxos(coins.map((v) => v.id));
  return true;
}

/** An on-chain address of bark's wallet, to fund a board from any Bitcoin wallet or faucet. */
export async function getArkBoardingAddress(): Promise<string> {
  const { onchain } = await getArkHandle();
  return onchain.newAddress();
}

/** Move every confirmed on-chain sat of bark's wallet into the Ark. */
export async function boardOnchainFunds(): Promise<number> {
  const { wallet } = await getArkHandle();
  const board = await wallet.boardAll();
  return Number(board.amountSats);
}

/** Fee quote for moving the whole Ark balance to an on-chain address (cooperative offboard). */
export async function quoteMoveAllOnchain(address: string): Promise<ArkFeeQuote> {
  const { wallet } = await getArkHandle();
  const quote = await wallet.estimateOffboardAllFee(address);
  return { feeSats: Number(quote.feeSats), netSats: Number(quote.netAmountSats) };
}

/** Cooperatively move the whole Ark balance to an on-chain address. Resolves the txid. */
export async function moveAllOnchain(address: string): Promise<string> {
  const { wallet } = await getArkHandle();
  const result = await wallet.offboardAll(address);
  return result.txid;
}

/**
 * Start the emergency exit for every coin: publishes the coins' exit
 * transactions on-chain without the server. Costs on-chain fees (paid from
 * bark's on-chain wallet) and takes a timelock to complete, so it is the
 * last resort when the server is gone or refuses to cooperate.
 */
export async function startEmergencyExit(): Promise<void> {
  const { wallet } = await getArkHandle();
  await wallet.startExitForEntireWallet();
  await wallet.progressExits(undefined);
}

/** Push in-flight exits forward (CPFP, confirmations); call on each screen visit. */
export async function progressEmergencyExit(): Promise<void> {
  const { wallet } = await getArkHandle();
  if (!(await wallet.hasPendingExits())) return;
  await wallet.syncExits();
  await wallet.progressExits(undefined);
}

/** Sweep every exit that has cleared its timelock to an on-chain address. Resolves the txid. */
export async function claimExitsTo(address: string): Promise<string> {
  const { bark, wallet } = await getArkHandle();
  const claim = await wallet.drainExits([], true, address, undefined);
  const signed = await wallet.signExitClaimInputs(claim.psbtBase64);
  return wallet.broadcastTx(bark.extractTxFromPsbt(signed));
}
