// Marketplace "mode" — which set of sellers the Market section sources its
// products from. Mirrors the curation model on lightningpiggy.com/market/
// (Lightning Piggy preferred sellers) while letting the user widen the lens
// to their own Nostr web-of-trust.
//
// Pure data + selection helpers only (no React, no relay I/O) so the modes
// and the product filter are independently unit-testable (coverage scope:
// src/utils).
import type { MarketProduct } from '../data/marketProducts';
import { sellerOf } from '../data/marketProducts';

/**
 * The four marketplace modes.
 *   `preferred` — Lightning Piggy preferred sellers (the curated, designated
 *                 shops). DEFAULT, ACTIVE.
 *   `wotFriends` — products from sellers in the user's Nostr follow set
 *                  (web-of-trust "friends"). ACTIVE.
 *   `wotFof`    — friends-of-friends (follows plus the people they follow).
 *                 EXPERIMENTAL: selectable only with "Show experimental
 *                 features" on; otherwise shown as "coming soon".
 *   `wotAll`    — listings from anyone (no author filter). EXPERIMENTAL:
 *                 selectable only with experimental features on; otherwise
 *                 hidden.
 */
export type MarketMode = 'preferred' | 'wotFriends' | 'wotFof' | 'wotAll';

/** Default mode for a fresh session — the curated preferred-sellers view. */
export const DEFAULT_MARKET_MODE: MarketMode = 'preferred';

/** UI descriptor for one marketplace mode. */
export interface MarketModeOption {
  mode: MarketMode;
  /** Selector label, e.g. "Lightning Piggy Preferred Sellers". */
  labelKey: string;
  /** Whether the mode is selectable with experimental features OFF. */
  enabled: boolean;
  /** Whether turning experimental features ON unlocks the mode. */
  experimental: boolean;
  /** While locked: hide the row entirely instead of greying it out with a
   * "coming soon" hint. */
  hiddenWhenLocked: boolean;
}

/**
 * The mode options in display order. "Preferred Sellers" and "WoT: Friends"
 * are always available; friends-of-friends and all are unlocked by the
 * experimental-features setting (Advanced → Experimental).
 */
export const MARKET_MODE_OPTIONS: readonly MarketModeOption[] = [
  {
    mode: 'preferred',
    labelKey: 'market.modes.preferred',
    enabled: true,
    experimental: false,
    hiddenWhenLocked: false,
  },
  {
    mode: 'wotFriends',
    labelKey: 'market.modes.friends',
    enabled: true,
    experimental: false,
    hiddenWhenLocked: false,
  },
  {
    mode: 'wotFof',
    labelKey: 'market.modes.friendsOfFriends',
    enabled: false,
    experimental: true,
    hiddenWhenLocked: false,
  },
  {
    mode: 'wotAll',
    labelKey: 'market.modes.all',
    enabled: false,
    experimental: true,
    hiddenWhenLocked: true,
  },
];

/** Look up a mode option by mode. */
export function marketModeOption(mode: MarketMode): MarketModeOption {
  return MARKET_MODE_OPTIONS.find((o) => o.mode === mode) ?? MARKET_MODE_OPTIONS[0];
}

/** Whether a given mode is currently selectable. `experimental` is the
 * "Show experimental features" setting (GroupsContext `secretMode`). */
export function isMarketModeEnabled(mode: MarketMode, experimental = false): boolean {
  const option = marketModeOption(mode);
  return option.enabled || (experimental && option.experimental);
}

/** A mode row as the Sellers section renders it. */
export interface MarketModeRow {
  option: MarketModeOption;
  /** Selectable now; a disabled row renders greyed with "coming soon". */
  enabled: boolean;
}

/** The Sellers rows for the current experimental setting, in display order:
 * locked modes are greyed ("coming soon") or hidden per their option. */
export function marketModeRows(experimental: boolean): MarketModeRow[] {
  return MARKET_MODE_OPTIONS.flatMap((option) => {
    const enabled = isMarketModeEnabled(option.mode, experimental);
    return !enabled && option.hiddenWhenLocked ? [] : [{ option, enabled }];
  });
}

/**
 * The mode actually in force: a saved experimental scope (friends-of-friends
 * / all) falls back to the default once experimental features are turned off,
 * so a shopper never stays on a scope they can no longer see or change.
 */
export function effectiveMarketMode(mode: MarketMode, experimental: boolean): MarketMode {
  return isMarketModeEnabled(mode, experimental) ? mode : DEFAULT_MARKET_MODE;
}

/**
 * Select the products visible under a given mode.
 *
 *   `preferred`  — the full curated catalogue (every product is, by
 *                  definition, from a Lightning Piggy preferred seller).
 *   `wotFriends` — only products whose seller has a Nostr identity the user
 *                  follows. `friendPubkeys` is the lowercase-hex follow set
 *                  (from `useTrustGraph().trustSet` / the kind-3 follows);
 *                  a product matches when its seller's pubkey is in the set.
 *   `wotFof` / `wotAll` — no-ops here: those scopes are sourced from relays
 *                  by author set (or none), so the input already IS the
 *                  scope. Like `preferred`, they return `products` unchanged.
 *
 * `sellerPubkeyOf` resolves a product's seller pubkey (hex) — injected so
 * this stays free of the nostr-tools decode dependency and trivially
 * testable. Returns a new array; never mutates the input.
 */
export function productsForMode(
  mode: MarketMode,
  products: MarketProduct[],
  friendPubkeys: ReadonlySet<string>,
  sellerPubkeyOf: (product: MarketProduct) => string | null,
): MarketProduct[] {
  if (mode !== 'wotFriends') return [...products];
  return products.filter((p) => {
    const pk = sellerPubkeyOf(p);
    return pk !== null && friendPubkeys.has(pk.toLowerCase());
  });
}

/** Whether a product is sold by a seller in the directory at all (sanity
 * filter shared by callers; an orphan seller is a data error). */
export function hasKnownSeller(product: MarketProduct): boolean {
  return sellerOf(product) !== undefined;
}
