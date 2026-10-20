import { MarmotUnusableKeyPackageError } from '../services/marmotKeyPackages';

/**
 * Whether a contact can be messaged over Marmot, as the message-type picker
 * shows it:
 *   - `checking`    — the lookup is in flight (the option stays selectable);
 *   - `available`   — they have a usable invitation key (kind 30443), or we
 *                     already share a Marmot chat;
 *   - `unavailable` — relays answered and they have no usable key;
 *   - `error`       — we couldn't find out (no relay answered, timed out, or
 *                     Marmot isn't running yet). Never treated as "not on
 *                     Marmot": it's retryable and never cached.
 */
export type MarmotAvailability = 'checking' | 'available' | 'unavailable' | 'error';
export type MarmotAvailabilityResult = Exclude<MarmotAvailability, 'checking'>;

/** The slice of MarmotSession the check needs. */
export interface MarmotAvailabilitySession {
  pubkey: string;
  ready: Promise<unknown>;
  findDm(peer: string): unknown;
  /** Resolves false for "no key packages"; throws when the lookup failed. */
  canMessage(peer: string): Promise<boolean>;
}

/** One bounded lookup (two relay round trips); past this it's an `error`. */
export const MARMOT_AVAILABILITY_TIMEOUT_MS = 10_000;
const MAX_CACHED_PEERS = 256;

// Session-lifetime, in-memory only: a definite answer per viewer:peer.
const cache = new Map<string, MarmotAvailabilityResult>();
const pending = new Map<string, Promise<MarmotAvailabilityResult>>();

const keyFor = (viewer: string, peer: string) =>
  `${viewer.toLowerCase()}:${peer.trim().toLowerCase()}`;

/**
 * The known answer without touching the network, or null if we must check.
 * An existing Marmot chat with the peer always reads `available` — it
 * supersedes a cached `unavailable` (they've since set Marmot up and invited
 * us, or we invited a key that appeared later).
 */
export function peekMarmotAvailability(
  session: MarmotAvailabilitySession | null,
  peer: string,
): MarmotAvailabilityResult | null {
  if (!session) return null;
  const key = keyFor(session.pubkey, peer);
  if (session.findDm(peer.trim().toLowerCase())) {
    cache.set(key, 'available');
    return 'available';
  }
  return cache.get(key) ?? null;
}

/**
 * Look the peer up (cached per viewer:peer for the app session; concurrent
 * calls share one lookup). `force` skips a cached answer — a retry. Only
 * `available` / `unavailable` are cached; an `error` is always re-checked.
 * Without a session (signed out, or Marmot still starting) the answer is
 * `error`: we can't tell yet, so the user can retry rather than be told the
 * contact isn't on Marmot.
 */
export function checkMarmotAvailability(
  session: MarmotAvailabilitySession | null,
  peer: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<MarmotAvailabilityResult> {
  if (!session) return Promise.resolve('error');
  const recipient = peer.trim().toLowerCase();
  const key = keyFor(session.pubkey, recipient);
  if (!opts.force) {
    const known = peekMarmotAvailability(session, recipient);
    if (known) return Promise.resolve(known);
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const run = (async (): Promise<MarmotAvailabilityResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        lookup(session, recipient),
        new Promise<MarmotAvailabilityResult>((resolve) => {
          timer = setTimeout(
            () => resolve('error'),
            opts.timeoutMs ?? MARMOT_AVAILABILITY_TIMEOUT_MS,
          );
        }),
      ]);
      if (result === 'error') cache.delete(key);
      else {
        if (!cache.has(key) && cache.size >= MAX_CACHED_PEERS) {
          cache.delete(cache.keys().next().value!);
        }
        cache.set(key, result);
      }
      return result;
    } finally {
      clearTimeout(timer);
      pending.delete(key);
    }
  })();
  pending.set(key, run);
  return run;
}

async function lookup(
  session: MarmotAvailabilitySession,
  peer: string,
): Promise<MarmotAvailabilityResult> {
  try {
    await session.ready;
    if (session.findDm(peer)) return 'available';
    return (await session.canMessage(peer)) ? 'available' : 'unavailable';
  } catch (e) {
    // Keys were published but none is usable (expired / incompatible): as
    // good as none for us. Anything else (no relay answered) is unknown.
    return e instanceof MarmotUnusableKeyPackageError ? 'unavailable' : 'error';
  }
}

/** Forget the answer for a peer (e.g. we learned of a new key package). */
export function invalidateMarmotAvailability(peer: string): void {
  const suffix = `:${peer.trim().toLowerCase()}`;
  for (const key of [...cache.keys()]) if (key.endsWith(suffix)) cache.delete(key);
}

/** Test-only: forget everything. */
export function resetMarmotAvailabilityCache(): void {
  cache.clear();
  pending.clear();
}
