import { getMarmotSession } from './marmotSession';
import { invalidateMarmotAvailability } from '../utils/marmotAvailability';
import type { RootStackParamList } from '../navigation/types';
import type { DmProtocol } from '../utils/dmProtocol';

const LOOKUP_TIMEOUT_MS = 1_500;
const SUPPORTED_TTL_MS = 10 * 60_000;
const UNSUPPORTED_TTL_MS = 2 * 60_000;
const MAX_CACHED_PEERS = 256;
const cache = new Map<string, { protocol: DmProtocol; expires: number }>();
const pending = new Map<string, Promise<DmProtocol>>();

/** Prefer an existing secure DM, then a usable invitation key on the peer's
 * relays. Explicit choices (including an open NIP-17 thread) always win.
 * Session.canMessage reuses the bounded, relay-discovering device lookup and
 * validates signatures, credentials, lifetimes and retired publication slots.
 */
export async function preferredDmProtocol(
  viewer: string | null,
  peer: string,
  explicit?: DmProtocol,
): Promise<DmProtocol> {
  if (explicit) return explicit;
  const session = getMarmotSession();
  if (!viewer || !session || session.pubkey !== viewer.toLowerCase()) return 'nip17';
  const recipient = peer.trim().toLowerCase();
  if (session.findDm(recipient)) return 'marmot';
  const key = `${viewer.toLowerCase()}:${recipient}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.protocol;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const run = (async (): Promise<DmProtocol> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const supported = await Promise.race([
        (async () => {
          await session.ready;
          return Boolean(session.findDm(recipient)) || (await session.canMessage(recipient));
        })().catch(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), LOOKUP_TIMEOUT_MS);
        }),
      ]);
      const protocol = supported ? 'marmot' : 'nip17';
      // A key we just found supersedes the picker's cached "not on Marmot".
      if (supported) invalidateMarmotAvailability(recipient);
      if (cache.size >= MAX_CACHED_PEERS) cache.delete(cache.keys().next().value!);
      cache.set(key, {
        protocol,
        expires: Date.now() + (supported ? SUPPORTED_TTL_MS : UNSUPPORTED_TTL_MS),
      });
      return protocol;
    } finally {
      clearTimeout(timer);
      pending.delete(key);
    }
  })();
  pending.set(key, run);
  return run;
}

type ConversationParams = RootStackParamList['Conversation'];
/** A person to chat with; a protocol here is an explicit choice and is kept. */
export type DirectChatTarget = Omit<ConversationParams, 'protocol'> & { protocol?: DmProtocol };

/** Build navigation params using the same choice as the send path. */
export async function preferredConversationParams(
  viewer: string | null,
  target: DirectChatTarget,
): Promise<ConversationParams> {
  return { ...target, protocol: await preferredDmProtocol(viewer, target.pubkey, target.protocol) };
}
