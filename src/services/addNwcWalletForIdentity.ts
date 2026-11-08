import * as nwc from './nwcService';
import * as storage from './walletStorageService';
import { parseNwcLud16 } from '../utils/nwcLud16';
import type { CardTheme, WalletState, WalletMetadata } from '../types/wallet';

/** Pin writes to the starting owner; never import a connecting wallet into a new identity. */
export async function addNwcWalletForIdentity(
  url: string,
  alias: string,
  theme: CardTheme,
  wallets: readonly WalletState[],
  isCurrent: () => boolean,
): Promise<{ success: boolean; error?: string; state?: WalletState }> {
  const owner = storage.getActivePubkey();
  const cancelled = { success: false, error: 'Wallet identity changed. Please try again.' };
  if (!isCurrent()) return cancelled;
  for (const wallet of wallets.filter((w) => w.walletType === 'nwc')) {
    const stored = await storage.getNwcUrl(wallet.id);
    if (!isCurrent()) return cancelled;
    if (stored?.trim() === url.trim())
      return { success: false, error: 'This wallet is already connected' };
  }
  const id = storage.generateWalletId();
  let committed = false;
  try {
    const result = await nwc.connect(id, url, undefined, isCurrent);
    if (!isCurrent()) return cancelled;
    if (!result.success) return { success: false, error: result.error };
    const info = await nwc.getInfo(id, isCurrent);
    if (!isCurrent()) return cancelled;
    const metadata: WalletMetadata = {
      id,
      alias,
      theme,
      order: wallets.length,
      walletType: 'nwc',
      lightningAddress: parseNwcLud16(url) || info?.lud16 || null,
    };
    await storage.saveNwcUrl(id, url.trim());
    if (!isCurrent()) return cancelled;
    // Owner is explicit even if the account changes during native storage I/O.
    let shouldCommit = false;
    await storage.updateWalletList((list) => {
      if (!isCurrent()) return null;
      shouldCommit = true;
      return [...list, metadata];
    }, owner);
    committed = shouldCommit;
    if (!isCurrent()) return cancelled;
    return {
      success: true,
      state: {
        ...metadata,
        isConnected: true,
        // Seed the four-state health so a wallet whose connect probe already
        // answered shows green immediately, not "Checking…" until the
        // watchdog's next sync (#1768).
        connectionHealth: nwc.getWalletHealth(id, nwc.isSocketConnected(id)),
        balance: result.balance ?? null,
        walletAlias: info?.alias || null,
        transactions: [],
      },
    };
  } finally {
    if (!committed || !isCurrent()) nwc.disconnect(id);
    // An owner-list write already started is retained for that owner only.
    if (!committed) await storage.deleteNwcUrl(id);
  }
}
