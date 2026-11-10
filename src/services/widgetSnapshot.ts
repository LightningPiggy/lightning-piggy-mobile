// The home-screen widget's read-only view of the wallets (#1849).
//
// The widget runs without the app (Android starts a headless JS task to draw
// it), so the app leaves it a small snapshot in AsyncStorage whenever wallet
// balances change. PRIVACY: the snapshot is an allow-list. Per wallet it holds
// only the id, display name, wallet type, balance, fiat value + currency, when
// the balance was last confirmed, carousel order and a connection-OK flag —
// never an NWC string, mnemonic, xpub, Lightning address, Nostr key or any
// other field of the wallet record. `shapeWidgetWallet` copies the allowed
// fields one by one (never spreads), so a field added to `WalletState` later
// can't leak into it. The snapshot is wiped on sign-out and account switch.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WalletState, WalletType } from '../types/wallet';
import { subscribeActivePubkey } from './walletStorageService';

export const WIDGET_SNAPSHOT_KEY = 'widget_snapshot_v1';

/** One wallet as the widget sees it. Every key here is allow-listed. */
export interface WidgetWallet {
  id: string;
  name: string;
  walletType: WalletType;
  /** null when unknown, or when the wallet's balance is hidden in the app. */
  balanceSats: number | null;
  fiatValue: number | null;
  currency: string;
  /** Epoch ms the app last saw this balance on a connected wallet. */
  updatedAt: number | null;
  /** Position in the app's wallet carousel (0 = first). */
  order: number;
  connected: boolean;
}

export interface WidgetSnapshot {
  version: 1;
  /** Resolved app language, so the headless widget task speaks it too. */
  locale: string;
  wallets: WidgetWallet[];
}

/** The exact key set of a snapshot wallet — the property tests pin this. */
export const WIDGET_WALLET_KEYS = [
  'id',
  'name',
  'walletType',
  'balanceSats',
  'fiatValue',
  'currency',
  'updatedAt',
  'order',
  'connected',
] as const satisfies readonly (keyof WidgetWallet)[];

export interface ShapeOptions {
  btcPrice: number | null;
  currency: string;
  now: number;
  /** The previous snapshot, to carry a stale wallet's last-confirmed time over. */
  previous?: WidgetSnapshot | null;
}

/** Usable for the widget's purposes: an NWC wallet that's connected and not
 *  reported down, or an on-chain wallet (synced on demand, never "offline"). */
function isWalletUp(wallet: WalletState): boolean {
  if (wallet.walletType === 'onchain') return true;
  return (
    wallet.isConnected &&
    wallet.connectionHealth !== 'disconnected' &&
    wallet.connectionHealth !== 'degraded'
  );
}

export function shapeWidgetWallet(
  wallet: WalletState,
  order: number,
  { btcPrice, currency, now, previous }: ShapeOptions,
): WidgetWallet {
  // A balance the user hid in the app never reaches the home screen.
  const balance =
    !wallet.hideBalance && typeof wallet.balance === 'number' && Number.isFinite(wallet.balance)
      ? wallet.balance
      : null;
  const fiatValue =
    balance !== null && btcPrice !== null && Number.isFinite(btcPrice)
      ? (balance / 100_000_000) * btcPrice
      : null;
  const connected = isWalletUp(wallet);
  const prior = previous?.wallets.find((w) => w.id === wallet.id);
  return {
    id: wallet.id,
    name: (wallet.alias || '').trim(),
    walletType: wallet.walletType,
    balanceSats: balance,
    fiatValue,
    currency,
    updatedAt: connected && balance !== null ? now : (prior?.updatedAt ?? null),
    order,
    connected,
  };
}

/** Wallets in carousel order: by `order`, ties keep their list position. */
export function sortWalletsForCarousel<T extends { order?: number }>(wallets: readonly T[]): T[] {
  return wallets
    .map((wallet, index) => ({ wallet, index }))
    .sort((a, b) => (a.wallet.order ?? 0) - (b.wallet.order ?? 0) || a.index - b.index)
    .map(({ wallet }) => wallet);
}

export function buildWidgetSnapshot(
  wallets: readonly WalletState[],
  locale: string,
  options: ShapeOptions,
): WidgetSnapshot {
  return {
    version: 1,
    locale,
    wallets: sortWalletsForCarousel(wallets).map((w, i) => shapeWidgetWallet(w, i, options)),
  };
}

/** Identity of a snapshot for "did anything the widget shows change?",
 *  ignoring the confirmed-at times (they move on every write). */
export function snapshotFingerprint(snapshot: WidgetSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    wallets: snapshot.wallets.map((w) => ({ ...w, updatedAt: null })),
  });
}

function isWidgetWallet(value: unknown): value is WidgetWallet {
  if (!value || typeof value !== 'object') return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    (w.walletType === 'nwc' || w.walletType === 'onchain') &&
    (w.balanceSats === null || typeof w.balanceSats === 'number') &&
    (w.fiatValue === null || typeof w.fiatValue === 'number') &&
    typeof w.currency === 'string' &&
    (w.updatedAt === null || typeof w.updatedAt === 'number') &&
    typeof w.order === 'number' &&
    typeof w.connected === 'boolean'
  );
}

/** Parse stored JSON defensively; anything malformed reads as "no snapshot".
 *  Re-shapes each wallet through the allow-list so stray keys are dropped. */
export function parseWidgetSnapshot(json: string | null): WidgetSnapshot | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<WidgetSnapshot> | null;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.wallets)) return null;
    const wallets = raw.wallets.filter(isWidgetWallet).map(
      (w): WidgetWallet => ({
        id: w.id,
        name: w.name,
        walletType: w.walletType,
        balanceSats: w.balanceSats,
        fiatValue: w.fiatValue,
        currency: w.currency,
        updatedAt: w.updatedAt,
        order: w.order,
        connected: w.connected,
      }),
    );
    return {
      version: 1,
      locale: typeof raw.locale === 'string' ? raw.locale : 'en',
      wallets: sortWalletsForCarousel(wallets),
    };
  } catch {
    return null;
  }
}

// Writes and the wipe run one at a time, in call order, so a write that was
// already in flight when the account changed can't land after the wipe.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op, op);
  queue = next.catch(() => undefined);
  return next;
}

export function readWidgetSnapshot(): Promise<WidgetSnapshot | null> {
  return AsyncStorage.getItem(WIDGET_SNAPSHOT_KEY)
    .then(parseWidgetSnapshot)
    .catch(() => null);
}

export function writeWidgetSnapshot(snapshot: WidgetSnapshot): Promise<void> {
  return enqueue(() => AsyncStorage.setItem(WIDGET_SNAPSHOT_KEY, JSON.stringify(snapshot)));
}

/** Sign-out / account switch: the widget must forget every wallet. */
export function wipeWidgetSnapshot(): Promise<void> {
  return enqueue(() => AsyncStorage.removeItem(WIDGET_SNAPSHOT_KEY));
}

/**
 * Wipe the snapshot whenever the signed-in account changes — sign-out (to
 * nobody) or a switch to another account. The cold-start publish of the
 * account that's already signed in is not a change. `onWipe` runs at once
 * (so the caller can drop any write it was preparing) with the pending wipe.
 */
export function wipeWidgetSnapshotOnAccountChange(
  onWipe: (wiped: Promise<void>) => void,
): () => void {
  return subscribeActivePubkey((_pubkey, change) => {
    if (change?.startup) return;
    onWipe(wipeWidgetSnapshot());
  });
}
