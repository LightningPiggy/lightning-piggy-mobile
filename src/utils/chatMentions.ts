// Chat @mentions (#1295): pure helpers for the composer's member picker, the
// send-time encoding to NIP-27 references, and splitting an incoming message
// into text and `@Name` mention segments. No React, no I/O.
//
// Wire format: a mention is a NIP-21 `nostr:npub1…` URI in the message text
// (NIP-27), which every Nostr client shows at least as a link. The composer
// shows the friendlier `@Name` while typing and swaps it for the URI on send.
// The profile-reference pattern matches PR #1334's NIP-27 tokenizer
// (`utils/nip27.ts`), restricted to profiles. Two forms are read: the NIP-27
// `nostr:npub…` URI, and `@npub…`, which is what White Noise writes for a
// mention (alongside a `p` tag). A bare `npub1…` pasted into chat stays text.
import * as nip19 from 'nostr-tools/nip19';
import { decodeNostrEntity } from './nip27';

// bech32 data charset (BIP-173): no 1, b, i, o. The lookahead stops a body at
// a following `nostr:` so two references written back-to-back still split.
const BECH32 = '[02-9ac-hj-np-z]';
const PROFILE_URI_SOURCE = `(?:nostr:|(?<![\\w@])@)(?:npub|nprofile)1(?:(?!nostr:)${BECH32}){6,}`;
const HAS_PROFILE_URI = /(?:nostr:|@)(?:npub|nprofile)1/i;

/** The hex pubkey a `nostr:npub…` / `nostr:nprofile…` URI (or White Noise's
 * `@npub…`) points at, or null for anything malformed (bad checksum, mixed
 * case, other entity types). Decoding is #1334's NIP-27 `decodeNostrEntity`. */
export function decodeProfileUri(raw: string): string | null {
  const token = decodeNostrEntity(raw.replace(/^@/, ''));
  return token?.type === 'profile' ? token.pubkey : null;
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; pubkey: string; raw: string };

/** Split message text into plain-text and mention segments, in order. A
 * reference that doesn't decode stays text. */
export function splitMentions(text: string): MentionSegment[] {
  if (!text || !HAS_PROFILE_URI.test(text)) return [{ kind: 'text', text }];
  const out: MentionSegment[] = [];
  const re = new RegExp(PROFILE_URI_SOURCE, 'gi');
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const pubkey = decodeProfileUri(match[0]);
    if (!pubkey) continue;
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    out.push({ kind: 'mention', pubkey, raw: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out.length > 0 ? out : [{ kind: 'text', text }];
}

/** Every distinct pubkey the text mentions, in first-seen order. */
export function mentionedPubkeys(text: string): string[] {
  const seen = new Set<string>();
  for (const seg of splitMentions(text)) {
    if (seg.kind === 'mention') seen.add(seg.pubkey);
  }
  return [...seen];
}

/** Whether a stored group / DM message mentions `pubkey` — a `nostr:` profile
 * reference in its text, or (Marmot) a `p` tag recorded in `mentions`. */
export function messageMentions(
  message: { text: string; mentions?: string[] },
  pubkey: string | null | undefined,
): boolean {
  if (!pubkey) return false;
  const me = pubkey.toLowerCase();
  if (message.mentions?.some((pk) => pk.toLowerCase() === me)) return true;
  // Cheap prefilter before the bech32 decode: almost no message has one.
  if (!HAS_PROFILE_URI.test(message.text)) return false;
  return mentionedPubkeys(message.text).includes(me);
}

/**
 * One-line preview text (Messages list row) with each mention shown as
 * `@Name` instead of the raw `nostr:npub…` URI. `nameOf` returns null for an
 * unknown pubkey; `fallback` labels those (a short npub).
 */
export function previewMentions(
  text: string,
  nameOf: (pubkey: string) => string | null | undefined,
  fallback: (pubkey: string) => string,
): string {
  const segs = splitMentions(text);
  if (segs.length === 1 && segs[0].kind === 'text') return text;
  return segs
    .map((seg) =>
      seg.kind === 'text' ? seg.text : `@${nameOf(seg.pubkey)?.trim() || fallback(seg.pubkey)}`,
    )
    .join('');
}

/**
 * People a Messages-list group row may need a name for: each row's last
 * sender and everyone mentioned in its last message (deduped, lowercase).
 * Without these, a mention of someone the viewer doesn't follow previews as a
 * bare key.
 */
export function groupPreviewPubkeys(
  rows: readonly { activity: { lastSenderPubkey?: string | null; lastText?: string | null } }[],
): string[] {
  const out = new Set<string>();
  for (const { activity } of rows) {
    if (activity.lastSenderPubkey) out.add(activity.lastSenderPubkey.toLowerCase());
    for (const pk of mentionedPubkeys(activity.lastText ?? '')) out.add(pk.toLowerCase());
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Composer side
// ---------------------------------------------------------------------------

/** The `@query` being typed at the cursor. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Index just past the query (the cursor). */
  end: number;
  /** What follows the `@`, up to the cursor. */
  query: string;
}

/** Longest `@query` we keep matching (bounds the work; names are short). */
const MAX_QUERY_LENGTH = 32;

/**
 * The `@query` under the cursor, or null. The `@` must start the text or
 * follow whitespace (so an email address doesn't open the picker), and the
 * query can't cross a line break. Inner spaces are allowed so a display name
 * like "Big Piggy" can be typed in full; the picker simply hides once nothing
 * matches.
 */
export function findMentionQuery(text: string, cursor: number): MentionQuery | null {
  const end = Math.min(Math.max(cursor, 0), text.length);
  const floor = Math.max(0, end - MAX_QUERY_LENGTH - 1);
  for (let i = end - 1; i >= floor; i--) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '@') {
      if (i > 0 && !/\s/.test(text[i - 1])) return null;
      const query = text.slice(i + 1, end);
      // "@ " is just an at sign, not the start of a name; a trailing space
      // ends the query (so a just-picked "@Alice " doesn't reopen the picker).
      if (/^\s|\s$/.test(query)) return null;
      return { start: i, end, query };
    }
  }
  return null;
}

export interface MentionCandidate {
  pubkey: string;
  name: string;
  picture?: string | null;
}

/**
 * Members matching `query` (case-insensitive): name prefix first, then a
 * word-start match ("pig" → "Big Piggy"), then any substring. The viewer is
 * left out — you don't mention yourself.
 */
export function filterMentionCandidates<T extends MentionCandidate>(
  members: readonly T[],
  query: string,
  selfPubkey: string | null | undefined,
  limit = 6,
): T[] {
  const q = query.trim().toLowerCase();
  const me = selfPubkey?.toLowerCase();
  const ranked: { member: T; rank: number }[] = [];
  for (const member of members) {
    if (me && member.pubkey.toLowerCase() === me) continue;
    const name = member.name.toLowerCase();
    let rank: number;
    if (!q || name.startsWith(q)) rank = 0;
    else if (name.split(/\s+/).some((word) => word.startsWith(q))) rank = 1;
    else if (name.includes(q)) rank = 2;
    else continue;
    ranked.push({ member, rank });
  }
  // Stable: equal ranks keep the roster order.
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, limit).map((r) => r.member);
}

/** A member picked from the picker: what the composer shows, and who it is. */
export interface MentionPick {
  label: string;
  pubkey: string;
}

/** Replace the `@query` with `@Label ` and return the new text + cursor. */
export function applyMentionPick(
  text: string,
  query: MentionQuery,
  label: string,
): { text: string; cursor: number } {
  const inserted = `@${label} `;
  const after = text.slice(query.end).replace(/^ /, '');
  return {
    text: text.slice(0, query.start) + inserted + after,
    cursor: query.start + inserted.length,
  };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Swap every picked `@Label` in the outgoing text for the member's
 * `nostr:npub…` reference. Longest labels go first so "@Al" can't eat the
 * start of "@Alice"; a label the user has since edited no longer matches and
 * goes out as typed.
 */
export function encodeMentions(text: string, picks: readonly MentionPick[]): string {
  if (picks.length === 0 || !text.includes('@')) return text;
  const unique = new Map<string, string>();
  for (const p of picks) if (p.label && !unique.has(p.label)) unique.set(p.label, p.pubkey);
  const ordered = [...unique.entries()].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [label, pubkey] of ordered) {
    let npub: string;
    try {
      npub = nip19.npubEncode(pubkey);
    } catch {
      continue;
    }
    const re = new RegExp(`(^|\\s)@${escapeRegExp(label)}(?=$|[\\s.,!?;:)\\]}'"’”])`, 'g');
    out = out.replace(re, (_m, lead: string) => `${lead}nostr:${npub}`);
  }
  return out;
}
