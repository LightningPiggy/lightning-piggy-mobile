// Account-session generation (#1746). Bumped on every change of the active
// Nostr identity — a login, logout or account switch all publish through
// useActiveNostrAccount's `setPubkey`. Long-running work that publishes a
// session on its own (cold-start auto-login) captures a token first and drops
// its result when the generation has moved on, so a slow SecureStore read can
// never override a newer manual choice.
let generation = 0;

export function bumpSessionGeneration(): void {
  generation += 1;
}

/** True until the next login, logout or account switch. */
export function captureSessionGeneration(): () => boolean {
  const ticket = generation;
  return () => generation === ticket;
}
