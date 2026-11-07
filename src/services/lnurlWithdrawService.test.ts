import { bech32 } from 'bech32';
import { fetch as expoFetch } from 'expo/fetch';
import {
  claimLnurlWithdraw,
  decodeLnurlWithdraw,
  LnurlWithdrawError,
  msatToSats,
  resolveLnurlWithdraw,
} from './lnurlWithdrawService';
import { PREVIEW_MAX_BYTES } from '../utils/remoteUrlPolicy';

// The withdraw flow goes through the shared bounded transport, which uses
// Expo's native fetch (manual redirects + streaming bytes).
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
const fetchMock = expoFetch as unknown as jest.Mock;

const encodeLnurl = (url: string): string => {
  const bytes = new TextEncoder().encode(url);
  const words = bech32.toWords(Array.from(bytes));
  return bech32.encode('lnurl', words, 2_000);
};

/** A streaming response the bounded transport can consume. */
function response(
  body: unknown,
  { status = 200, headers = {} as Record<string, string> } = {},
  chunks?: Uint8Array[],
) {
  const data = chunks ?? [
    new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
  ];
  let index = 0;
  const reader = {
    read: jest.fn(async () =>
      index < data.length ? { done: false, value: data[index++] } : { done: true },
    ),
    cancel: jest.fn(async () => {}),
    releaseLock: jest.fn(),
  };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    url: '',
    redirected: false,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    body: { getReader: () => reader },
    reader,
  };
}

const withdrawRequest = {
  tag: 'withdrawRequest',
  callback: 'https://example.com/cb',
  k1: 'deadbeef',
  defaultDescription: '🐷 Birthday Piggy',
  minWithdrawable: 21_000,
  maxWithdrawable: 21_000,
};

beforeEach(() => fetchMock.mockReset());

describe('decodeLnurlWithdraw', () => {
  it('decodes a bech32 lnurl1 string', () => {
    const url = 'https://example.com/api/withdraw/abc';
    expect(decodeLnurlWithdraw(encodeLnurl(url))).toBe(url);
  });

  it('accepts uppercase bech32 (LNURL1…)', () => {
    const url = 'https://example.com/api/withdraw/abc';
    expect(decodeLnurlWithdraw(encodeLnurl(url).toUpperCase())).toBe(url);
  });

  it('strips a `lightning:` URI prefix', () => {
    const url = 'https://example.com/withdraw';
    expect(decodeLnurlWithdraw(`lightning:${encodeLnurl(url).toUpperCase()}`)).toBe(url);
  });

  it('handles a `lnurlw://` cleartext URI', () => {
    expect(decodeLnurlWithdraw('lnurlw://example.com/withdraw/abc')).toBe(
      'https://example.com/withdraw/abc',
    );
  });

  it('passes through a raw https URL', () => {
    expect(decodeLnurlWithdraw('https://example.com/withdraw/abc')).toBe(
      'https://example.com/withdraw/abc',
    );
  });

  it('throws on empty input', () => {
    expect(() => decodeLnurlWithdraw('')).toThrow(LnurlWithdrawError);
    expect(() => decodeLnurlWithdraw('   ')).toThrow(LnurlWithdrawError);
  });

  it('throws on a non-LNURL string', () => {
    expect(() => decodeLnurlWithdraw('not-an-lnurl')).toThrow(LnurlWithdrawError);
  });
});

describe('resolveLnurlWithdraw', () => {
  it('returns withdraw params on a valid response', async () => {
    fetchMock.mockResolvedValueOnce(response(withdrawRequest));

    const params = await resolveLnurlWithdraw('lnurlw://example.com/w');
    expect(params).toEqual({
      callback: 'https://example.com/cb',
      k1: 'deadbeef',
      defaultDescription: '🐷 Birthday Piggy',
      minWithdrawable: 21_000,
      maxWithdrawable: 21_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/w');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  });

  it('throws when the JSON is not a withdrawRequest', async () => {
    fetchMock.mockResolvedValueOnce(response({ tag: 'payRequest', callback: 'https://x' }));
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toThrow(
      /not a withdrawRequest/i,
    );
  });

  it('tags a payRequest so the claim sheet can hand it to the Send sheet', async () => {
    fetchMock.mockResolvedValueOnce(response({ tag: 'payRequest', callback: 'https://x' }));
    await expect(resolveLnurlWithdraw('lnurl://example.com/p')).rejects.toMatchObject({
      name: 'LnurlWithdrawError',
      code: 'pay-request',
    });
  });

  it('rejects a withdrawRequest whose callback is not an https public host', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ ...withdrawRequest, callback: 'http://example.com/cb' }),
    );
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toThrow(
      /not a withdrawRequest/i,
    );
  });

  it('tags any other non-withdraw response as not-withdraw', async () => {
    fetchMock.mockResolvedValueOnce(response({ tag: 'channelRequest' }));
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toMatchObject({
      code: 'not-withdraw',
    });
  });

  it('throws when the endpoint returns non-OK', async () => {
    fetchMock.mockResolvedValueOnce(response('', { status: 404 }));
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toThrow(/404/);
  });

  it('throws when the endpoint does not return JSON', async () => {
    fetchMock.mockResolvedValueOnce(response('<html>'));
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toThrow(
      /did not return JSON/i,
    );
  });

  it('surfaces an expired voucher reason at resolution', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 'ERROR', reason: 'Voucher expired' }));
    await expect(resolveLnurlWithdraw('lnurlw://example.com/voucher')).rejects.toThrow(
      'Voucher expired',
    );
  });

  it.each([
    'lnurlw://127.0.0.1/w',
    'lnurlw://192.168.1.1:8080/w',
    'lnurlw://wallet.local/w',
    'lnurlw://metadata.google.internal/w',
    'lnurlw://hidden.onion/w', // LUD-17 maps this to http://, which the policy refuses
    'https://example.com:8443/w',
    'https://user:pw@example.com/w',
    encodeLnurl('http://example.com/w'),
  ])('blocks voucher endpoint %s before any request', async (input) => {
    await expect(resolveLnurlWithdraw(input)).rejects.toThrow(/Blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows an https redirect to a public host, re-checking the policy', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response('', { status: 302, headers: { location: 'https://cdn.example.com/w2' } }),
      )
      .mockResolvedValueOnce(response(withdrawRequest));
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).resolves.toMatchObject({
      k1: 'deadbeef',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.com/w2');
  });

  it.each(['http://example.com/w2', 'https://10.0.0.1/w2', 'https://example.com:8443/w2'])(
    'never follows a redirect to %s',
    async (location) => {
      fetchMock.mockResolvedValueOnce(response('', { status: 302, headers: { location } }));
      await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toThrow(/Blocked/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an oversized declared body before reading it', async () => {
    const res = response(withdrawRequest, {
      headers: { 'content-length': String(PREVIEW_MAX_BYTES + 1) },
    });
    fetchMock.mockResolvedValueOnce(res);
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toThrow(/limit/);
    expect(res.reader.read).not.toHaveBeenCalled();
  });

  it('rejects a streamed body that overruns the cap and cancels the reader', async () => {
    const res = response(null, {}, [new Uint8Array(PREVIEW_MAX_BYTES), new Uint8Array(1)]);
    fetchMock.mockResolvedValueOnce(res);
    await expect(resolveLnurlWithdraw('lnurlw://example.com/w')).rejects.toThrow(/limit/);
    expect(res.reader.cancel).toHaveBeenCalled();
  });
});

describe('msatToSats', () => {
  it('floors to whole sats', () => {
    expect(msatToSats(0)).toBe(0);
    expect(msatToSats(999)).toBe(0);
    expect(msatToSats(1_000)).toBe(1);
    expect(msatToSats(21_500)).toBe(21);
    expect(msatToSats(1_000_000)).toBe(1_000);
  });
});

describe('claimLnurlWithdraw', () => {
  const params = {
    callback: 'https://example.com/cb',
    k1: 'deadbeef',
    defaultDescription: 'Geo-Cache 1',
    minWithdrawable: 21_000,
    maxWithdrawable: 21_000,
  };

  it('happy path — sends k1+pr to callback, returns sats + bolt11', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 'OK' }));
    const getInvoice = jest.fn(async () => 'lnbcfakeinvoice');

    const result = await claimLnurlWithdraw(params, getInvoice);
    expect(result).toEqual({ sats: 21, bolt11: 'lnbcfakeinvoice' });
    expect(getInvoice).toHaveBeenCalledWith(21, 'Geo-Cache 1');
    // URL should carry both query params.
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('k1=deadbeef');
    expect(calledUrl).toContain('pr=lnbcfakeinvoice');
  });

  it('refuses to claim when maxWithdrawable is zero (cooldown / budget)', async () => {
    const getInvoice = jest.fn();
    await expect(claimLnurlWithdraw({ ...params, maxWithdrawable: 0 }, getInvoice)).rejects.toThrow(
      /sleeping/i,
    );
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it('surfaces issuer ERROR.reason verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ status: 'ERROR', reason: 'wait_time not yet expired' }),
    );
    const getInvoice = jest.fn(async () => 'lnbcfake');
    await expect(claimLnurlWithdraw(params, getInvoice)).rejects.toThrow(
      'wait_time not yet expired',
    );
  });

  it('throws on non-OK HTTP', async () => {
    fetchMock.mockResolvedValueOnce(response('', { status: 503 }));
    const getInvoice = jest.fn(async () => 'lnbcfake');
    await expect(claimLnurlWithdraw(params, getInvoice)).rejects.toThrow(/503/);
  });

  it('throws if the response is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(response('bad json'));
    const getInvoice = jest.fn(async () => 'lnbcfake');
    await expect(claimLnurlWithdraw(params, getInvoice)).rejects.toThrow(/did not return JSON/i);
  });

  it.each([
    'http://example.com/cb',
    'https://10.0.0.1/cb',
    'https://issuer.local/cb',
    'https://example.com:8443/cb',
  ])('never mints an invoice for a blocked callback %s', async (callback) => {
    const getInvoice = jest.fn(async () => 'lnbcfake');
    await expect(claimLnurlWithdraw({ ...params, callback }, getInvoice)).rejects.toThrow(
      /Invalid withdrawal parameters/,
    );
    expect(getInvoice).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never follows a callback redirect off https', async () => {
    fetchMock.mockResolvedValueOnce(
      response('', { status: 302, headers: { location: 'http://example.com/cb2' } }),
    );
    await expect(claimLnurlWithdraw(params, async () => 'lnbcfake')).rejects.toThrow(/Blocked/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized callback response', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ status: 'OK' }, { headers: { 'content-length': String(PREVIEW_MAX_BYTES + 1) } }),
    );
    await expect(claimLnurlWithdraw(params, async () => 'lnbcfake')).rejects.toThrow(/limit/);
  });
});

describe('withdraw validation before invoice creation', () => {
  const params = {
    callback: 'https://example.com/cb?token=fixture',
    k1: 'fixture',
    defaultDescription: 'Voucher',
    minWithdrawable: 21000,
    maxWithdrawable: 21000,
  };
  it.each([
    { callback: 'javascript:alert(1)' },
    { callback: 'not-a-url' },
    { minWithdrawable: -1 },
    { maxWithdrawable: NaN },
    { minWithdrawable: 22000 },
    { minWithdrawable: 21500, maxWithdrawable: 21999 },
  ])('rejects malformed or unrepresentable parameters: %j', async (override) => {
    const invoice = jest.fn();
    await expect(claimLnurlWithdraw({ ...params, ...override }, invoice)).rejects.toThrow();
    expect(invoice).not.toHaveBeenCalled();
  });
  it('preserves callback query parameters and URL-encodes the invoice', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 'OK' }));
    await claimLnurlWithdraw(params, async () => 'fixture+invoice');
    const callback = new URL(fetchMock.mock.calls[0][0]);
    expect(callback.searchParams.get('token')).toBe('fixture');
    expect(callback.searchParams.get('k1')).toBe('fixture');
    expect(callback.searchParams.get('pr')).toBe('fixture+invoice');
  });
});
