import { perAccountKey } from '../services/perAccountStorage';
import type { RawGiftWrapEvent } from '../services/nostrService';
import { unwrapWrapNsec, unwrapWrapViaNip44 } from '../utils/nip17Unwrap';
import { getMemoisedSecretKey } from './nostrSecretKeyCache';
import { ingestInboxWraps, type InboxWrapIngestResult } from './dmWrapIngest';
import {
  NSEC_NIP17_SKIP_KEY_BASE,
  AMBER_NIP17_SKIP_KEY_BASE,
  NIP46_NIP17_SKIP_KEY_BASE,
} from './nostrDmCache';
import { nip46Unwrap } from './nip46DmDecrypt';

/**
 * Per-signer NIP-17 inbox decrypt-once ingest — the branch that lived inline in
 * `useDmInbox.refreshDmInbox`, lifted here so the hook stays under the file-size
 * cap and the "which signer decrypts how" decision has one home (#283).
 *
 * All three signers feed the SAME `ingestInboxWraps` engine (DB known-id gate,
 * #743 skip-set, group routing, B1 follow gate, #532/#788 pacing) — they differ
 * only in how a wrap is unwrapped and which per-signer skip-set key is used:
 *   - nsec  → cheap pure-JS decrypt with the memoised secret key.
 *   - amber → silent ContentResolver decrypt; a PERMISSION_NOT_GRANTED on the
 *             first wrap stops the loop and surfaces `amberPermission: 'denied'`
 *             so the caller can prompt for a one-time grant (#404).
 *   - nip46 → per-wrap bunker round-trip (no silent-batch path, no permission
 *             concept — see nip46DmDecrypt).
 *
 * Returns `null` when there's nothing to do (no wraps, or an nsec login whose
 * secret key isn't available) so the caller leaves its counters untouched,
 * exactly as the old inline `if`/`else if` chain did.
 */
export interface InboxNip17IngestOutcome {
  entries: InboxWrapIngestResult['entries'];
  alreadyKnown: number;
  skipHits: number;
  misses: number;
  stored: number;
  yields: number;
  /** Set only for the Amber signer, mirroring the old inline branch. */
  amberPermission?: 'denied' | 'granted';
}

export async function ingestInboxNip17ForSigner(args: {
  signerType: 'nsec' | 'amber' | 'nip46';
  ownerPubkey: string;
  wraps: readonly RawGiftWrapEvent[];
  passesFollowGate: (pk: string) => boolean;
  isFollowed?: (pk: string) => boolean;
  followsHydrated?: boolean;
  bypassSkipSet?: boolean;
  isColdStart?: boolean;
  signal?: AbortSignal;
  onSkip: (reason: string, wrapId: string) => void;
  amberNip44DecryptSilent: (ciphertext: string, counterpartyPubkey: string) => Promise<string>;
}): Promise<InboxNip17IngestOutcome | null> {
  const {
    signerType,
    ownerPubkey,
    wraps,
    passesFollowGate,
    isFollowed,
    followsHydrated,
    bypassSkipSet,
    isColdStart,
    signal,
    onSkip,
    amberNip44DecryptSilent,
  } = args;
  if (wraps.length === 0) return null;

  let result: InboxWrapIngestResult;
  if (signerType === 'nsec') {
    const secretKey = await getMemoisedSecretKey(ownerPubkey);
    if (!secretKey) return null;
    result = await ingestInboxWraps({
      owner: ownerPubkey,
      wraps,
      unwrap: (wrap) => unwrapWrapNsec(wrap, secretKey, onSkip),
      passesFollowGate,
      isFollowed,
      followsHydrated,
      skipKey: perAccountKey(NSEC_NIP17_SKIP_KEY_BASE, ownerPubkey),
      bypassSkipSet,
      isColdStart,
      signal,
      onSkip,
    });
  } else if (signerType === 'amber') {
    result = await ingestInboxWraps({
      owner: ownerPubkey,
      wraps,
      unwrap: (wrap) => unwrapWrapViaNip44(wrap, amberNip44DecryptSilent, onSkip),
      passesFollowGate,
      isFollowed,
      followsHydrated,
      skipKey: perAccountKey(AMBER_NIP17_SKIP_KEY_BASE, ownerPubkey),
      bypassSkipSet,
      isColdStart,
      signal,
      stopOnPermissionDenied: true,
      onSkip,
    });
  } else {
    result = await ingestInboxWraps({
      owner: ownerPubkey,
      wraps,
      unwrap: nip46Unwrap(ownerPubkey, onSkip),
      passesFollowGate,
      isFollowed,
      followsHydrated,
      skipKey: perAccountKey(NIP46_NIP17_SKIP_KEY_BASE, ownerPubkey),
      bypassSkipSet,
      isColdStart,
      signal,
      // Mirror the Amber branch: if the bunker denies `nip44_decrypt`, stop
      // after the first denial rather than firing a round-trip per wrap on
      // every refresh. `isPermissionNotGranted` matches the normalised
      // `NIP-46 signer denied …` message (dmWrapIngest.ts).
      stopOnPermissionDenied: true,
      onSkip,
    });
  }

  return {
    entries: result.entries,
    alreadyKnown: result.alreadyKnown,
    skipHits: result.skipHits,
    misses: result.misses,
    stored: result.stored,
    yields: result.yields,
    amberPermission:
      signerType === 'amber' ? (result.permissionDenied ? 'denied' : 'granted') : undefined,
  };
}
