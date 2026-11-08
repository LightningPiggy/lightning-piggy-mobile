import { isTestRelayLockdown, lockRelays, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { getCurrentUserPubkey } from '../services/nostrActiveAccount';
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';
import { publishToRelays } from '../services/nostrRelayLists';
import { signEvent as signWithKey } from '../services/nostrService';
import { lookupOwnList, type OwnListSources } from '../services/relayListAuthority';
import { isRelayParked } from '../services/relayHealth';
import type { RelayConfig } from '../types/nostr';
import { relayListKey } from '../utils/relayListKey';
import {
  dmInboxRelaysFromTags,
  isPublishableRelayUrl,
  RELAY_LIST_INDEXERS,
  relayListFromTags,
  relayListPublishTargets,
  type UnsignedEvent,
} from '../utils/relayListEvents';
import {
  clearBackoff,
  isBackedOff,
  knownDmInbox,
  readDefaultDmInboxState,
  recordUnknown,
  writeDefaultDmInboxState,
} from './defaultDmInboxStore';
import { sendDefault } from './defaultDmInboxSend';
import type { SignedEvent } from './nostrContextTypes';
import type { AdoptResult } from './useNip65Relays';

export {
  readDefaultDmInboxState,
  writeDefaultDmInboxState,
  type DefaultDmInboxState,
} from './defaultDmInboxStore';

/**
 * A default NIP-17 DM inbox list (kind 10050) for accounts that have none
 * (#1628). Some apps (e.g. Amethyst) won't message a user without one.
 *
 * Whether an EXISTING account has a list can't be proven from the client —
 * it may sit on relays the app has never heard of — so the app never
 * publishes one for it unasked:
 * - **Created in the app** (`publishNewAccountDmInbox`): published at
 *   onboarding, with the new kind 0 / kind 3. The key was generated a moment
 *   ago, so no list can exist anywhere and no lookup is needed.
 * - **Every other account** (imported nsec, Amber, NIP-46): a staggered,
 *   backed-off background check (`checkDefaultDmInbox`) only RECORDS whether
 *   there's provably no list; Settings → Messages then offers it, and
 *   `publishDefaultDmInbox` runs only when the user taps Publish, re-checking
 *   everything first.
 *
 * "Provably no list" (`discoverDmInbox`): no list known to the app; a FRESH
 * 10002 lookup (never the 24 h cache) under the strict rule — every write
 * relay and indexer answered cleanly — whose write relays (if any) join the
 * known ones; then a strict 10050 lookup on those, the indexers and the
 * defaults. No 10002 at all doesn't block it: only a tap ever publishes.
 * Unreadable storage fails closed everywhere and writes no state.
 */

/** NIP-17 asks for a small list; 1–3 relays is plenty. */
export const MAX_DEFAULT_INBOX_RELAYS = 3;

const norm = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * Relays to list: ones the app already READS gift wraps from (so DMs sent
 * there arrive), public `wss://` only, not currently parked as dead — the
 * user's own NIP-65 read relays first, then the app defaults.
 */
export function chooseDefaultDmInboxRelays(input: {
  nip65: RelayConfig[];
  readRelays: string[];
  defaults: string[];
  isParked?: (url: string) => boolean;
}): string[] {
  const isParked = input.isParked ?? isRelayParked;
  const read = new Set(input.readRelays.map(norm));
  const ordered = [
    ...input.nip65.filter((r) => r.read).map((r) => r.url),
    ...input.defaults,
    ...input.readRelays,
  ].map(norm);
  return [...new Set(ordered)]
    .filter((url) => read.has(url) && isPublishableRelayUrl(url) && !isParked(url))
    .slice(0, MAX_DEFAULT_INBOX_RELAYS);
}

/** The unsigned list (lockdown: the LAN test relay only). */
function inboxEvent(pk: string, relays: string[], now: number): UnsignedEvent {
  const listed = isTestRelayLockdown(pk) ? [TEST_RELAY_URL] : relays;
  return {
    kind: 10050,
    created_at: Math.floor(now / 1000),
    tags: listed.map((url) => ['relay', url]),
    content: '',
  };
}

/** Senders look the list up on the user's write relays and the indexers. */
const publishTargets = (
  pk: string,
  writeRelays: string[],
  defaults: string[],
  listed: string[],
) => [...new Set(lockRelays(relayListPublishTargets([...writeRelays, ...defaults], listed), pk))];

export type DefaultDmInboxOutcome =
  /** Already settled for this account: nothing checked. */
  | 'settled'
  /** Waiting out a run of inconclusive checks: nothing checked. */
  | 'backoff'
  | 'exists'
  /** Couldn't prove there's no list: try again later (backed off). */
  | 'unknown'
  /** Storage couldn't be read: nothing checked, published or recorded. */
  | 'unreadable'
  | 'no-relays'
  /** Provably none: the card in Settings → Messages may offer it. */
  | 'suggested'
  | 'not-signed'
  | 'none-accepted'
  /** Some relays took it, not yet an indexer or two: re-sent this session. */
  | 'partial'
  /** The relays changed since they were shown, and the user didn't confirm. */
  | 'cancelled'
  | 'published'
  /** The account changed mid-way: nothing more signed, published or adopted. */
  | 'inactive';

export interface DmInboxCheckParams {
  pubkey: string;
  /** The user's NIP-65 list as loaded (only as a hint: always re-discovered). */
  nip65Relays: RelayConfig[];
  /** The relays the app reads gift wraps from (`getReadRelays()`). */
  readRelays: string[];
  /** The DM inbox list the app holds RIGHT NOW (read again before signing). */
  knownInbox: () => string[];
  /** created_at of the inbox list adopted in memory, if any (0: none). */
  knownInboxCreatedAt?: () => number;
  adopt: (pk: string, list: string[], createdAt?: number, session?: number) => Promise<AdoptResult>;
  /** Adopt a NIP-65 list the check found (`applyPublishedRelayList`). */
  adoptRelayList?: (pk: string, list: RelayConfig[], createdAt?: number) => Promise<AdoptResult>;
  /** Adoption token taken at the start: any reset / adoption since refuses ours. */
  session?: number;
  /** Still the active, signed-in account? Checked after every await. */
  isActive: () => boolean;
  now?: () => number;
  lookup?: typeof lookupOwnList;
}

type Discovery =
  | { status: 'absent'; nip65: RelayConfig[]; writeRelays: string[] }
  | { status: 'exists' | 'unknown' | 'unreadable' | 'inactive' };

/** Prove there's no DM inbox list anywhere (or find / adopt the one there is). */
async function discoverDmInbox(p: DmInboxCheckParams): Promise<Discovery> {
  const { pubkey: pk } = p;
  const lookup = p.lookup ?? lookupOwnList;
  const known = await knownDmInbox(pk, p.knownInbox(), p.knownInboxCreatedAt?.() ?? 0);
  if (known === 'unreadable') return { status: 'unreadable' };
  if (known === 'known') {
    await writeDefaultDmInboxState(pk, 'exists');
    return { status: 'exists' };
  }
  if (!p.isActive()) return { status: 'inactive' };
  const locked = isTestRelayLockdown(pk);
  const indexers = enabledAppRelays('indexers', RELAY_LIST_INDEXERS);
  const defaults = enabledAppRelays('default', DEFAULT_RELAYS);
  // With the indexers turned off, absence can never be proven: don't ask.
  if (indexers.length === 0 && !locked) {
    if (__DEV__) console.log('[Nostr] default DM inbox: indexers disabled, not checking');
    return { status: 'unknown' };
  }
  const anywhere: OwnListSources = { required: [], indexers, bestEffort: defaults };
  const cachedWrite = p.nip65Relays.filter((r) => r.write).map((r) => r.url);
  // Always a FRESH 10002 lookup — the cached list may be a day old — that
  // its cached write relays must answer too.
  const relayList = await lookup(pk, 10002, { ...anywhere, required: cachedWrite });
  if (!p.isActive()) return { status: 'inactive' };
  if (relayList.status === 'unknown') return { status: 'unknown' };
  let nip65: RelayConfig[] = [];
  if (relayList.status === 'found') {
    nip65 = relayListFromTags(relayList.event.tags);
    const adopted = await p.adoptRelayList?.(pk, nip65, relayList.event.created_at);
    if (!p.isActive()) return { status: 'inactive' };
    // Refused (a newer list was adopted meanwhile): its write relays weren't
    // asked, so this check proves nothing.
    if (adopted && !adopted.adopted) return { status: 'unknown' };
  }
  // No 10002 anywhere is fine here: Lightning Piggy itself never published
  // one, so most existing users look like that. Nothing is published unless
  // the user taps Publish, and the strict 10050 check below (indexers,
  // defaults, and any write relays the app knows) must still pass.
  const writeRelays = [
    ...new Set([...nip65.filter((r) => r.write).map((r) => r.url), ...cachedWrite]),
  ];
  const found = await lookup(pk, 10050, { ...anywhere, required: writeRelays });
  if (!p.isActive()) return { status: 'inactive' };
  if (found.status === 'found') {
    // Read it from now on (adoption refuses a copy older than one held).
    await p.adopt(pk, dmInboxRelaysFromTags(found.event.tags), found.event.created_at, p.session);
    await writeDefaultDmInboxState(pk, 'exists');
    return { status: 'exists' };
  }
  return found.status === 'absent'
    ? { status: 'absent', nip65, writeRelays }
    : { status: 'unknown' };
}

/** The relays a default would list for this account (lockdown: the LAN test relay). */
export const suggestedDmInboxRelays = (pk: string, nip65: RelayConfig[], readRelays: string[]) =>
  isTestRelayLockdown(pk)
    ? [TEST_RELAY_URL]
    : chooseDefaultDmInboxRelays({
        nip65,
        readRelays,
        defaults: enabledAppRelays('default', DEFAULT_RELAYS),
      });
const relaysFor = (p: DmInboxCheckParams, nip65: RelayConfig[]) =>
  suggestedDmInboxRelays(p.pubkey, nip65, p.readRelays);

/**
 * Background (staggered, once per account, backed off): record whether the
 * account provably has no DM inbox list, so Settings → Messages can offer
 * one. NEVER signs or publishes.
 */
export async function checkDefaultDmInbox(p: DmInboxCheckParams): Promise<DefaultDmInboxOutcome> {
  const { pubkey: pk } = p;
  const now = (p.now ?? Date.now)();
  const state = await readDefaultDmInboxState(pk);
  if (state === 'unreadable') return 'unreadable';
  if (state) return 'settled';
  const backedOff = await isBackedOff(pk, now);
  if (backedOff === 'unreadable') return 'unreadable';
  if (backedOff) return 'backoff';
  const found = await discoverDmInbox(p);
  let outcome: DefaultDmInboxOutcome;
  if (found.status !== 'absent') outcome = found.status;
  else if (relaysFor(p, found.nip65).length === 0) outcome = 'unknown';
  else {
    await writeDefaultDmInboxState(pk, 'suggest');
    outcome = 'suggested';
  }
  // Inconclusive checks back off; anything decisive resets the count.
  if (outcome === 'unknown') await recordUnknown(pk, now);
  else if (outcome === 'exists' || outcome === 'suggested') await clearBackoff(pk);
  return outcome;
}

export interface PublishDefaultParams extends DmInboxCheckParams {
  sign: (event: UnsignedEvent) => Promise<SignedEvent | null>;
  /** The relays the user was shown. If the fresh check picks different ones,
   * `confirm` must approve the new list before anything is signed. */
  shownRelays?: string[];
  confirm?: (relays: string[]) => Promise<boolean>;
  publish?: typeof publishToRelays;
  retryDelaysMs?: number[];
}

/**
 * The user tapped Publish (any signer). Re-runs the whole check first — a
 * list found now is adopted and shown instead — then signs and publishes.
 */
export async function publishDefaultDmInbox(
  p: PublishDefaultParams,
): Promise<DefaultDmInboxOutcome> {
  const { pubkey: pk } = p;
  const found = await discoverDmInbox(p);
  if (found.status !== 'absent') return found.status;
  const relays = relaysFor(p, found.nip65);
  if (relays.length === 0) return 'no-relays';
  // Never publish a list other than the one the user saw without asking.
  if (p.shownRelays && relayListKey(p.shownRelays) !== relayListKey(relays)) {
    if (!(await p.confirm?.(relays))) return 'cancelled';
    if (!p.isActive()) return 'inactive';
  }
  // A list adopted meanwhile (hydration, the editor) wins: the default is
  // only for an account with none, and is never dated past one. Checked
  // again after signing (a remote signer can take a while).
  const stillNone = async (): Promise<DefaultDmInboxOutcome | null> => {
    const known = await knownDmInbox(pk, p.knownInbox(), p.knownInboxCreatedAt?.() ?? 0);
    if (known === 'none') return null;
    if (known === 'known') await writeDefaultDmInboxState(pk, 'exists');
    return known === 'known' ? 'exists' : 'unreadable';
  };
  const beforeSigning = await stillNone();
  if (beforeSigning) return beforeSigning;
  if (!p.isActive()) return 'inactive';
  const signed = await p.sign(inboxEvent(pk, relays, (p.now ?? Date.now)()));
  if (!p.isActive()) return 'inactive';
  if (!signed) return 'not-signed';
  if (signed.pubkey !== pk) return 'inactive';
  const afterSigning = await stillNone();
  if (afterSigning) return afterSigning;
  if (!p.isActive()) return 'inactive';
  const listed = dmInboxRelaysFromTags(signed.tags);
  const defaults = enabledAppRelays('default', DEFAULT_RELAYS);
  const { accepted, done } = await sendDefault({
    pk,
    event: signed,
    targets: publishTargets(pk, found.writeRelays, defaults, listed),
    isActive: p.isActive,
    publish: p.publish,
    retryDelaysMs: p.retryDelaysMs,
    // Live somewhere: the app must READ the relays it advertised — but never
    // into another account's state.
    onLive: async () => {
      await writeDefaultDmInboxState(pk, 'published');
      if (p.isActive()) await p.adopt(pk, listed, signed.created_at, p.session);
    },
  });
  if (!p.isActive()) return 'inactive';
  if (accepted.length === 0) return 'none-accepted';
  return done ? 'published' : 'partial';
}

/**
 * Onboarding, for a key generated in the app a moment ago: no list can exist
 * anywhere, so publish the default straight away with the new kind 0 / 3 —
 * no lookup. Re-sent this session until an indexer or two relays have it.
 */
export async function publishNewAccountDmInbox(o: {
  pubkey: string;
  secretKey: Uint8Array;
  adopt: (pk: string, list: string[], createdAt?: number) => Promise<AdoptResult>;
  now?: () => number;
  publish?: typeof publishToRelays;
  retryDelaysMs?: number[];
}): Promise<DefaultDmInboxOutcome> {
  const { pubkey: pk } = o;
  const defaults = enabledAppRelays('default', DEFAULT_RELAYS, pk);
  // A new account reads gift wraps from the app defaults.
  const relays = isTestRelayLockdown(pk)
    ? [TEST_RELAY_URL]
    : chooseDefaultDmInboxRelays({ nip65: [], readRelays: defaults, defaults });
  if (relays.length === 0) return 'no-relays';
  const signed = signWithKey(inboxEvent(pk, relays, (o.now ?? Date.now)()), o.secretKey);
  if (signed.pubkey !== pk) return 'not-signed';
  const listed = dmInboxRelaysFromTags(signed.tags);
  const isActive = () => getCurrentUserPubkey() === pk;
  const { accepted, done } = await sendDefault({
    pk,
    event: signed,
    targets: publishTargets(pk, [], defaults, listed),
    isActive,
    retryWhenNone: true,
    publish: o.publish,
    retryDelaysMs: o.retryDelaysMs,
    onLive: async () => {
      await writeDefaultDmInboxState(pk, 'published');
      if (isActive()) await o.adopt(pk, listed, signed.created_at);
    },
  });
  if (accepted.length === 0) return 'none-accepted';
  return done ? 'published' : 'partial';
}
