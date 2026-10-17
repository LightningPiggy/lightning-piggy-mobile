import { hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';
import { nostrGetEventHash, nostrVerifyEvent } from './nostrCrypto';
import { deleteNip171Group, loadNip171Tickets, saveNip171Ticket } from './nip171Store';
import {
  nip171MetaStore,
  nip171StatusStore,
  type Nip171GroupMeta,
  type Nip171GroupStatus,
} from './nip171Membership';
import type { Group } from '../types/groups';
import {
  groupKeysFromTickets,
  groupRumorTags,
  nip171GroupId,
  NIP171_TICKET_KIND,
  parseTicket,
  type Nip171Event,
  type Nip171GroupKeys,
  type Nip171Ticket,
} from '../utils/nip171';

export type { Nip171GroupMeta } from './nip171Membership';

// NIP-171 groups this account belongs to, member side, built from the epoch
// tickets we hold (nip171Store). A ticket's seal comes from the group key, not
// from a person we could check against our follows, so a group is an
// invitation until the user accepts it: only accepted groups are subscribed
// to, have their profile fetched, or appear in GroupsContext. Declining or
// leaving is remembered, so the same tickets don't bring the group back; a
// newer ticket (a re-invite) is a new invitation.

/** Groups the account can be in at once (Anagram's limit). */
export const NIP171_MAX_GROUPS = 100;
/** Unanswered invitations kept; more are dropped, so strangers can't flood. */
export const NIP171_MAX_PENDING = 20;
/** Tickets kept per group (a new epoch is always taken: that's a rotation). */
export const NIP171_MAX_TICKETS_PER_GROUP = 8;
/** How far ahead of now a ticket's time may be (clock skew). */
const FUTURE_SKEW_SECS = 10 * 60;

export interface Nip171GroupState {
  keys: Nip171GroupKeys;
  /** Public key of the current epoch: messages are addressed to it. */
  epochPubkey: string;
  /** Public keys of every epoch we hold a key for (never valid authors). */
  epochPubkeys: Set<string>;
  /** Members we've seen post or be announced (the roster isn't published). */
  members: Set<string>;
  meta: Nip171GroupMeta;
  /** First ticket we received, ms. */
  joinedAt: number;
}

/** A group whose ticket we hold but haven't accepted. */
export interface Nip171Invitation {
  groupPubkey: string;
  /** Newest ticket `created_at`, seconds. */
  invitedAt: number;
}

interface OwnerState {
  groups: Map<string, Nip171GroupState>;
  invitations: Nip171Invitation[];
  status: Record<string, Nip171GroupStatus>;
}

const owners = new Map<string, OwnerState>();
const loads = new Map<string, Promise<void>>();
const listeners = new Set<(owner: string) => void>();
const EMPTY_INVITATIONS: Nip171Invitation[] = [];

// Bumped on every change, so `nip171GroupsFor` can hand back the same array
// (and the same row objects) until something actually changed.
const versions = new Map<string, number>();
const groupRows = new Map<string, { version: number; rows: Group[] }>();

const emit = (owner: string) => {
  versions.set(owner, (versions.get(owner) ?? 0) + 1);
  for (const listener of listeners) {
    try {
      listener(owner);
    } catch {
      // A listener failure must not stop the others.
    }
  }
};

/** Notified when an account's NIP-171 groups, keys or invitations change. */
export function subscribeNip171Groups(listener: (owner: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Verify a fresh copy (see parseTicket): never trust a memoised result.
const verify = (event: Required<Omit<Nip171Event, 'sealInvitationProof'>>) =>
  nostrVerifyEvent(event as Parameters<typeof nostrVerifyEvent>[0]);

const epochPubkeyOf = (secretHex: string) => getPublicKey(hexToBytes(secretHex));
const hash = (event: Omit<Nip171Event, 'id' | 'sig'>) =>
  nostrGetEventHash(event as Parameters<typeof nostrGetEventHash>[0]);

const newest = (list: readonly Nip171Ticket[]) => Math.max(...list.map((t) => t.createdAt));

function build(
  tickets: readonly Nip171Ticket[],
  meta: Record<string, Nip171GroupMeta>,
  status: Record<string, Nip171GroupStatus>,
  previous: OwnerState | undefined,
): OwnerState {
  const byGroup = new Map<string, Nip171Ticket[]>();
  for (const t of tickets) {
    const list = byGroup.get(t.groupPubkey) ?? [];
    list.push(t);
    byGroup.set(t.groupPubkey, list);
  }
  const groups = new Map<string, Nip171GroupState>();
  const invitations: Nip171Invitation[] = [];
  for (const [groupPubkey, list] of byGroup) {
    const decision = status[groupPubkey];
    if (decision?.status !== 'accepted') {
      // Declined / left: only a newer ticket is a new invitation.
      if (!decision || newest(list) > decision.at) {
        invitations.push({ groupPubkey, invitedAt: newest(list) });
      }
      continue;
    }
    const keys = groupKeysFromTickets(list);
    if (!keys) continue;
    const old = previous?.groups.get(groupPubkey);
    groups.set(groupPubkey, {
      keys,
      epochPubkey: epochPubkeyOf(keys.current.epochSecretHex),
      epochPubkeys: new Set([...keys.epochSecrets.values()].map(epochPubkeyOf)),
      members: old?.members ?? new Set(),
      meta: meta[groupPubkey] ?? old?.meta ?? {},
      joinedAt: Math.min(...list.map((t) => t.createdAt)) * 1000,
    });
  }
  invitations.sort((a, b) => b.invitedAt - a.invitedAt);
  return { groups, invitations, status };
}

async function reload(owner: string): Promise<void> {
  const [tickets, meta, status] = await Promise.all([
    loadNip171Tickets(owner),
    nip171MetaStore.read(owner),
    nip171StatusStore.read(owner),
  ]);
  owners.set(owner, build(tickets, meta, status, owners.get(owner)));
  emit(owner);
}

/** Load the account's groups from storage (once; later calls share it). */
export function loadNip171Groups(owner: string): Promise<void> {
  const pending = loads.get(owner);
  if (pending) return pending;
  const load = reload(owner).catch((error) => {
    loads.delete(owner);
    throw error;
  });
  loads.set(owner, load);
  return load;
}

/** The account's accepted NIP-171 groups, by group identity pubkey. */
export function nip171GroupStates(owner: string): ReadonlyMap<string, Nip171GroupState> {
  return owners.get(owner)?.groups ?? new Map();
}

export function nip171GroupState(owner: string, groupPubkey: string): Nip171GroupState | null {
  return owners.get(owner)?.groups.get(groupPubkey) ?? null;
}

/** Unanswered invitations, newest first. Stable between changes. */
export function nip171Invitations(owner: string | null): Nip171Invitation[] {
  return (owner && owners.get(owner)?.invitations) || EMPTY_INVITATIONS;
}

/** App `Group` rows for GroupsContext (accepted groups only). */
export function nip171GroupsFor(owner: string): Group[] {
  const version = versions.get(owner) ?? 0;
  const cached = groupRows.get(owner);
  if (cached?.version === version) return cached.rows;
  const rows = buildGroupRows(owner);
  groupRows.set(owner, { version, rows });
  return rows;
}

function buildGroupRows(owner: string): Group[] {
  return [...nip171GroupStates(owner)].map(([groupPubkey, s]) => ({
    id: nip171GroupId(groupPubkey),
    name: s.meta.name?.trim() || '',
    memberPubkeys: [...s.members].filter((m) => m !== owner),
    createdAt: s.joinedAt,
    updatedAt: s.joinedAt,
    protocol: 'nip171',
  }));
}

/**
 * A gift-wrapped `kind:1014` ticket that reached our own inbox. Returns true
 * when the rumor was a ticket, valid or not, so the DM inbox never shows it.
 * A valid ticket for a group we haven't accepted becomes an invitation.
 */
export async function ingestNip171Ticket(
  owner: string,
  rumor: Omit<Nip171Event, 'id'>,
): Promise<boolean> {
  if (rumor.kind !== NIP171_TICKET_KIND) return false;
  const ticket = parseTicket({ ...rumor, id: '' }, owner, verify, hash, epochPubkeyOf);
  if (!ticket) return true;
  await loadNip171Groups(owner).catch(() => undefined);
  const state = owners.get(owner);
  const decision = state?.status[ticket.groupPubkey];
  if (decision && decision.status !== 'accepted' && ticket.createdAt <= decision.at) return true;
  const known =
    decision?.status === 'accepted' ||
    state?.invitations.some((i) => i.groupPubkey === ticket.groupPubkey);
  if (!known && (state?.invitations.length ?? 0) >= NIP171_MAX_PENDING) return true;
  // A far-future time would also outrank every later decline.
  if (ticket.createdAt > Math.floor(Date.now() / 1000) + FUTURE_SKEW_SECS) return true;
  if (known) {
    // Bounded per group: repeats of a key we hold, and more of the same epochs
    // past the cap, are dropped; a higher epoch (a key rotation) is kept.
    const held = (await loadNip171Tickets(owner)).filter(
      (t) => t.groupPubkey === ticket.groupPubkey,
    );
    const sameKey = held.some(
      (t) =>
        t.epoch === ticket.epoch &&
        t.epochSecretHex === ticket.epochSecretHex &&
        t.createdAt >= ticket.createdAt,
    );
    const rotation = held.every((t) => t.epoch < ticket.epoch);
    if (sameKey || (held.length >= NIP171_MAX_TICKETS_PER_GROUP && !rotation)) return true;
  }
  await saveNip171Ticket(owner, ticket);
  await reload(owner);
  return true;
}

async function decide(
  owner: string,
  groupPubkey: string,
  status: Nip171GroupStatus['status'],
): Promise<void> {
  const tickets = (await loadNip171Tickets(owner)).filter((t) => t.groupPubkey === groupPubkey);
  const at = tickets.length ? newest(tickets) : Math.floor(Date.now() / 1000);
  await nip171StatusStore.update(owner, (all) => {
    all[groupPubkey] = { status, at };
  });
  if (status !== 'accepted') {
    // Declined or left: the keys go; the record keeps the tickets out.
    await deleteNip171Group(owner, groupPubkey);
    // Housekeeping only: a stale name / relay list is harmless.
    await nip171MetaStore
      .update(owner, (all) => {
        delete all[groupPubkey];
      })
      .catch(() => undefined);
  }
  await reload(owner);
}

/** Join an invited group. False when the account is at the group limit. */
export async function acceptNip171Invitation(owner: string, groupPubkey: string): Promise<boolean> {
  await loadNip171Groups(owner);
  if (nip171GroupStates(owner).size >= NIP171_MAX_GROUPS) return false;
  await decide(owner, groupPubkey, 'accepted');
  return true;
}

export function declineNip171Invitation(owner: string, groupPubkey: string): Promise<void> {
  return decide(owner, groupPubkey, 'declined');
}

/** Drop a group we left: its keys and metadata, remembering the decision. */
export function forgetNip171Group(owner: string, groupPubkey: string): Promise<void> {
  return decide(owner, groupPubkey, 'left');
}

function changeMembers(owner: string, groupPubkey: string, members: string[], add: boolean): void {
  const state = owners.get(owner)?.groups.get(groupPubkey);
  if (!state) return;
  let changed = false;
  for (const m of members) {
    if (state.members.has(m) !== add) {
      if (add) state.members.add(m);
      else state.members.delete(m);
      changed = true;
    }
  }
  if (changed) emit(owner);
}

/** Remember members we've seen post or be announced. */
export function noteNip171Members(owner: string, groupPubkey: string, members: string[]): void {
  changeMembers(owner, groupPubkey, members, true);
}

/** Members the owner announced as gone. */
export function removeNip171Members(owner: string, groupPubkey: string, members: string[]): void {
  changeMembers(owner, groupPubkey, members, false);
}

/** Store the group identity's profile / relays (fetched by the session). */
export async function setNip171GroupMeta(
  owner: string,
  groupPubkey: string,
  meta: Nip171GroupMeta,
): Promise<void> {
  const all = await nip171MetaStore.update(owner, (blob) => {
    blob[groupPubkey] = { ...blob[groupPubkey], ...meta };
  });
  const state = owners.get(owner)?.groups.get(groupPubkey);
  if (state) {
    state.meta = all[groupPubkey];
    emit(owner);
  }
}

/** Account wipe / sign-out: drop the in-memory keys and the records. */
export async function forgetNip171Account(owner: string): Promise<void> {
  owners.delete(owner);
  groupRows.delete(owner);
  loads.delete(owner);
  await Promise.all([nip171MetaStore.remove(owner), nip171StatusStore.remove(owner)]);
  emit(owner);
}

export function __resetNip171GroupsForTests(): void {
  owners.clear();
  versions.clear();
  groupRows.clear();
  loads.clear();
  listeners.clear();
}

/**
 * What to send for a text message to a NIP-171 group: a kind-14 rumor tagged
 * per the draft, gift-wrapped once to the current epoch key (no self-copy:
 * we read it from there), published to the group's relays plus `relays`.
 */
export function nip171Outgoing(
  owner: string,
  groupId: string,
  text: string,
  relays: readonly string[],
):
  | {
      rumor: { kind: 14; pubkey: string; created_at: number; tags: string[][]; content: string };
      recipientPubkeys: string[];
      relays: string[];
    }
  | { error: string } {
  const groupPubkey = groupId.startsWith('nip171:') ? groupId.slice('nip171:'.length) : null;
  const state = groupPubkey ? owners.get(owner)?.groups.get(groupPubkey) : undefined;
  if (!state) return { error: 'Not a member of this group' };
  if (state.keys.conflicted) {
    return { error: "This group's keys conflict; its owner has to fix them before you can send" };
  }
  return {
    rumor: {
      kind: 14,
      pubkey: owner,
      created_at: Math.floor(Date.now() / 1000),
      tags: groupRumorTags(state.keys, state.epochPubkey),
      content: text,
    },
    recipientPubkeys: [state.epochPubkey],
    relays: [...new Set([...(state.meta.relays ?? []), ...relays])],
  };
}

/**
 * Whether `pubkey` is a NIP-171 group identity the account knows: joined,
 * invited, declined or left. Its 1:1 rumors (our leave request's self-copy,
 * say) belong to no chat.
 */
export function isNip171GroupIdentity(owner: string, pubkey: string): boolean {
  const pk = pubkey.toLowerCase();
  const state = owners.get(owner);
  if (!state) return false;
  return (
    state.groups.has(pk) ||
    pk in state.status ||
    state.invitations.some((i) => i.groupPubkey === pk)
  );
}
