// Kinds that must only ever travel as NIP-17 rumors inside a kind-13 seal /
// kind-1059 gift wrap — never signed, published or sent over Marmot bare.
//
// Gamma Markets (https://github.com/GammaMarkets/market-spec) reuses two
// kinds that already mean something else when they're public:
//
//   - kind 16 — Gamma order lifecycle (order / payment request / status /
//     shipping). Published openly it's a NIP-18 generic repost.
//   - kind 17 — Gamma payment receipt. Published openly it's a NIP-25
//     reaction to a website.
//
// A bare kind-16/17 would leak the order (buyer address, invoice, amounts) to
// every relay and be misread by other clients, so the sign, publish and Marmot
// paths call `assertNotWrapOnlyKind` and refuse. Unsigned rumors never hit
// those paths (NIP-59 seals/wraps sign kinds 13 and 1059), so the guard costs
// nothing on the legitimate flow.
//
// Pure, dependency-free: imported by nostrCrypto, nostrPool and marmotRumor.

/** Gamma order (16) and receipt (17): NIP-17 rumors only. */
export const WRAP_ONLY_KINDS: readonly number[] = [16, 17];

export function isWrapOnlyKind(kind: number): boolean {
  return WRAP_ONLY_KINDS.includes(kind);
}

/** Thrown when something tries to sign, publish or Marmot-send a wrap-only kind. */
export class WrapOnlyKindError extends Error {
  constructor(
    readonly kind: number,
    readonly path: 'sign' | 'publish' | 'marmot',
  ) {
    super(
      `Refusing to ${path === 'marmot' ? 'send over Marmot' : path} a bare kind-${kind} event: ` +
        'Gamma order kinds 16/17 travel only as NIP-17 gift-wrapped rumors.',
    );
    this.name = 'WrapOnlyKindError';
  }
}

/** Throw {@link WrapOnlyKindError} when `kind` must never leave a gift wrap. */
export function assertNotWrapOnlyKind(kind: number, path: 'sign' | 'publish' | 'marmot'): void {
  if (isWrapOnlyKind(kind)) throw new WrapOnlyKindError(kind, path);
}
