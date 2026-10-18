// Approximate fiat-label formatting for sats amounts (e.g. "≈ $1.23"). Used by
// the LNURL-withdraw sheet and the geo-cache prize screen so the formatting
// stays in one place. Symbols come from the app's authoritative CURRENCY_LIST
// (fiatService) — no second symbol table. #341.
import { CURRENCY_LIST } from '../services/fiatService';

const SYMBOL_BY_CODE = new Map(CURRENCY_LIST.map((c) => [c.code, c.symbol]));

/** The currency symbol for a code (e.g. 'USD' → '$'), or '' if unknown. */
export function fiatSymbol(currency: string): string {
  return SYMBOL_BY_CODE.get(currency) ?? '';
}

/**
 * Format `sats` as an approximate fiat label (e.g. `≈ $1.23`) given the BTC
 * spot price and the user's currency. Returns null when there's nothing to
 * show (no price yet, or a non-positive amount), so callers can skip rendering.
 */
export function formatFiatApprox(
  sats: number,
  btcPrice: number | null | undefined,
  currency: string,
  locale?: string,
): string | null {
  if (!btcPrice || sats <= 0) return null;
  const value = (sats / 1e8) * btcPrice;
  const num = value.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = fiatSymbol(currency);
  return symbol ? `≈ ${symbol}${num}` : `≈ ${num} ${currency}`;
}

/** Spacing for a conversion nested after the primary sats text; no rate = no gap. */
export function formatInlineFiatApprox(
  sats: number,
  btcPrice: number | null | undefined,
  currency: string,
  locale?: string,
): string | null {
  const label = formatFiatApprox(sats, btcPrice, currency, locale);
  return label ? `  ${label}` : null;
}
