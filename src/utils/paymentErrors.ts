/**
 * Map raw NWC / SDK / wallet error strings onto user-facing messages.
 *
 * Internal error bodies leak implementation details the user can't act
 * on (e.g. "reply timeout: event b706d199…" or "All promises were
 * rejected"). We replace them with a short explanation and keep the
 * raw text available as `detail` so the overlay can expose it behind a
 * "Show details" toggle for dev / support.
 */

export interface HumanizedPaymentError {
  /** User-facing message. Safe to render as the error subtitle. */
  message: string;
  /** Raw underlying error string, if available. */
  detail?: string;
}

const CONNECTIVITY_PATTERNS = [
  'reply timeout',
  'publish timed out',
  'failed to publish',
  'all promises were rejected',
  'wallet unreachable',
  'network request failed',
  'websocket',
];

const INSUFFICIENT_FUNDS_PATTERNS = [
  'insufficient balance',
  'insufficient_balance',
  'insufficient',
];

const EXPIRED_PATTERNS = ['invoice has expired', 'invoice expired', 'expired'];

const ALREADY_PAID_PATTERNS = ['already paid', 'already settled', 'is_settled'];

const CANCELLED_PATTERNS = ['aborted', 'cancelled', 'canceled'];

function containsAny(lower: string, needles: string[]): boolean {
  for (const n of needles) if (lower.includes(n)) return true;
  return false;
}

export function humanizePaymentError(raw: string | undefined | null): HumanizedPaymentError {
  if (!raw) return { message: 'Payment failed. Please try again.' };
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (containsAny(lower, CANCELLED_PATTERNS)) {
    return { message: 'Cancelled.', detail: trimmed };
  }
  if (containsAny(lower, CONNECTIVITY_PATTERNS)) {
    return {
      message: "Couldn't reach your wallet. Check your connection and try again.",
      detail: trimmed,
    };
  }
  if (containsAny(lower, INSUFFICIENT_FUNDS_PATTERNS)) {
    return { message: 'Insufficient balance.', detail: trimmed };
  }
  if (containsAny(lower, EXPIRED_PATTERNS)) {
    return { message: 'This invoice has expired.', detail: trimmed };
  }
  if (containsAny(lower, ALREADY_PAID_PATTERNS)) {
    return { message: 'This invoice has already been paid.', detail: trimmed };
  }

  // Heuristic: if the raw string looks like a hex event id (64 hex chars
  // anywhere in the message), strip it out before showing — users shouldn't
  // see internal event hashes even on the fallback path. `cleaned` is
  // what we display; `trimmed` is kept as the raw detail for support.
  const cleaned = trimmed.replace(/[0-9a-f]{64}/gi, '').trim();
  const looksTechnical = cleaned.length < 4 || /^[^\p{L}]+$/u.test(cleaned);
  return {
    message: looksTechnical ? 'Payment failed. Please try again.' : cleaned,
    detail: trimmed,
  };
}
