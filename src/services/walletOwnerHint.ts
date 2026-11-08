import AsyncStorage from '@react-native-async-storage/async-storage';

// Last active account's pubkey, in plain AsyncStorage so cold start can read
// it without waiting on SecureStore. It is only a hint: WalletContext uses it
// to start reading that account's cached wallets early, and keeps the result
// only if the SecureStore-backed auto-login confirms the same owner. Holds a
// public key and nothing else — never a signer secret.
const WALLET_OWNER_HINT_KEY = 'wallet_owner_hint_v1';

// Last value read or written, so repeated publishes of one owner write once.
let knownHint: string | null | undefined;

export async function readWalletOwnerHint(): Promise<string | null> {
  try {
    const hint = await AsyncStorage.getItem(WALLET_OWNER_HINT_KEY);
    knownHint = hint;
    return hint;
  } catch {
    return null;
  }
}

/** Fire-and-forget: a failed write only costs the next cold start its head start. */
export function writeWalletOwnerHint(owner: string | null): void {
  if (knownHint === owner) return;
  knownHint = owner;
  const write = owner
    ? AsyncStorage.setItem(WALLET_OWNER_HINT_KEY, owner)
    : AsyncStorage.removeItem(WALLET_OWNER_HINT_KEY);
  void write.catch(() => {});
}

export function __resetWalletOwnerHintForTests(): void {
  knownHint = undefined;
}
