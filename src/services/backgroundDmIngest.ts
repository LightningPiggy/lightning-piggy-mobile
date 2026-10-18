import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTACTS_CACHE_KEY_BASE } from '../contexts/nostrCacheKeys';
import { unwrapWrapNsec, type DecodedRumor } from '../utils/nip17Unwrap';
import { resolveReadRelays } from './backgroundDmReadRelays';
import { hasRepliedTo, loadRepliedPartners } from './dmRepliedPartners';
import { loadIdentities, type StoredIdentity } from './identitiesStore';
import * as nostrService from './nostrService';
import { perAccountKey } from './perAccountStorage';
import { querySyncAbortable } from './relayQuery';

// Keeping what the app decrypts outside the inbox screen (#1325). The
// background DM watch decrypts a message to write its alert; storing it too
// means tapping the alert, or opening Messages, shows it straight away
// instead of waiting for the next inbox refresh to fetch and decrypt it again.
// Everything goes through the inbox's own ingest, so the follow gate, group
// routing and order rules are the same.

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The per-wrap decryptor for an identity, or null when its secret key isn't
 * held locally (Amber / NIP-46). Pure-JS NIP-44, safe to run headless.
 */
export function buildNsecDecryptor(
  identity: StoredIdentity,
): ((wrap: nostrService.RawGiftWrapEvent) => DecodedRumor | null) | null {
  if (identity.signerType !== 'nsec' || !identity.nsec) return null;
  let secretKey: Uint8Array;
  try {
    const decoded = nostrService.decodeNsec(identity.nsec);
    if (decoded.pubkey !== identity.pubkey.toLowerCase()) return null;
    secretKey = decoded.secretKey;
  } catch {
    return null;
  }
  // Reuse the exact same two-layer NIP-17 unwrap the foreground path uses, so
  // the sender-binding / validation rules can't drift between paths.
  return (wrap) => unwrapWrapNsec(wrap, secretKey);
}

/**
 * The viewer's followed pubkeys from the per-account contacts cache, for the
 * background follow gate (strangers must not be able to spam OS notifications
 * by gift-wrapping to a pubkey). `null` means the cache has never been written
 * (fresh install / pre-first-sync): callers then FAIL OPEN, because "no cache
 * yet" is indistinguishable from "follows not hydrated" and silently eating
 * real messages is worse. An empty cached array gates strictly.
 */
export async function loadFollowedPubkeys(pubkey: string): Promise<Set<string> | null> {
  try {
    const raw = await AsyncStorage.getItem(perAccountKey(CONTACTS_CACHE_KEY_BASE, pubkey));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const set = new Set<string>();
    for (const c of parsed) {
      const pk = (c as { pubkey?: unknown })?.pubkey;
      if (typeof pk === 'string' && HEX64.test(pk.toLowerCase())) set.add(pk.toLowerCase());
    }
    return set;
  } catch {
    return null;
  }
}

/**
 * Store a wrap decrypted outside the inbox refresh, through the inbox's
 * ingest. A wrap already stored is skipped by its decrypt-once gate.
 * `followed` is the background follow set. Without one nothing is stored:
 * the alert gate fails open, but persisting a stranger's message would show
 * it in Messages before a refresh could filter it.
 */
export async function storeDecryptedWrap(
  owner: string,
  wrap: nostrService.RawGiftWrapEvent,
  rumor: DecodedRumor,
  followed: Set<string> | null,
): Promise<void> {
  if (!followed) return;
  await loadRepliedPartners(owner);
  // Lazy: the ingest pulls in group routing and Marmot, which the watch
  // itself shouldn't load just to arm.
  const { ingestInboxWraps } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../contexts/dmWrapIngest') as typeof import('../contexts/dmWrapIngest');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dmOwnerEpoch, isDmOwnerRetired } =
    require('./dmOwnerGuard') as typeof import('./dmOwnerGuard');
  // A sign-out while this decrypts wipes the owner's rows: the save must not
  // put this one back, so it checks the wipe counter right before writing.
  const epoch = dmOwnerEpoch(owner);
  await ingestInboxWraps({
    owner,
    wraps: [{ ...wrap, decoded: rumor }],
    unwrap: (w) => w.decoded,
    // Same gate as the alert: someone we've replied to passes too (#1623).
    passesFollowGate: (pk) => followed.has(pk.toLowerCase()) || hasRepliedTo(owner, pk),
    isFollowed: (pk) => followed.has(pk.toLowerCase()),
    // Signed out before this started (retired), or while it ran (epoch).
    persistIf: () => !isDmOwnerRetired(owner) && dmOwnerEpoch(owner) === epoch,
  });
}

/**
 * Fetch, decrypt and store one gift wrap by id: the message an alert was
 * raised for, so tapping it doesn't wait for a whole inbox refresh. Local
 * keys only; a remote signer leaves it to the refresh. Never rejects.
 */
export async function catchUpWrapById(owner: string, wrapId: string): Promise<void> {
  try {
    const { identities } = await loadIdentities();
    const me = owner.toLowerCase();
    const identity = identities.find((i) => i.pubkey.toLowerCase() === me);
    const decrypt = identity ? buildNsecDecryptor(identity) : null;
    if (!decrypt) return;
    const relays = await resolveReadRelays(owner);
    if (relays.length === 0) return;
    const [wrap] = (await querySyncAbortable(
      nostrService.pool,
      relays,
      { kinds: [1059], ids: [wrapId], limit: 1 },
      { maxWait: 4000 },
    )) as nostrService.RawGiftWrapEvent[];
    if (!wrap || wrap.id !== wrapId) return;
    const rumor = decrypt(wrap);
    if (!rumor) return;
    const followed = await loadFollowedPubkeys(owner);
    // Signed out during the fetch (the identity and its store are gone): a
    // late write would put a row back into the wiped store.
    const still = await loadIdentities();
    if (!still.identities.some((i) => i.pubkey.toLowerCase() === me)) return;
    await storeDecryptedWrap(owner, wrap, rumor, followed);
  } catch {
    // The inbox refresh still delivers it.
  }
}
