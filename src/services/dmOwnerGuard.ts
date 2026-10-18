// Keeps writes that outlive an account's sign-out from putting its DM rows
// back. Background saves (the DM watch, a notification's catch-up) decrypt
// and write outside any session, so a sign-out can land at any point:
// - before the save starts: the account is retired until it signs in again;
// - while it runs: the wipe epoch moves, and the save checks it inside its
//   write transaction (dmDb `upsertDmMessagesIf`).
// Plain module state, no database: the background save loads this without
// pulling in the store.

const ownerWipeEpochs = new Map<string, number>();
const retiredOwners = new Set<string>();

/** Changes when `owner`'s DM rows are wiped (sign-out / account removal). */
export function dmOwnerEpoch(owner: string): number {
  return ownerWipeEpochs.get(owner.toLowerCase()) ?? 0;
}

/** Whether `owner` was signed out in this process and not signed in since. */
export function isDmOwnerRetired(owner: string): boolean {
  return retiredOwners.has(owner.toLowerCase());
}

/** Called (synchronously) by the wipe, before it deletes anything. */
export function retireDmOwner(owner: string): void {
  const pk = owner.toLowerCase();
  ownerWipeEpochs.set(pk, dmOwnerEpoch(pk) + 1);
  retiredOwners.add(pk);
}

/** Lift the sign-out write guard: `owner` is the active account again. */
export function reviveDmOwner(owner: string): void {
  retiredOwners.delete(owner.toLowerCase());
}
