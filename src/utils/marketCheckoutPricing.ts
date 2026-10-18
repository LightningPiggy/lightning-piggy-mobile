// Buyer-side pricing for the in-app checkout, in whole sats. PURE — no React,
// no I/O (coverage scope: src/utils); the sheet supplies BTC spot rates.
//
// A Gamma order states its `amount` in sats (market-spec §4 "Order
// Creation"), but listings and shipping options are priced in their own
// currencies. Per the spec:
//   - the listing `price` is `[amount, currency]`;
//   - a 30406 shipping option's base `price` is in the OPTION's currency;
//   - a listing's `shipping_option` third element is an extra cost in the
//     PRODUCT's currency.
// Every conversion fails closed (null) when a needed rate is missing, so the
// sheet blocks submit instead of guessing.
import type { MarketProduct } from '../data/marketProducts';
import type { MarketCheckoutTarget } from './marketCheckout';
import { normalizeCurrencyCode } from './currencyCode';
import { shippingCostFor, shippingCostSats, type ShippingOption } from './marketShipping';

/** BTC spot price per fiat currency; null = fetch failed, undefined = not fetched. */
export type BtcRates = Readonly<Record<string, number | null | undefined>>;

export function isSatsDenominated(currency: string): boolean {
  const cur = normalizeCurrencyCode(currency);
  return cur === 'SATS' || cur === 'BTC';
}

/** Convert `amount` of `currency` to whole sats with `rates`, or null. */
export function amountToSats(amount: number, currency: string, rates: BtcRates): number | null {
  const cur = normalizeCurrencyCode(currency);
  return shippingCostSats(amount, cur, isSatsDenominated(cur) ? null : (rates[cur] ?? null));
}

/** Unit price in sats: the catalogue figure for curated products, the
 * listing's own price converted at the current rate for relay listings. */
export function checkoutUnitPriceSats(
  product: Pick<MarketProduct, 'priceSats'>,
  target: Pick<MarketCheckoutTarget, 'source' | 'price'>,
  rates: BtcRates,
): number | null {
  if (target.source === 'curated' || !target.price) {
    return Number.isSafeInteger(product.priceSats) && product.priceSats > 0
      ? product.priceSats
      : null;
  }
  const sats = amountToSats(target.price.amount, target.price.currency, rates);
  return sats !== null && sats > 0 ? sats : null;
}

/** The shipping options this listing can be ordered with. A listing that
 * references options gets exactly those (that the seller still publishes);
 * one that references none falls back to all of the seller's options. */
export function checkoutShippingOptions(
  target: Pick<MarketCheckoutTarget, 'shippingRefs'>,
  options: readonly ShippingOption[],
): ShippingOption[] {
  if (target.shippingRefs.length === 0) return [...options];
  const wanted = new Set(target.shippingRefs.map((r) => r.coordinate));
  return options.filter((o) => wanted.has(o.coordinate));
}

/** All-in sats cost of `option` for this target: the option's base (in the
 * option currency) plus the listing's surcharge (in the listing currency). */
export function checkoutShippingCostSats(
  option: ShippingOption,
  target: Pick<MarketCheckoutTarget, 'source' | 'price' | 'shippingRefs'>,
  rates: BtcRates,
): number | null {
  const base = amountToSats(shippingCostFor(option), option.currency, rates);
  if (base === null) return null;
  const ref = target.shippingRefs.find((r) => r.coordinate === option.coordinate);
  if (target.source !== 'listing' || !target.price || !ref || ref.extraAmount <= 0) return base;
  const extra = amountToSats(ref.extraAmount, target.price.currency, rates);
  if (extra === null) return null;
  const total = base + extra;
  return Number.isSafeInteger(total) ? total : null;
}

/** Fiat currencies the sheet needs BTC rates for (listing + option prices). */
export function checkoutRateCurrencies(
  target: Pick<MarketCheckoutTarget, 'price'>,
  options: readonly ShippingOption[],
): string[] {
  const currencies = new Set<string>();
  if (target.price && !isSatsDenominated(target.price.currency)) {
    currencies.add(normalizeCurrencyCode(target.price.currency));
  }
  for (const option of options) {
    if (!isSatsDenominated(option.currency)) currencies.add(normalizeCurrencyCode(option.currency));
  }
  return [...currencies].sort();
}
