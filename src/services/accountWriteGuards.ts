import { reviveDmOwner } from './dmOwnerGuard';
import { reviveSellerAccount } from './sellerEventStore';

/** `pubkey` is the signed-in account again: lift the sign-out write guards
 * that keep late writes from recreating its wiped data. */
export function reviveAccountWrites(pubkey: string): void {
  reviveSellerAccount(pubkey);
  reviveDmOwner(pubkey);
}
