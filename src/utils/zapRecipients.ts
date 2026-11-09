/**
 * Recipient pubkeys for the incoming-zap `#p` filter: the user's own Nostr
 * pubkey plus the LNURL server's `nostrPubkey` for the wallet's lightning
 * address (self-hosted LNbits tags zap receipts with the server's pubkey, not
 * the user's).
 *
 * `providerPubkey` is that same LNURL server key: NIP-57 requires every
 * receipt to be authored by it, so it is the only key a receipt for this
 * wallet may be signed with (#1780). Null when the wallet has no lightning
 * address, the server doesn't support zaps, or it can't be reached.
 *
 * The caller awaits this only AFTER the zap resolver's pending/fingerprint
 * short-circuits, so the common no-op balance tick (nothing new to attribute)
 * never pays the `resolveLud16ToNostrPubkey` network round-trip — that
 * round-trip on every balance poll was part of the #828 tap-window contention.
 */
export async function collectZapRecipientPubkeys(
  userPubkey: string | null,
  lightningAddress: string | null | undefined,
  resolveLud16ToNostrPubkey: (lud16: string) => Promise<string | null>,
): Promise<{ recipients: string[]; providerPubkey: string | null }> {
  const recipients: string[] = [];
  if (userPubkey) recipients.push(userPubkey);
  const providerPubkey = lightningAddress
    ? await resolveLud16ToNostrPubkey(lightningAddress)
    : null;
  if (providerPubkey) recipients.push(providerPubkey);
  return { recipients, providerPubkey };
}
