import { hexToBytes } from '@noble/hashes/utils.js';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { notifyGroupMessage } from '../contexts/nostrEventBus';
import { appendGroupMessage, listPersistedGroupWrapIds } from './groupMessagesStorageService';
import { nostrGetEventHash, nostrVerifyEvent } from './nostrCrypto';
import { pool, trackRelays, type RawGiftWrapEvent } from './nostrService';
import { querySyncAbortable } from './relayQuery';
import { verifyEventCached } from './nostrVerifyCache';
import {
  nip171GroupStates,
  noteNip171Members,
  removeNip171Members,
  setNip171GroupMeta,
  subscribeNip171Groups,
  type Nip171GroupState,
} from './nip171Groups';
import { unwrapWrapNsec } from '../utils/nip17Unwrap';
import { classifyGroupRumor, nip171GroupId, type Nip171Event } from '../utils/nip171';

// Live delivery for NIP-171 groups: one bounded subscription for the gift
// wraps addressed to each group's current epoch key, decrypted with that key
// (so it works whatever signer the account uses), validated per the draft,
// and appended to the shared group message log.

/** Recent wraps per epoch key on (re)subscribe. NIP-59 randomises
 * `created_at`, so no `since`: bounded by `limit` instead. */
export const NIP171_WRAP_LIMIT = 128;
/** Wraps remembered as handled this session, and waiting to be handled. The
 * epoch key is public (it's in every `#p`), so anyone can send to it. */
const SEEN_CAP = 4000;
const QUEUE_CAP = 1000;
/** How far ahead of now a timestamp may be (clock skew). */
const FUTURE_SKEW_SECS = 10 * 60;
const MAX_NAME_LENGTH = 64;
/** Groups and epochs change in bursts (profiles arrive one by one at start). */
const RESUBSCRIBE_DEBOUNCE_MS = 500;

// Verify a fresh copy: a memoised result can't vouch for a rebuilt ticket.
const verify = (event: Required<Omit<Nip171Event, 'sealInvitationProof'>>) =>
  nostrVerifyEvent({ ...event } as Parameters<typeof nostrVerifyEvent>[0]);
const hash = (event: Omit<Nip171Event, 'id' | 'sig'>) =>
  nostrGetEventHash(event as Parameters<typeof nostrGetEventHash>[0]);

/** Validate and store one wrap for `state`. Exported for tests. */
export async function ingestNip171Wrap(
  owner: string,
  state: Nip171GroupState,
  wrap: RawGiftWrapEvent,
): Promise<'stored' | 'announcement' | 'invalid'> {
  const rumor = unwrapWrapNsec(wrap, hexToBytes(state.keys.current.epochSecretHex));
  if (!rumor) return 'invalid';
  const verdict = classifyGroupRumor(
    rumor,
    {
      groupPubkey: state.keys.groupPubkey,
      epoch: state.keys.epoch,
      epochPubkey: state.epochPubkey,
      epochSecretHex: state.keys.current.epochSecretHex,
      knownEpochPubkeys: state.epochPubkeys,
    },
    verify,
    hash,
  );
  if (verdict.type === 'invalid') return 'invalid';
  if (verdict.type === 'announcement') {
    // Relays don't keep order, so a late "+" can follow a "-"; the member
    // list is a best-effort view either way (the roster isn't published).
    if (verdict.change === 'left')
      removeNip171Members(owner, state.keys.groupPubkey, verdict.members);
    else noteNip171Members(owner, state.keys.groupPubkey, verdict.members);
    return 'announcement';
  }
  // Text messages for now; files (kind 15) and reactions (kind 7) follow.
  if (rumor.kind !== 14) return 'invalid';
  noteNip171Members(owner, state.keys.groupPubkey, [verdict.sender]);
  const groupId = nip171GroupId(state.keys.groupPubkey);
  await appendGroupMessage(owner, groupId, {
    id: wrap.id,
    senderPubkey: verdict.sender,
    text: rumor.content,
    // A member can't pin a message above everything else with a future time.
    createdAt: Math.min(rumor.created_at, Math.floor(Date.now() / 1000) + FUTURE_SKEW_SECS),
    wireKind: 14,
  });
  notifyGroupMessage(groupId);
  return 'stored';
}

// The group identity's profile (name / picture) and kind-10050 relays.
async function refreshGroupMeta(owner: string, groupPubkey: string, relays: string[]) {
  try {
    const events = await querySyncAbortable(
      pool,
      relays,
      { kinds: [0, 10050], authors: [groupPubkey], limit: 4 },
      { maxWait: 5000 },
    );
    // Relays don't verify signatures for us (kind 0 skips it in the pool), so
    // a relay could otherwise forge the group's name or relay list.
    const newest = (kind: number) =>
      events
        .filter((e) => e.kind === kind && e.pubkey === groupPubkey && verifyEventCached(e))
        .sort((a, b) => b.created_at - a.created_at)[0];
    const profile = newest(0);
    const inbox = newest(10050);
    let name: string | undefined;
    let picture: string | undefined;
    if (profile) {
      try {
        const parsed = JSON.parse(profile.content) as Record<string, unknown>;
        const pick = (k: string) => (typeof parsed[k] === 'string' ? (parsed[k] as string) : '');
        name = (pick('display_name') || pick('name')).trim().slice(0, MAX_NAME_LENGTH) || undefined;
        const pic = pick('picture').trim();
        picture = /^https:\/\/\S+$/.test(pic) ? pic : undefined;
      } catch {
        // A malformed profile leaves the name unset.
      }
    }
    const groupRelays = inbox?.tags
      // TLS only: these come from a key anyone can create.
      .filter((t) => t[0] === 'relay' && typeof t[1] === 'string' && /^wss:\/\/[^\s]+$/.test(t[1]))
      .map((t) => t[1])
      .slice(0, 8);
    await setNip171GroupMeta(owner, groupPubkey, {
      ...(name ? { name } : {}),
      ...(picture ? { picture } : {}),
      ...(groupRelays?.length ? { relays: groupRelays } : {}),
    });
  } catch {
    // Retried on the next session start.
  }
}

/**
 * Receive the account's NIP-171 group messages until stopped. Re-subscribes
 * when the groups or their epochs change (a new ticket). The account's own
 * read relays get every group's epoch key; a group's advertised relays get
 * only that group's, so one group's relays can't learn the others.
 */
export function startNip171Session(owner: string, readRelays: string[]): () => void {
  let stopped = false;
  let close: (() => void) | null = null;
  // Insertion-ordered, trimmed oldest-first at SEEN_CAP.
  const seen = new Set<string>();
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
  };
  const queue: RawGiftWrapEvent[] = [];
  let draining = false;
  const metaFetched = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const drain = async () => {
    if (draining) return;
    draining = true;
    const scheduler = createYieldScheduler({ safetyEvery: 8 });
    try {
      while (queue.length && !stopped) {
        await scheduler.maybeYield();
        const wrap = queue.shift()!;
        const target = wrap.tags.find((t) => t[0] === 'p')?.[1];
        const state = [...nip171GroupStates(owner).values()].find((s) => s.epochPubkey === target);
        if (!state) continue;
        try {
          await ingestNip171Wrap(owner, state, wrap);
        } catch (e) {
          if (__DEV__) console.warn('[NIP-171] wrap ingest failed:', e);
        }
      }
    } finally {
      scheduler.dispose();
      draining = false;
    }
  };

  const subscribe = () => {
    close?.();
    close = null;
    if (stopped) return;
    const groups = [...nip171GroupStates(owner).values()];
    if (groups.length === 0) return;
    // relay → epoch keys it may be asked for.
    const byRelay = new Map<string, Set<string>>();
    const ask = (url: string, keys: string[]) => {
      const set = byRelay.get(url) ?? new Set<string>();
      for (const k of keys) set.add(k);
      byRelay.set(url, set);
    };
    for (const url of readRelays)
      ask(
        url,
        groups.map((g) => g.epochPubkey),
      );
    for (const g of groups) for (const url of g.meta.relays ?? []) ask(url, [g.epochPubkey]);
    if (byRelay.size === 0) return;
    trackRelays([...byRelay.keys()]);
    for (const g of groups) {
      if (metaFetched.has(g.keys.groupPubkey)) continue;
      metaFetched.add(g.keys.groupPubkey);
      // Only that group's relays besides our own: no cross-group lookups.
      void refreshGroupMeta(owner, g.keys.groupPubkey, [
        ...new Set([...readRelays, ...(g.meta.relays ?? [])]),
      ]);
    }
    if (__DEV__) {
      console.log(`[NIP-171] session: ${groups.length} group(s) on ${byRelay.size} relays`);
    }
    const sub = pool.subscribeMap(
      [...byRelay].map(([url, keys]) => ({
        url,
        filter: { kinds: [1059], '#p': [...keys], limit: NIP171_WRAP_LIMIT * keys.size },
      })),
      {
        onevent: (event: RawGiftWrapEvent) => {
          if (seen.has(event.id)) return;
          // Flood: drop it unseen, so a later subscription can deliver it again.
          if (queue.length >= QUEUE_CAP) return;
          remember(event.id);
          queue.push(event);
          void drain();
        },
      },
    );
    close = () => sub.close();
  };

  const keyOf = () =>
    [...nip171GroupStates(owner).values()]
      .map((g) => `${g.epochPubkey}:${(g.meta.relays ?? []).join(',')}`)
      .sort()
      .join('|');
  let key = keyOf();
  const unsubscribe = subscribeNip171Groups((changed) => {
    if (changed !== owner || stopped) return;
    const next = keyOf();
    if (next === key) return;
    key = next;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      subscribe();
    }, RESUBSCRIBE_DEBOUNCE_MS);
  });
  // Wraps already in the group logs need no decrypt: seed `seen` first.
  void listPersistedGroupWrapIds(owner)
    .catch(() => [] as string[])
    .then((ids) => {
      if (stopped) return;
      for (const id of ids.slice(-SEEN_CAP)) remember(id);
      subscribe();
    });

  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    close?.();
    close = null;
    queue.length = 0;
  };
}
