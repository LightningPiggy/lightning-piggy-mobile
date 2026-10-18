import { isSellerAccountForgotten } from './sellerEventStore';
// "Receive payments to" — the wallet a seller's order invoices are created
// on. A device/account preference (like the shop currency in
// sellerPreferences), never published to Nostr: a wallet id means nothing to
// anyone else. Resolved against the current wallets on read
// (utils/invoiceWallets.resolveReceiveWallet) so a removed or pay-only wallet
// counts as unset.
import AsyncStorage from '@react-native-async-storage/async-storage';

let writeChain: Promise<unknown> = Promise.resolve();
const key = (pubkey: string) => `market-seller-receive-wallet:${pubkey}`;

export async function loadSellerReceiveWallet(pubkey: string): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(key(pubkey));
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export async function saveSellerReceiveWallet(
  pubkey: string,
  walletId: string | null,
): Promise<void> {
  const run = writeChain.then(async () => {
    if (isSellerAccountForgotten(pubkey)) return;
    if (walletId) await AsyncStorage.setItem(key(pubkey), walletId);
    else await AsyncStorage.removeItem(key(pubkey));
  });
  writeChain = run.catch(() => undefined);
  await run;
}
export async function drainSellerReceiveWalletWrites(): Promise<void> {
  await writeChain;
}
