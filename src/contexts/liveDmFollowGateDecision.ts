import type { DecodedRumor } from '../utils/nip17Unwrap';
import type React from 'react';
import { isFollowed } from '../utils/followPubkeys';
import { dmRowPreview } from '../utils/dmRowPreview';
import { getAppFormatLocale } from '../utils/appFormatLocale';
import { MARMOT_WELCOME_KIND } from '../utils/dmProtocol';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import type { LiveSubFollowGateBuffer } from './liveSubFollowGate';

/** Shared kind-4 / kind-1059 policy. Cache contents do not imply readiness. */
export function gateLiveDm({
  entry,
  kind,
  follows,
  hydrated,
  buffer,
  fresh,
  cacheReady = false,
  bypassOwn = false,
  replied = false,
  groupRumor,
  rumor,
  onEvict,
}: {
  entry: DmInboxEntry;
  groupRumor?: DecodedRumor;
  rumor?: DecodedRumor;
  onEvict?: () => void;
  kind: 4 | 1059;
  follows: Set<string>;
  hydrated: boolean;
  buffer: LiveSubFollowGateBuffer;
  fresh: boolean;
  bypassOwn?: boolean;
  cacheReady?: boolean;
  /** The viewer has sent this partner a message (#1623): their side of the
   * conversation passes like a follow's, hydrated or not. */
  replied?: boolean;
}): 'pass' | 'defer' | 'drop' {
  const label = kind === 4 ? 'kind-4' : 'wrap';
  if (bypassOwn && entry.fromMe) return 'pass';
  if (replied) return 'pass';
  if ((hydrated || cacheReady) && isFollowed(follows, entry.partnerPubkey)) return 'pass';
  if (!hydrated) {
    const text = dmRowPreview(entry.text, entry.wireKind, getAppFormatLocale());
    buffer.defer({
      partnerPubkey: entry.partnerPubkey,
      ...(groupRumor ? { groupRumor } : {}),
      entry: { ...entry, text },
      content: entry.text,
      ...(rumor?.kind === MARMOT_WELCOME_KIND ? { rumor } : {}),
      onEvict,
      ...(fresh && !entry.fromMe && entry.wireKind !== MARMOT_WELCOME_KIND
        ? { notify: { title: 'New message', body: text } }
        : {}),
    });
    if (__DEV__)
      console.log(
        `[Nostr] live ${label} ${entry.id.slice(0, 8)} deferred by follow-gate (partner=${entry.partnerPubkey.slice(0, 8)}, kind=${kind}, follows=${follows.size}, hydrated=${hydrated}, inSet=${isFollowed(follows, entry.partnerPubkey)}, buffered=${buffer.size})`,
      );
    return 'defer';
  }
  if (__DEV__)
    console.log(
      `[Nostr] live ${label} ${entry.id.slice(0, 8)} dropped by follow-gate (partner=${entry.partnerPubkey.slice(0, 8)}, follows=${follows.size}, hydrated=${hydrated})`,
    );
  return 'drop';
}

export const FOLLOW_GATE_TIMEOUT_MS = 15_000;

/** Offline fallback never prevents a later reconciled list from recovering arrivals. */
export function startFollowGateFallback(
  follows: React.MutableRefObject<Set<string>>,
  hydrated: React.MutableRefObject<boolean>,
  buffer: LiveSubFollowGateBuffer,
  replay: Parameters<LiveSubFollowGateBuffer['reevaluate']>[1],
): { ready: () => boolean; dispose: () => void } {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    if (!hydrated.current) buffer.reevaluate(follows.current, replay);
  }, FOLLOW_GATE_TIMEOUT_MS);
  return { ready: () => expired, dispose: () => clearTimeout(timer) };
}
