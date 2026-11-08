// Shared pubkey + read relays of the currently logged-in Nostr user.
// Kept as module state because `WalletProvider` wraps `NostrProvider` in
// the tree, so the wallet layer can't read `NostrContext` via React hooks
// — but it needs the recipient pubkey (for the `#p` zap-receipt filter)
// and the user's configured read relays (so queries also hit the relays
// that actually carry their zap history).
let _currentUserPubkey: string | null = null;
let _currentUserReadRelays: string[] = [];
const _pubkeyListeners = new Set<(pubkey: string | null) => void>();
export function setCurrentUserPubkey(pubkey: string | null): void {
  if (_currentUserPubkey === pubkey) return;
  _currentUserPubkey = pubkey;
  // A new identity's own relays aren't known until its lists load (#1390).
  _ownRelaysHydrated = false;
  _pubkeyListeners.forEach((fn) => {
    try {
      fn(pubkey);
    } catch (e) {
      if (__DEV__) console.warn('[Nostr] pubkey listener threw:', e);
    }
  });
}
export function getCurrentUserPubkey(): string | null {
  return _currentUserPubkey;
}
export function setCurrentUserReadRelays(relays: string[]): void {
  _currentUserReadRelays = [...relays];
}
export function getCurrentUserReadRelays(): string[] {
  return _currentUserReadRelays;
}

// Every relay the viewer reads from — read relays AND DM inbox relays (the
// `getReadRelays()` set). Never leased as someone else's outbox relay
// (#1390): the viewer's own subs (e.g. the live DM inbox) must never share a
// budgeted outbox socket, whichever caller asks. `hydrated`: the set comes
// from this identity's own lists, not the defaults used before they load —
// until then nothing may be leased at all.
let _currentUserOwnRelays: readonly string[] = [];
let _ownRelaysHydrated = false;
const _ownRelayListeners = new Set<(relays: readonly string[]) => void>();
export function setCurrentUserOwnRelays(relays: readonly string[], hydrated: boolean): void {
  _currentUserOwnRelays = [...relays];
  _ownRelaysHydrated = hydrated;
  _ownRelayListeners.forEach((fn) => {
    try {
      fn(_currentUserOwnRelays);
    } catch (e) {
      if (__DEV__) console.warn('[Nostr] own-relays listener threw:', e);
    }
  });
}
export function getCurrentUserOwnRelays(): readonly string[] {
  return _currentUserOwnRelays;
}
export function areCurrentUserOwnRelaysHydrated(): boolean {
  return _ownRelaysHydrated;
}
export function onCurrentUserOwnRelaysChange(fn: (relays: readonly string[]) => void): () => void {
  _ownRelayListeners.add(fn);
  return () => _ownRelayListeners.delete(fn);
}
export function onCurrentUserPubkeyChange(fn: (pubkey: string | null) => void): () => void {
  _pubkeyListeners.add(fn);
  return () => _pubkeyListeners.delete(fn);
}
