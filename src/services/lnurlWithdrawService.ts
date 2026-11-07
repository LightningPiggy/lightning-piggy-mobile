import { bech32 } from 'bech32';
import { checkRemoteUrl, fetchBounded, PREVIEW_MAX_BYTES } from '../utils/remoteUrlPolicy';

/**
 * Wallet-agnostic LNURL-withdraw resolver. Lightning Piggy is NOT an
 * issuer of LNURL-w links — the user creates one in *their* wallet
 * (LNbits, Alby, Mutiny, …) with the daily / total-cap / wait_time
 * settings *they* want, then pastes the resulting `lnurl1...` /
 * `lnurlw://` / `lightning:LNURL1...` string into Lightning Piggy. We
 * just resolve it via the standard LNURL-w protocol and store it.
 *
 * Used by the Hunt feature (#468). See project memory `No LNbits-
 * specific APIs` for the rationale.
 */

// 20s — prize claims round-trip a relay + the issuer's wallet; 8s was too tight on slow links (#734).
const FETCH_TIMEOUT_MS = 20_000;

export interface LnurlWithdrawParams {
  /** Endpoint receiving k1 + bolt11 as a LUD-03 GET callback. */
  callback: string;
  /** Random nonce the issuer expects echoed back at claim time. */
  k1: string;
  /** Memo / "what is this for" text from the issuer. */
  defaultDescription: string;
  minWithdrawable: number; // millisatoshis per LUD-03
  maxWithdrawable: number; // millisatoshis per LUD-03
}

/** Why an endpoint isn't claimable: it's a pay link (LUD-06 `payRequest`,
 *  which belongs in the Send sheet) or some other / malformed LNURL response. */
export type LnurlWithdrawErrorCode = 'pay-request' | 'not-withdraw';

export class LnurlWithdrawError extends Error {
  readonly code?: LnurlWithdrawErrorCode;
  constructor(message: string, code?: LnurlWithdrawErrorCode) {
    super(message);
    this.name = 'LnurlWithdrawError';
    this.code = code;
  }
}

/**
 * Parse any of the user-pasteable forms into the underlying HTTPS URL:
 *   - bech32: `lnurl1...` / `LNURL1...`
 *   - URI prefix: `lightning:lnurl1...`
 *   - non-bech32 LNURL: `lnurlw://example.com/foo`
 *
 * Returns the resolved `https://` URL or throws.
 */
export const decodeLnurlWithdraw = (input: string): string => {
  let s = input.trim();
  if (!s) throw new LnurlWithdrawError('Empty LNURL');

  // Strip the Lightning URI prefix when present.
  if (/^lightning:/i.test(s)) {
    s = s.slice('lightning:'.length).trim();
  }

  // LUD-17 cleartext forms (`lnurlw://host/path`, and the rare spec-allowed
  // `lnurl://host/path`). Per LUD-17 these map to `http://` for `.onion` Tor
  // hosts and `https://` everywhere else. Decoding stays spec-faithful, but
  // the shared remote URL policy refuses `http:` and `.onion` at fetch time
  // (the app has no Tor transport), so a Tor-only voucher fails with a clear
  // "blocked" error rather than a dangling request. The host is the authority
  // up to the first `/ : ? #`; strip any port before the `.onion` test.
  const cleartextToHttp = (rest: string): string => {
    const host = rest.split(/[/:?#]/, 1)[0].toLowerCase();
    return (host.endsWith('.onion') ? 'http://' : 'https://') + rest;
  };
  if (/^lnurlw:\/\//i.test(s)) {
    return cleartextToHttp(s.slice('lnurlw://'.length));
  }
  if (/^lnurl:\/\//i.test(s)) {
    return cleartextToHttp(s.slice('lnurl://'.length));
  }

  // bech32 form. HRP is "lnurl"; we accept any case but bech32 itself
  // is strict on case so normalise to lower first.
  const lc = s.toLowerCase();
  if (lc.startsWith('lnurl1')) {
    try {
      const decoded = bech32.decode(lc, 2_000); // generous limit — LNURLs > 90 chars
      if (decoded.prefix !== 'lnurl') {
        throw new LnurlWithdrawError(`Unexpected bech32 HRP "${decoded.prefix}"`);
      }
      const bytes = bech32.fromWords(decoded.words);
      const url = new TextDecoder().decode(new Uint8Array(bytes));
      if (!/^https?:\/\//i.test(url)) {
        throw new LnurlWithdrawError('Decoded LNURL is not an HTTP(S) URL');
      }
      return url;
    } catch (e) {
      if (e instanceof LnurlWithdrawError) throw e;
      throw new LnurlWithdrawError(`Could not decode LNURL: ${(e as Error).message}`);
    }
  }

  // Last-ditch: caller pasted a raw https URL of the LNURL endpoint.
  if (/^https?:\/\//i.test(s)) return s;

  throw new LnurlWithdrawError(
    'Not a recognised LNURL — expected lnurl1…, lnurlw://, lightning:LNURL1…, or https://',
  );
};

/**
 * Probe the LNURL-withdraw endpoint and return the issuer's
 * withdrawRequest params. Used at create time so the hider can sanity-
 * check max-withdrawable before saving, and at finder time to drive
 * the celebration screen + claim call.
 */
export const resolveLnurlWithdraw = async (input: string): Promise<LnurlWithdrawParams> => {
  const url = decodeLnurlWithdraw(input);
  const json = await fetchWithdrawJson(url, 'endpoint');

  if (json && typeof json === 'object' && (json as { status?: string }).status === 'ERROR') {
    const reason = (json as { reason?: unknown }).reason;
    throw new LnurlWithdrawError(
      typeof reason === 'string' ? reason : 'Issuer rejected the voucher',
    );
  }

  if (!isWithdrawRequest(json)) {
    const isPayRequest =
      !!json && typeof json === 'object' && (json as { tag?: unknown }).tag === 'payRequest';
    throw new LnurlWithdrawError(
      'LNURL endpoint is not a withdrawRequest (LUD-03)',
      isPayRequest ? 'pay-request' : 'not-withdraw',
    );
  }

  return {
    callback: json.callback,
    k1: json.k1,
    defaultDescription: json.defaultDescription ?? '',
    minWithdrawable: json.minWithdrawable,
    maxWithdrawable: json.maxWithdrawable,
  };
};

interface WithdrawRequest {
  tag: 'withdrawRequest';
  callback: string;
  k1: string;
  defaultDescription?: string;
  minWithdrawable: number;
  maxWithdrawable: number;
}

const isWithdrawRequest = (v: unknown): v is WithdrawRequest => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    r.tag === 'withdrawRequest' &&
    typeof r.callback === 'string' &&
    typeof r.k1 === 'string' &&
    typeof r.minWithdrawable === 'number' &&
    typeof r.maxWithdrawable === 'number' &&
    Number.isSafeInteger(r.minWithdrawable) &&
    Number.isSafeInteger(r.maxWithdrawable) &&
    r.minWithdrawable >= 0 &&
    (r.maxWithdrawable === 0 || r.maxWithdrawable >= r.minWithdrawable) &&
    (r.defaultDescription === undefined || typeof r.defaultDescription === 'string') &&
    isCallbackUrl(r.callback)
  );
};

// The voucher (NFC tag, hunt cache, QR, deep link) and the issuer's callback
// are both someone else's content: same URL policy and bounded transport as
// every other remote fetch (https only, public host, size + time caps,
// https-only redirects). `payment` kind allows the long bolt11 query string.
const isCallbackUrl = (value: string): boolean => checkRemoteUrl(value, { kind: 'payment' }).ok;

async function fetchWithdrawJson(url: string, label: 'endpoint' | 'callback'): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    ({ bytes } = await fetchBounded(url, {
      kind: 'payment',
      maxBytes: PREVIEW_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      redirects: 'https-only',
      maxRedirects: 3,
    }));
  } catch (e) {
    throw new LnurlWithdrawError(`Could not reach LNURL ${label}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new LnurlWithdrawError(`LNURL ${label} did not return JSON`);
  }
}

/** Convenience for UI surfaces — turn millisats into a clean sats display. */
export const msatToSats = (msat: number): number => Math.floor(msat / 1_000);

/**
 * Claim against a resolved LNURL-w. Caller supplies a `getInvoice`
 * callback that produces a bolt11 invoice for `sats` sats — keeps this
 * service wallet-agnostic (we don't import nwcService here, the Hunt
 * screen does the wiring).
 *
 * Returns when the issuer has accepted our invoice (LUD-03 OK status).
 * The actual incoming bolt11 settlement is observed via
 * `WalletContext.lastIncomingPayment` — the celebration overlay is
 * already wired to that, so the finder sees the standard success
 * confetti when the sats land.
 *
 * Throws `LnurlWithdrawError` for protocol-level failures (issuer
 * said no), and a regular Error for transport-level failures.
 */
export const claimLnurlWithdraw = async (
  params: LnurlWithdrawParams,
  getInvoice: (sats: number, memo: string) => Promise<string>,
): Promise<{ sats: number; bolt11: string }> => {
  // Claims `params.maxWithdrawable`. There is no separate amount argument by
  // design: to claim a specific amount, the caller pre-clamps the params so
  // `minWithdrawable === maxWithdrawable === <chosen msats>` (both UI callers do
  // this from the amount picker). With an un-clamped range this claims the max,
  // which is the right default for a single-amount voucher. The bolt11 we
  // generate has the exact amount baked in.
  if (!isWithdrawRequest({ ...params, tag: 'withdrawRequest' })) {
    throw new LnurlWithdrawError('Invalid withdrawal parameters');
  }
  const sats = msatToSats(params.maxWithdrawable);
  if (sats <= 0) {
    throw new LnurlWithdrawError(
      'Issuer reports zero withdrawable — Piggy is sleeping (cooldown not yet expired, or budget exhausted).',
    );
  }
  if (sats * 1000 < params.minWithdrawable) {
    throw new LnurlWithdrawError('Withdrawal range contains no whole-satoshi amount');
  }
  const bolt11 = await getInvoice(sats, params.defaultDescription || 'Hunt Piggy claim');

  const url = new URL(params.callback);
  url.searchParams.set('k1', params.k1);
  url.searchParams.set('pr', bolt11);

  const json = await fetchWithdrawJson(url.toString(), 'callback');
  if (!isOkStatus(json)) {
    const reason = (json as { reason?: string })?.reason;
    throw new LnurlWithdrawError(reason || 'Issuer rejected the invoice');
  }
  return { sats, bolt11 };
};

const isOkStatus = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.status === 'OK';
};
