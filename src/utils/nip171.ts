/**
 * NIP-171 epoch-ticketed private groups, member side (draft:
 * https://github.com/nostr-protocol/nips/pull/2428; Anagram, https://anagram.chat,
 * is the reference client). Pure rules: ticket validation and selection,
 * outgoing rumor tags, incoming rumor validation, announcements.
 *
 * A group is a keypair (its "identity"). Its owner gives each member a
 * `kind:1014` ticket, signed by the group key and gift-wrapped to them, that
 * carries the current epoch number and the shared epoch private key. Members
 * send NIP-17 messages gift-wrapped to the epoch public key, and prove
 * membership by attaching their ticket's `created_at` and signature.
 */

export const NIP171_TICKET_KIND = 1014;
/** App group id prefix: `nip171:<group identity pubkey>`. */
export const NIP171_GROUP_ID_PREFIX = 'nip171:';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_EPOCH = 2 ** 53 - 1;

export function nip171GroupId(groupPubkey: string): string {
  return `${NIP171_GROUP_ID_PREFIX}${groupPubkey.toLowerCase()}`;
}

export function isNip171GroupId(id: string): boolean {
  return id.startsWith(NIP171_GROUP_ID_PREFIX);
}

/** The group identity pubkey of a `nip171:` group id, or null. */
export function nip171GroupPubkey(id: string): string | null {
  if (!isNip171GroupId(id)) return null;
  const pk = id.slice(NIP171_GROUP_ID_PREFIX.length);
  return HEX64.test(pk) ? pk : null;
}

export interface Nip171Event {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
  /** Where Anagram sends a ticket's signature: a tag on the NIP-59 seal. */
  sealInvitationProof?: string;
}

/** Verifies a signed event (id + schnorr signature). Injected for tests. */
export type VerifyEvent = (event: Required<Omit<Nip171Event, 'sealInvitationProof'>>) => boolean;

/** A validated epoch ticket addressed to us. */
export interface Nip171Ticket {
  id: string;
  groupPubkey: string;
  memberPubkey: string;
  epoch: number;
  /** Epoch private key, 32-byte lowercase hex. Secret. */
  epochSecretHex: string;
  createdAt: number;
  sig: string;
}

const tagsNamed = (tags: string[][], name: string) => tags.filter((t) => t[0] === name);

function parseEpoch(value: string | undefined): number | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= MAX_EPOCH ? n : null;
}

/**
 * A `kind:1014` ticket addressed to `memberPubkey`, signed by the group key,
 * or null when it breaks any of the spec's MUSTs (tags exactly `p` naming us
 * then a decimal `epoch`, a 32-byte lowercase-hex key distinct from the group
 * and member keys, a valid signature). The rumor travels unsigned; the
 * signature comes from `sig` or, as Anagram sends it, the seal's
 * `invitation_proof` tag.
 */
export function parseTicket(
  event: Nip171Event,
  memberPubkey: string,
  verify: VerifyEvent,
  getEventHash: (event: Omit<Nip171Event, 'id' | 'sig'>) => string,
  getPublicKey: (secretHex: string) => string,
): Nip171Ticket | null {
  if (event.kind !== NIP171_TICKET_KIND) return null;
  if (!HEX64.test(event.pubkey)) return null;
  const sig = event.sig ?? event.sealInvitationProof;
  if (typeof sig !== 'string' || !HEX128.test(sig)) return null;
  const me = memberPubkey.toLowerCase();
  const epochTags = tagsNamed(event.tags, 'epoch');
  if (epochTags.length !== 1) return null;
  const epoch = parseEpoch(epochTags[0][1]);
  if (epoch === null) return null;
  // Exactly these tags, in this order: members rebuild the ticket from them
  // to prove membership, so any other shape could never be proven.
  if (
    event.tags.length !== 2 ||
    event.tags[0].length !== 2 ||
    event.tags[0][0] !== 'p' ||
    event.tags[0][1] !== me ||
    event.tags[1].length !== 2 ||
    event.tags[1][0] !== 'epoch'
  ) {
    return null;
  }
  if (!HEX64.test(event.content)) return null;
  let epochPubkey: string;
  try {
    epochPubkey = getPublicKey(event.content);
  } catch {
    return null;
  }
  if (epochPubkey === event.pubkey || epochPubkey === me) return null;
  // Verify a fresh copy of the signed fields (verifiers memoise a result on
  // the event object), with the id recomputed rather than trusted.
  const unsigned = {
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((t) => [...t]),
    content: event.content,
  };
  const id = getEventHash(unsigned);
  if (!verify({ ...unsigned, id, sig })) return null;
  return {
    id,
    groupPubkey: event.pubkey,
    memberPubkey: me,
    epoch,
    epochSecretHex: event.content,
    createdAt: event.created_at,
    sig,
  };
}

/** The usable state of one group, from all of our valid tickets for it. */
export interface Nip171GroupKeys {
  groupPubkey: string;
  /** Highest epoch we hold a ticket for. */
  epoch: number;
  /** The ticket we send with (highest epoch; newest; lowest id). */
  current: Nip171Ticket;
  /** Two tickets for `epoch` carry different keys: reading only, no sending. */
  conflicted: boolean;
  /** Every epoch key we hold, for reading history: epoch → secret hex (the
   * current ticket's key for a conflicted epoch). */
  epochSecrets: Map<number, string>;
}

/**
 * Select the current ticket per the spec: the highest epoch; among equal
 * epochs and keys, the greatest `created_at`, then the lowest event id. Two
 * different keys for the same epoch make that epoch inconsistent.
 */
export function groupKeysFromTickets(tickets: readonly Nip171Ticket[]): Nip171GroupKeys | null {
  if (tickets.length === 0) return null;
  const groupPubkey = tickets[0].groupPubkey;
  const mine = tickets.filter((t) => t.groupPubkey === groupPubkey);
  const epoch = Math.max(...mine.map((t) => t.epoch));
  const top = mine
    .filter((t) => t.epoch === epoch)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const current = top[0];
  const conflicted = top.some((t) => t.epochSecretHex !== current.epochSecretHex);
  const epochSecrets = new Map<number, string>();
  for (const t of [...mine].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!epochSecrets.has(t.epoch)) epochSecrets.set(t.epoch, t.epochSecretHex);
  }
  epochSecrets.set(epoch, current.epochSecretHex);
  return { groupPubkey, epoch, current, conflicted, epochSecrets };
}

/** Tags for a rumor we send to the group (kind 14 / 15 / 7 by convention). */
export function groupRumorTags(keys: Nip171GroupKeys, epochPubkey: string): string[][] {
  return [
    ['p', epochPubkey],
    ['h', keys.groupPubkey],
    ['epoch', String(keys.current.epoch)],
    ['invited_at', String(keys.current.createdAt)],
    ['invitation_proof', keys.current.sig],
  ];
}

export interface Nip171Rumor {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  /** Group rumors must be unsigned: a signed one could be republished. */
  sig?: string;
}

export type Nip171Incoming =
  | { type: 'message'; sender: string }
  | { type: 'announcement'; change: 'joined' | 'left'; members: string[] }
  | { type: 'invalid'; reason: string };

const exactlyOne = (tags: string[][], name: string): string | null => {
  const found = tagsNamed(tags, name);
  return found.length === 1 && typeof found[0][1] === 'string' ? found[0][1] : null;
};

/**
 * Validate a rumor unwrapped with an epoch key (after NIP-17 sender binding,
 * which the unwrap already enforces). A member message must carry exactly one
 * `p` (the epoch pubkey), `h` (the group), `epoch` (that epoch), `invited_at`
 * and `invitation_proof`; rebuilding the sender's ticket from those and the
 * locally known epoch key must verify against the group key. A message from
 * the group key itself is only valid as a `+` / `-` announcement.
 */
export function classifyGroupRumor(
  rumor: Nip171Rumor,
  context: {
    groupPubkey: string;
    epoch: number;
    epochPubkey: string;
    epochSecretHex: string;
    /** Every epoch pubkey we know for the group: never a valid author. */
    knownEpochPubkeys: ReadonlySet<string>;
  },
  verify: VerifyEvent,
  getEventHash: (event: Omit<Nip171Event, 'id' | 'sig'>) => string,
): Nip171Incoming {
  const sender = rumor.pubkey.toLowerCase();
  if (!HEX64.test(sender)) return { type: 'invalid', reason: 'sender' };
  if (rumor.sig) return { type: 'invalid', reason: 'signed' };
  if (context.knownEpochPubkeys.has(sender)) return { type: 'invalid', reason: 'epoch-author' };
  const p = exactlyOne(rumor.tags, 'p');
  const h = exactlyOne(rumor.tags, 'h');
  const epochTag = exactlyOne(rumor.tags, 'epoch');
  if (p !== context.epochPubkey) return { type: 'invalid', reason: 'p' };
  if (h !== context.groupPubkey) return { type: 'invalid', reason: 'h' };
  if (parseEpoch(epochTag ?? undefined) !== context.epoch)
    return { type: 'invalid', reason: 'epoch' };

  if (sender === context.groupPubkey) {
    if (rumor.kind !== 14 || (rumor.content !== '+' && rumor.content !== '-')) {
      return { type: 'invalid', reason: 'group-message' };
    }
    // The group key holds no ticket, so an announcement carries no proof.
    if (rumor.tags.some((t) => t[0] === 'invited_at' || t[0] === 'invitation_proof')) {
      return { type: 'invalid', reason: 'announcement' };
    }
    const members = tagsNamed(rumor.tags, 'member')
      .map((t) => t[1]?.toLowerCase())
      .filter((m): m is string => !!m && HEX64.test(m));
    if (members.length === 0) return { type: 'invalid', reason: 'announcement' };
    return { type: 'announcement', change: rumor.content === '+' ? 'joined' : 'left', members };
  }

  const invitedAtTag = exactlyOne(rumor.tags, 'invited_at');
  const proof = exactlyOne(rumor.tags, 'invitation_proof');
  const invitedAt =
    invitedAtTag !== null && DECIMAL.test(invitedAtTag) ? Number(invitedAtTag) : NaN;
  if (!Number.isSafeInteger(invitedAt) || proof === null || !HEX128.test(proof)) {
    return { type: 'invalid', reason: 'proof-tags' };
  }
  const ticket = {
    pubkey: context.groupPubkey,
    created_at: invitedAt,
    kind: NIP171_TICKET_KIND,
    tags: [
      ['p', sender],
      ['epoch', String(context.epoch)],
    ],
    content: context.epochSecretHex,
  };
  const rebuilt = { ...ticket, id: getEventHash(ticket), sig: proof };
  if (!verify(rebuilt)) return { type: 'invalid', reason: 'proof' };
  return { type: 'message', sender };
}

/**
 * A rumor that belongs to a NIP-171 group conversation (it carries the group
 * `h` and an `invitation_proof`), wherever it arrived. Our own inbox should
 * never file one as a 1:1 DM: the group's epoch subscription delivers it.
 */
export function isNip171GroupRumor(rumor: { tags?: string[][] }): boolean {
  const tags = Array.isArray(rumor.tags) ? rumor.tags : [];
  return tags.some((t) => t[0] === 'h') && tags.some((t) => t[0] === 'invitation_proof');
}
