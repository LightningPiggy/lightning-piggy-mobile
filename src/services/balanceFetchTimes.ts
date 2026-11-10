// When each wallet's balance was last actually fetched from its wallet service
// or chain this session (#1849). The home-screen widget shows this as
// "Updated 14:32", so it must never be a write time or a cache-load time: only
// the balance readers (nwcService / onchainService) record it, after a
// successful read. In memory only; a cold start knows nothing until the first
// fetch. One Map write per fetch — no work on any hot path.

const fetchedAt = new Map<string, number>();
const listeners = new Set<(walletId: string) => void>();

export function noteBalanceFetched(walletId: string, at: number = Date.now()): void {
  fetchedAt.set(walletId, at);
  for (const listener of listeners) {
    try {
      listener(walletId);
    } catch {
      // A failing listener must never break a balance read.
    }
  }
}

export function balanceFetchedAt(walletId: string): number | null {
  return fetchedAt.get(walletId) ?? null;
}

export function subscribeBalanceFetches(listener: (walletId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only. */
export function __resetBalanceFetchTimesForTests(): void {
  fetchedAt.clear();
  listeners.clear();
}
