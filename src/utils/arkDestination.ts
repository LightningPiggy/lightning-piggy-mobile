/**
 * Classify what the user pasted or scanned on the Ark Send screen. Pure, so
 * it is unit-tested without the bark native module. The wallet still
 * validates every destination before paying (bark checks the Ark address
 * belongs to our server, the invoice network, and so on).
 */
import { amountSatsFromBolt11 } from './bolt11';
import { isLightningAddress, isLnurlString, stripLightningPrefix } from './sendSheetInput';

export type ArkDestinationKind = 'ark' | 'bolt11' | 'lightningAddress' | 'lnurl' | 'bitcoin';

export interface ArkDestination {
  kind: ArkDestinationKind;
  /** The bare destination, without URI scheme or query. */
  value: string;
  /** Amount fixed by the destination (BOLT11 amount or BIP-21 `amount=`), in sats. */
  amountSats: number | null;
}

// Ark addresses are bech32m with the `ark` (mainnet) or `tark` (test networks) HRP.
const ARK_ADDRESS = /^t?ark1[02-9ac-hj-np-z]{20,}$/i;
// BOLT11 HRPs: lnbc (mainnet), lntb (testnet), lntbs (signet), lnbcrt (regtest).
const BOLT11 = /^ln(bc|tbs|tb|bcrt)[0-9]*[munp]?1[02-9ac-hj-np-z]+$/i;
// Bech32/bech32m segwit addresses, or legacy base58 (1…, 3…, m…, n…, 2…).
const BITCOIN_ADDRESS =
  /^((bc|tb|bcrt)1[02-9ac-hj-np-z]{8,87}|[13mn2][1-9A-HJ-NP-Za-km-z]{25,34})$/i;

function btcToSats(amount: string | null): number | null {
  if (!amount || !/^\d+(\.\d{1,8})?$/.test(amount)) return null;
  const [whole, frac = ''] = amount.split('.');
  return Number(whole) * 100_000_000 + Number(frac.padEnd(8, '0'));
}

/** BIP-21 `bitcoin:` URI; prefers its `ark=` then `lightning=` parameters. */
function parseBip21(uri: string): ArkDestination | null {
  const body = uri.slice('bitcoin:'.length);
  const [address, query = ''] = body.split('?');
  const params = new URLSearchParams(query);
  const amountSats = btcToSats(params.get('amount'));
  const ark = params.get('ark');
  if (ark && ARK_ADDRESS.test(ark)) return { kind: 'ark', value: ark, amountSats };
  const lightning = params.get('lightning');
  if (lightning && BOLT11.test(lightning)) {
    return { kind: 'bolt11', value: lightning, amountSats: amountSatsFromBolt11(lightning) };
  }
  if (address && BITCOIN_ADDRESS.test(address))
    return { kind: 'bitcoin', value: address, amountSats };
  return null;
}

/** Parse a destination, or null when it is not something an Ark wallet can pay. */
export function parseArkDestination(raw: string): ArkDestination | null {
  const input = raw.trim();
  if (!input) return null;
  if (/^bitcoin:/i.test(input)) return parseBip21(input);
  const bare = stripLightningPrefix(input);
  if (ARK_ADDRESS.test(bare)) return { kind: 'ark', value: bare, amountSats: null };
  if (BOLT11.test(bare)) {
    return { kind: 'bolt11', value: bare, amountSats: amountSatsFromBolt11(bare) };
  }
  if (isLnurlString(bare)) return { kind: 'lnurl', value: bare, amountSats: null };
  if (isLightningAddress(bare) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bare)) {
    return { kind: 'lightningAddress', value: bare.toLowerCase(), amountSats: null };
  }
  if (BITCOIN_ADDRESS.test(bare)) return { kind: 'bitcoin', value: bare, amountSats: null };
  return null;
}

/** Parse a whole-sats amount the user typed. Null for empty, non-integer or non-positive input. */
export function parseSatsInput(text: string): number | null {
  const cleaned = text.replace(/[\s,_]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const sats = Number(cleaned);
  return Number.isSafeInteger(sats) && sats > 0 ? sats : null;
}
