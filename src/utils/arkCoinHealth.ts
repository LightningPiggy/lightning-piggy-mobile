/**
 * Pure helpers for showing Ark coin (VTXO) health: how long until coins
 * expire, whether they need a refresh, and how wallet movements read in the
 * history list. Kept free of the native module so they are unit-tested.
 */

/** Signet and mainnet both target ~10-minute blocks. */
export const BLOCKS_PER_DAY = 144;

/**
 * Below this many blocks the app asks the user to keep their coins fresh.
 * bark's own default refresh threshold is 288 blocks (~2 days); the daemon
 * refreshes on its own while the app is open, so this only warns.
 */
export const ARK_REFRESH_WARNING_BLOCKS = 288 * 2;

export type ArkCoinHealth = 'none' | 'ok' | 'refreshSoon' | 'urgent';

export interface ArkExpiryInfo {
  health: ArkCoinHealth;
  /** Blocks until the first coin expires, or null when there are no coins / no tip. */
  blocksLeft: number | null;
  /** Whole days, rounded down, for the "expires in about N days" line. */
  daysLeft: number | null;
}

/**
 * @param tipHeight current chain height, or null when the chain source is unreachable
 * @param firstExpiryHeight bark's `getFirstExpiringVtxoBlockheight()`
 * @param refreshNeeded true when bark reports coins it wants refreshed now
 */
export function arkExpiryInfo(
  tipHeight: number | null,
  firstExpiryHeight: number | null,
  refreshNeeded: boolean,
): ArkExpiryInfo {
  if (firstExpiryHeight === null) return { health: 'none', blocksLeft: null, daysLeft: null };
  if (tipHeight === null) {
    return { health: refreshNeeded ? 'refreshSoon' : 'ok', blocksLeft: null, daysLeft: null };
  }
  const blocksLeft = Math.max(0, firstExpiryHeight - tipHeight);
  const daysLeft = Math.floor(blocksLeft / BLOCKS_PER_DAY);
  let health: ArkCoinHealth = 'ok';
  if (blocksLeft <= BLOCKS_PER_DAY) health = 'urgent';
  else if (refreshNeeded || blocksLeft <= ARK_REFRESH_WARNING_BLOCKS) health = 'refreshSoon';
  return { health, blocksLeft, daysLeft };
}

/** The subset of bark's `Movement` the history list needs. */
export interface ArkMovementLike {
  id: number;
  status: string;
  subsystemName: string;
  effectiveBalanceSats: bigint;
  offchainFeeSats: bigint;
  createdAt: string;
}

export type ArkHistoryKind = 'received' | 'sent' | 'refresh' | 'exit' | 'other';

export interface ArkHistoryItem {
  id: number;
  kind: ArkHistoryKind;
  /** Absolute amount in sats; the kind gives the direction. */
  amountSats: number;
  feeSats: number;
  pending: boolean;
  failed: boolean;
  createdAt: string;
}

function historyKind(m: ArkMovementLike, delta: number): ArkHistoryKind {
  const subsystem = m.subsystemName.toLowerCase();
  if (subsystem.includes('refresh')) return 'refresh';
  if (subsystem.includes('exit')) return 'exit';
  if (delta > 0) return 'received';
  if (delta < 0) return 'sent';
  return 'other';
}

/** Newest first, capped, with refreshes that moved no money hidden. */
export function toArkHistory(movements: ArkMovementLike[], limit = 25): ArkHistoryItem[] {
  return movements
    .map((m) => {
      const delta = Number(m.effectiveBalanceSats);
      const status = m.status.toLowerCase();
      return {
        id: m.id,
        kind: historyKind(m, delta),
        amountSats: Math.abs(delta),
        feeSats: Number(m.offchainFeeSats),
        pending: status === 'pending',
        failed: status === 'failed' || status === 'canceled' || status === 'cancelled',
        createdAt: m.createdAt,
      };
    })
    .filter((item) => !(item.kind === 'refresh' && item.amountSats === 0 && item.feeSats === 0))
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}
