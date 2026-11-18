// Deep links the home-screen widget's buttons open (#1849):
//   lightningpiggy://receive?wallet=<id>
//   lightningpiggy://send?wallet=<id>
//   lightningpiggy://scan?wallet=<id>
// Each lands on Home with that wallet selected and the Receive or Send sheet
// open (Send on its Scan tab for `scan`). They only OPEN a screen: the user
// still confirms every payment in the app.

export const WIDGET_ACTIONS = ['receive', 'send', 'scan'] as const;
export type WidgetAction = (typeof WIDGET_ACTIONS)[number];

export interface WidgetDeepLink {
  action: WidgetAction;
  /** null when the link carries no (or a malformed) wallet id. */
  walletId: string | null;
}

// Wallet ids are app-generated UUIDs; legacy ones are other short tokens.
// Anything outside this shape is ignored rather than routed.
const WALLET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function buildWidgetDeepLink(action: WidgetAction, walletId: string | null): string {
  const base = `lightningpiggy://${action}`;
  return walletId ? `${base}?wallet=${encodeURIComponent(walletId)}` : base;
}

function readWalletParam(query: string | undefined): string | null {
  if (!query) return null;
  for (const pair of query.split('&')) {
    const [key, value = ''] = pair.split('=');
    if (key !== 'wallet') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    return WALLET_ID_PATTERN.test(decoded) ? decoded : null;
  }
  return null;
}

/** Parse a widget deep link, or null when the URL isn't one. Never throws. */
export function parseWidgetDeepLink(url: string | null | undefined): WidgetDeepLink | null {
  if (!url) return null;
  const match = url
    .trim()
    .match(/^lightningpiggy:\/\/(receive|send|scan)\/?(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;
  return {
    action: match[1].toLowerCase() as WidgetAction,
    walletId: readWalletParam(match[2]),
  };
}
