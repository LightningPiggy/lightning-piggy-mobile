import { orderNotificationTarget } from '../utils/orderNotificationTarget';
import type { ParsedOrderEvent } from '../utils/orderEvents';
import { getConversationForEvent } from './dmDb';
import { protocolForWireKind, type DmProtocol } from '../utils/dmProtocol';

export interface ResolvedConversation {
  pubkey: string;
  protocol: DmProtocol;
  shopEventId?: string;
  shopOrderId?: string;
  myOrderId?: string;
  orderSellerPubkey?: string;
  shopBuyerPubkey?: string;
  conversationPubkey?: string;
  conversationProtocol?: DmProtocol;
}

type Lookup = (
  owner: string,
  eventId: string,
) => Promise<{
  conversation: string;
  wireKind: number;
  protocol?: DmProtocol;
  orderId?: string;
  orderType?: ParsedOrderEvent['type'];
  orderStatus?: string;
  fromMe?: boolean;
} | null>;

/**
 * The conversation a NIP-17 gift wrap belongs to (#1154). A message alert the
 * background couldn't decrypt carries only the wrap id; once the app has
 * decrypted and stored that wrap (inbox refresh / live sub after the tap), its
 * row names the conversation. Polls until then, up to `timeoutMs`; null if it
 * never appears (e.g. decryption was declined). If the first look misses,
 * `fetchNow` fetches and stores just that wrap, so the tap doesn't wait on a
 * whole inbox refresh (#1325).
 */
export async function resolveWrapConversation(
  owner: string,
  wrapId: string,
  {
    timeoutMs = 20_000,
    intervalMs = 750,
    lookup = getConversationForEvent,
    shouldStop = () => false,
    fetchNow,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    lookup?: Lookup;
    /** True once the result is no longer wanted (the user moved on). */
    shouldStop?: () => boolean;
    /** Fetch and store the wrap directly; run once, after the first miss. */
    fetchNow?: () => Promise<void>;
  } = {},
): Promise<ResolvedConversation | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (shouldStop()) return null;
    const row = await lookup(owner, wrapId).catch(() => null);
    if (row)
      return {
        pubkey: row.conversation,
        ...(row.orderId && row.orderType
          ? orderNotificationTarget(
              { type: row.orderType, orderId: row.orderId, status: row.orderStatus },
              row.conversation,
              row.fromMe ?? false,
            )
          : {}),
        protocol: protocolForWireKind(row.wireKind, row.protocol),
      };
    if (fetchNow) {
      const fetch = fetchNow;
      fetchNow = undefined;
      // Bounded by the deadline: a stalled fetch mustn't hold the tap past
      // it. The loop re-checks `shouldStop` straight after.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        fetch().catch(() => undefined),
        new Promise<void>((r) => {
          timer = setTimeout(r, Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      if (Date.now() >= deadline) return null;
      continue;
    }
    if (Date.now() + intervalMs > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Tracks whether the user moved on from `routeName` while a navigation there
 * is pending (#1154). Feed it every route change (`onRoute`); `movedOn()` is
 * false until the route has been focused (navigate() lands a moment later),
 * then true from the first change away from it — even between polls.
 */
export function createRouteLeaveTracker(routeName: string) {
  let reached = false;
  let left = false;
  return {
    onRoute(current: string | undefined) {
      if (current === routeName) reached = true;
      else if (reached) left = true;
    },
    movedOn: () => left,
  };
}

/** True when a message / group alert belongs to a signed-in account other than
 * the active one — opening its thread would show the wrong identity's view. */
export function isForAnotherAccount(
  data: { kind?: string; owner?: string },
  activePubkey: string | null,
): boolean {
  if (data.kind !== 'dm' && data.kind !== 'group') return false;
  return !!data.owner && data.owner.toLowerCase() !== (activePubkey ?? '').toLowerCase();
}
