import { fetch as expoFetch } from 'expo/fetch';
import { checkRemoteUrl, fetchBounded } from './remoteUrlPolicy';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
const mockFetch = expoFetch as unknown as jest.Mock;
const options = { maxBytes: 4, timeoutMs: 100, redirects: 'https-only', maxRedirects: 3 } as const;

function response(chunks: Uint8Array[], length?: string) {
  let index = 0;
  const reader = {
    read: jest.fn(async () =>
      index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
    ),
    cancel: jest.fn(async () => {}),
    releaseLock: jest.fn(),
  };
  return {
    status: 200,
    ok: true,
    url: '',
    redirected: false,
    headers: { get: (name: string) => (name === 'content-length' ? length : null) },
    body: { getReader: () => reader },
    reader,
  };
}

beforeEach(() => mockFetch.mockReset());

it.each([
  'http://example.com/',
  'ftp://example.com/',
  'file:///image.jpg',
  '',
  'https://',
  'https://u:p@example.com/',
  'https://@example.com/',
  'https://localhost/',
  'https://localhost./',
  'https://device.local/',
  'https://example.onion/',
  'https://metadata.google.internal/',
  'https://service.internal/',
  'https://169.254.169.254/',
  'https://0.0.0.0/',
  'https://10.1.2.3/',
  'https://172.16.1.1/',
  'https://192.168.1.1/',
  'https://127.0.0.1/',
  'https://127.1/',
  'https://2130706433/',
  'https://169.254.1.1/',
  'https://224.0.0.1/',
  'https://255.255.255.255/',
  'https://[::]/',
  'https://[::1]/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[fdff::1]/',
  'https://[ff02::1]/',
  'https://[::ffff:8.8.8.8]/',
  'https://[::ffff:0808:0808]/',
  'https://example.com:8443/',
  'https://exa\u0000mple.com/',
  'https://exa\nmple.com/',
  'https://exa mple.com/',
  'https://example%00.com/',
  'https://example.com/' + 'a'.repeat(2048),
])('rejects %s without fetching', async (url) => {
  expect(checkRemoteUrl(url, { kind: 'media' }).ok).toBe(false);
  await expect(fetchBounded(url, options)).rejects.toThrow();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  'https://example.com/a',
  'https://example.com:443/a',
  'https://8.8.8.8/a',
  'https://[2606:4700::1111]/a',
])('accepts %s for each HTTPS kind', (url) => {
  for (const kind of ['media', 'preview', 'blossom'] as const)
    expect(checkRemoteUrl(url, { kind }).ok).toBe(true);
});
it('requires wss for relays and only permits an explicitly allowed alternate port', () => {
  expect(checkRemoteUrl('wss://relay.example/', { kind: 'relay' }).ok).toBe(true);
  expect(checkRemoteUrl('ws://relay.example/', { kind: 'relay' }).ok).toBe(false);
  expect(checkRemoteUrl('https://relay.example/', { kind: 'relay' }).ok).toBe(false);
  expect(checkRemoteUrl('wss://relay.example:8443', { kind: 'relay' }).ok).toBe(false);
  expect(checkRemoteUrl('wss://relay.example:8443', { kind: 'relay', allowPort: 8443 }).ok).toBe(
    true,
  );
  expect(checkRemoteUrl('wss://relay.example:8444', { kind: 'relay', allowPort: 8443 }).ok).toBe(
    false,
  );
});
it('rejects an oversize Content-Length before reading', async () => {
  const res = response([], '5');
  mockFetch.mockResolvedValue(res);
  await expect(fetchBounded('https://example.com/', options)).rejects.toThrow('limit');
  expect(res.reader.read).not.toHaveBeenCalled();
});
it('rejects a streamed overrun and cancels the reader', async () => {
  const res = response([new Uint8Array(3), new Uint8Array(2)], '1');
  mockFetch.mockResolvedValue(res);
  await expect(fetchBounded('https://example.com/', options)).rejects.toThrow('limit');
  expect(res.reader.cancel).toHaveBeenCalled();
});
it('accepts bytes exactly at the cap', async () => {
  mockFetch.mockResolvedValue(response([new Uint8Array([1, 2]), new Uint8Array([3, 4])], '4'));
  expect((await fetchBounded('https://example.com/', options)).bytes).toEqual(
    new Uint8Array([1, 2, 3, 4]),
  );
});
it('refuses a non-streaming runtime', async () => {
  mockFetch.mockResolvedValue({ ...response([]), body: null });
  await expect(fetchBounded('https://example.com/', options)).rejects.toThrow('streaming');
});
it.each(['http://example.com/', 'https://127.0.0.1/', 'https://example.com:8443/'])(
  'never requests a blocked redirect %s',
  async (location) => {
    mockFetch.mockResolvedValue({ ...response([]), status: 302, headers: { get: () => location } });
    await expect(fetchBounded('https://example.com/', options)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  },
);
it('aborts and rejects a stalled fetch at the deadline', async () => {
  mockFetch.mockImplementation(() => new Promise(() => {}));
  await expect(fetchBounded('https://example.com/', options)).rejects.toThrow('timed out');
  expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
});
it.each([0, -1, NaN, 1.5])('rejects invalid byte budget %s', async (maxBytes) => {
  await expect(fetchBounded('https://example.com/', { ...options, maxBytes })).rejects.toThrow(
    'budget',
  );
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([0, -1, NaN, Infinity])('rejects invalid timeout %s before fetching', async (timeoutMs) => {
  await expect(fetchBounded('https://example.com/', { ...options, timeoutMs })).rejects.toThrow(
    'budget',
  );
  expect(mockFetch).not.toHaveBeenCalled();
});
it('aborts a stalled stream at the deadline', async () => {
  const res = response([]);
  res.reader.read.mockImplementation(() => new Promise(() => {}));
  mockFetch.mockResolvedValue(res);
  await expect(fetchBounded('https://example.com/', options)).rejects.toThrow('timed out');
  expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
});

it('bounds optional HEAD metadata using the same URL/redirect policy without reading a body', async () => {
  const res = response([], '3');
  mockFetch.mockResolvedValue(res);
  const result = await fetchBounded('https://example.com/a.pdf', { ...options, method: 'HEAD' });
  expect(result.headers.get('content-length')).toBe('3');
  expect(res.reader.read).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledWith(
    'https://example.com/a.pdf',
    expect.objectContaining({ method: 'HEAD' }),
  );
});
