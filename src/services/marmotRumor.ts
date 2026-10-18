import { getEventHash } from 'nostr-tools';
import type { MarmotRumor } from './marmotSession';
import { assertNotWrapOnlyKind } from '../utils/wrapOnlyKinds';

/** Build an unsigned app event (Marmot app payloads are never signed). */
export function buildMarmotRumor(
  pubkey: string,
  draft: { kind: number; content: string; tags?: string[][]; created_at?: number },
): MarmotRumor {
  // Gamma orders (kind 16) and receipts (17) are NIP-17-only: a Marmot group
  // member's client wouldn't treat them as an order thread with the seller.
  assertNotWrapOnlyKind(draft.kind, 'marmot');
  const unsigned = {
    pubkey,
    kind: draft.kind,
    content: draft.content,
    tags: draft.tags ?? [],
    created_at: draft.created_at ?? Math.floor(Date.now() / 1000),
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}
