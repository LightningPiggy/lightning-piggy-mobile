export type CardTheme =
  | 'lightning-piggy'
  | 'wise-owl'
  | 'invaders'
  | 'zaplie'
  | 'zaplie-bolt'
  | 'lightning-bee'
  | 'lightning-cat'
  | 'bitpopart'
  | 'lightning-cow'
  | 'lightning-goat'
  | 'nostrich'
  | 'lightning-whale'
  | 'sallie'
  | 'poppie'
  | 'bitcoin'
  | 'alby'
  | 'lnbits'
  | 'primal'
  | 'coinos'
  | 'revolut'
  | 'xapo'
  // Sports-themed cards (#102). Each renders a graffiti illustration over
  // its gradient — `backgroundImage` + `backgroundImageStyle` live on the
  // entry in `src/themes/cardThemes.ts`, with the per-theme `bgStyle`
  // registered in `src/themes/cards/index.ts`.
  | 'tennis'
  | 'football'
  | 'basketball'
  | 'f1'
  // Deep-space nebula card with a graffiti rocket illustration.
  | 'spaceship'
  // Friendly AI robot corner-mascot (graffiti family) over an emerald/teal gradient.
  | 'ai-robot';

export type WalletType = 'nwc' | 'onchain';

/** How an on-chain wallet was imported. Only 'xpub' is supported now;
 *  'mnemonic' and 'generated' are reserved for future hot-wallet support. */
export type OnchainImportMethod = 'xpub' | 'mnemonic' | 'generated';

export interface WalletMetadata {
  id: string;
  alias: string;
  theme: CardTheme;
  order: number;
  walletType: WalletType;
  /** NWC wallets only */
  lightningAddress: string | null;
  /** Hide balance figures across the UI for this wallet (Account list + WalletCard). */
  hideBalance?: boolean;
  /** On-chain wallets only */
  onchainImportMethod?: OnchainImportMethod;
  /** On-chain wallets: reserved metadata field for a future per-wallet
   *  Electrum/API server override. Not currently consulted by
   *  `onchainService` — it reads the global `getElectrumServer()` only.
   *  Keep writing the field if the UI collects it, but don't rely on it
   *  having any effect today. */
  electrumServer?: string;
}

export type TransactionType = 'incoming' | 'outgoing';

/**
 * The "other party" of a NIP-57 zap transaction — the sender for an
 * incoming zap, the recipient for an outgoing one. Same shape for both
 * directions so the UI can render symmetrically with just a preposition
 * flip ("Received from …" vs "Sent to …").
 */
export interface ZapCounterpartyInfo {
  /** Counterparty's hex pubkey, or null if an anonymous incoming zap. */
  pubkey: string | null;
  /** Resolved kind-0 profile (null until fetched / not found). */
  profile: {
    npub: string;
    name: string | null;
    displayName: string | null;
    picture: string | null;
    nip05: string | null;
    // Lightning address (`name@host`) from the kind-0 `lud16` field.
    // Optional rather than required so this stays backward-compatible
    // with cached entries that pre-date persistence: `undefined` means
    // "we don't know yet, fetch", whereas `null` means "fetched, no
    // address". Drives the Zap-back button in usePubkeyProfile.
    lud16?: string | null;
  } | null;
  /** Zap comment from the kind-9734 content field, if any. */
  comment: string;
  /** True when the zap request was marked anonymous (NIP-57 anon tag). */
  anonymous: boolean;
}

export interface WalletTransaction {
  type: TransactionType;
  amount: number;
  description?: string;
  created_at?: number | null;
  settled_at?: number | null;
  /** Explicit wallet settlement state; some providers omit settled_at. */
  settled?: boolean;
  /** The wallet itself still reports the payment pending (or, without a
   *  NIP-47 `state`, unsettled), even when a local payment proof already
   *  counts it `settled`. Until it flips, the wallet may still hold a
   *  routing-fee reserve against the balance (#1179). */
  walletPending?: boolean;
  blockHeight?: number | null;
  /** Also set for Boltz claim txs, not just plain on-chain. */
  txid?: string;
  paymentHash?: string;
  preimage?: string;
  invoice?: string;
  /** Bolt11 invoice — needed to look up the paired zap receipt. */
  bolt11?: string;
  feesSats?: number;
  /** `undefined` = not yet resolved; `null` = tried and nothing found. */
  zapCounterparty?: ZapCounterpartyInfo | null;
  swapId?: string;
  swapType?: 'reverse' | 'submarine';
  claimTxId?: string;
  /**
   * Inserted client-side by SendSheet immediately after a successful
   * pay_invoice so the UI (ConversationScreen, TransactionList) can show
   * the send without waiting for LNbits to flush it into its ledger and
   * the next refresh to pick it up. Dropped on the next refresh when the
   * real tx arrives (matched by paymentHash).
   */
  optimistic?: boolean;
}

/** Format wallet name with type suffix for dropdowns */
export function walletLabel(w: { alias: string; walletType: WalletType }): string {
  return `${w.alias} (${w.walletType === 'onchain' ? 'on-chain' : 'lightning'})`;
}

/**
 * Four-state NWC health for the wallet card (#786, #1768). `checking` shows
 * grey "Checking…" (socket open, nothing failed, but the wallet hasn't answered
 * a request in the last 5 min — fresh start, just reconnected, or idle);
 * `responsive` shows green "Connected" (the wallet actually answered recently);
 * `degraded` shows amber "Not responding" (connected socket but the relay is
 * parked / not answering); `disconnected` shows red. Absent before the
 * watchdog's first sync, in which case the card shows neutral `checking` (see
 * `resolveWalletHealth`). Display only: Send / Receive gate on `isConnected`,
 * which stays true through `checking`.
 */
export type WalletConnectionHealth = 'checking' | 'responsive' | 'degraded' | 'disconnected';

export interface WalletState extends WalletMetadata {
  isConnected: boolean;
  connectionHealth?: WalletConnectionHealth;
  balance: number | null;
  walletAlias: string | null; // alias from NWC getInfo()
  transactions: WalletTransaction[];
}
