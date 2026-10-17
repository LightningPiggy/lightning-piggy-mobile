import { getLocalDb } from './localDb';
import type { Nip171Ticket } from '../utils/nip171';

// NIP-171 tickets in the encrypted local DB. A ticket holds a group's epoch
// private key: it must never be written anywhere unencrypted.

/** Store a validated ticket. Idempotent by event id. */
export async function saveNip171Ticket(owner: string, ticket: Nip171Ticket): Promise<void> {
  const db = await getLocalDb();
  await db.execute(
    `INSERT OR IGNORE INTO nip171_tickets
       (owner, event_id, group_pubkey, epoch, created_at, epoch_secret, sig)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [
      owner,
      ticket.id,
      ticket.groupPubkey,
      ticket.epoch,
      ticket.createdAt,
      ticket.epochSecretHex,
      ticket.sig,
    ],
  );
}

/** Every ticket this account holds, for all groups. */
export async function loadNip171Tickets(owner: string): Promise<Nip171Ticket[]> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT event_id, group_pubkey, epoch, created_at, epoch_secret, sig
       FROM nip171_tickets WHERE owner = ?;`,
    [owner],
  );
  return (res.rows ?? []).map((r) => ({
    id: String(r.event_id),
    groupPubkey: String(r.group_pubkey),
    memberPubkey: owner,
    epoch: Number(r.epoch),
    epochSecretHex: String(r.epoch_secret),
    createdAt: Number(r.created_at),
    sig: String(r.sig),
  }));
}

/** Forget one group's tickets (we left it). */
export async function deleteNip171Group(owner: string, groupPubkey: string): Promise<void> {
  const db = await getLocalDb();
  await db.execute(`DELETE FROM nip171_tickets WHERE owner = ? AND group_pubkey = ?;`, [
    owner,
    groupPubkey,
  ]);
}

/** Account wipe. */
export async function deleteNip171ForOwner(owner: string): Promise<void> {
  const db = await getLocalDb();
  await db.execute(`DELETE FROM nip171_tickets WHERE owner = ?;`, [owner]);
}
