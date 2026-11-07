export interface NostrProfile {
  pubkey: string; // hex
  npub: string; // bech32
  name: string | null;
  displayName: string | null;
  picture: string | null;
  banner: string | null;
  about: string | null;
  // Lightning address. From `fetchProfile`, the newest VERIFIED one seen for
  // this pubkey, which may come from a newer kind-0 than the other fields.
  lud16: string | null;
  nip05: string | null;
  // Set by slimDisplayProfile: records whether a lud16 was present before it
  // was stripped, so display surfaces can show/grey the zap affordance without
  // exposing the (unverified, forgeable) address value.
  hasLud16?: boolean;
}

export interface NostrContact {
  pubkey: string; // hex
  relay: string | null;
  petname: string | null;
  profile: NostrProfile | null; // populated after fetching
}

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export type SignerType = 'nsec' | 'amber' | 'nip46';

/**
 * Persisted NIP-46 ("Nostr Connect" / bunker) connection state.
 *
 * One per logged-in identity, written to SecureStore on pairing and
 * read back on app startup so the BunkerSigner can be re-instantiated
 * without re-pairing through the QR / nostrconnect:// flow.
 *
 * `clientSecretKey` is the per-app keypair generated at pairing time —
 * it never represents the user's real Nostr identity (that key lives on
 * the bunker side). It is, however, sensitive: anyone with the
 * clientSecretKey + remote pubkey + relay can impersonate this app
 * session against the bunker. Hence SecureStore, not AsyncStorage.
 */
export interface Nip46Connection {
  /** Hex pubkey of the remote signer (bunker). This is who we send
   *  encrypted requests to and who relays replies back. */
  remoteSignerPubkey: string;
  /** Hex pubkey the bunker is signing as. May equal `remoteSignerPubkey`
   *  on simple bunkers (e.g. Clave), or differ on multi-account bunkers
   *  (nsec.app, etc.) where the bunker fronts multiple identities. */
  userPubkey: string;
  /** Relays to use for the BunkerSigner pool. The bunker subscribes here
   *  and we publish encrypted requests to the same set. */
  relays: string[];
  /** Per-app private key (hex, 64 chars). Pair-time entropy — distinct
   *  from the user's actual nsec, which never leaves the bunker. */
  clientSecretKeyHex: string;
  /** Comma-separated permissions granted at pair time (e.g.
   *  `sign_event,nip04_encrypt,nip44_decrypt`). Surfaced to the user in
   *  Settings; not enforced client-side — the bunker is the source of
   *  truth and will reject unpermitted methods. */
  perms: string;
}
