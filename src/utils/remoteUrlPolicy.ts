import { parsePublicUrl } from './publicUrl';

export const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const PREVIEW_MAX_BYTES = 1024 * 1024;
export const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

type RemoteKind = 'media' | 'preview' | 'relay' | 'blossom' | 'payment';
type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Validate before contacting a URL supplied by remote content. DNS resolution
 * remains platform-owned; this policy cannot prevent DNS rebinding. */
export function checkRemoteUrl(
  value: string,
  { kind, allowPort }: { kind: RemoteKind; allowPort?: number },
): UrlCheck {
  if (
    typeof value !== 'string' ||
    value.length > (kind === 'payment' ? 16384 : 2048) ||
    /[\s\x00-\x1f\x7f]/u.test(value)
  )
    return { ok: false, reason: 'invalid-url' };
  try {
    const url = new URL(value);
    if (url.protocol !== (kind === 'relay' ? 'wss:' : 'https:'))
      return { ok: false, reason: 'scheme' };
    // Check the raw authority too: WHATWG normalises ambiguous host spellings.
    const authority = value.match(/^[a-z]+:\/\/([^/?#]*)/i)?.[1];
    if (!authority || /[@\\%]/.test(authority) || url.username || url.password)
      return { ok: false, reason: 'authority' };
    if (!parsePublicUrl(`${url.protocol}//${authority}`, [kind === 'relay' ? 'wss' : 'https']))
      return { ok: false, reason: 'host' };
    if (url.port && Number(url.port) !== allowPort) return { ok: false, reason: 'port' };
    url.hash = '';
    if (url.href.length > (kind === 'payment' ? 16384 : 2048))
      return { ok: false, reason: 'invalid-url' };
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
}

export function isSafeRelayHint(value: unknown): value is string {
  return typeof value === 'string' && checkRemoteUrl(value, { kind: 'relay' }).ok;
}

interface BoundedOptions {
  maxBytes: number;
  timeoutMs: number;
  redirects: 'https-only';
  maxRedirects: 3;
  headers?: Record<string, string>;
  method?: 'HEAD';
  kind?: 'media' | 'payment';
}

/** Expo's native fetch honours manual redirects and exposes streaming bytes.
 * Fail closed if streaming is unavailable: buffering first cannot enforce a cap. */
export async function fetchBounded(url: string, options: BoundedOptions) {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0
  )
    throw new Error('Invalid fetch budget');
  let expired = false;
  let controller = new AbortController();
  let rejectTimeout: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    rejectTimeout(new Error('Remote fetch timed out'));
  }, options.timeoutMs);
  const run = async () => {
    // Keep pure URL checks independent of Expo's native fetch initialisation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetch: expoFetch } = require('expo/fetch') as typeof import('expo/fetch');
    let current = url;
    for (let hop = 0; hop <= options.maxRedirects; hop++) {
      if (expired) throw new Error('Remote fetch timed out');
      const checked = checkRemoteUrl(current, { kind: options.kind ?? 'media' });
      if (!checked.ok) throw new Error('Blocked remote URL');
      current = checked.url;
      const res = await expoFetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        credentials: 'omit',
        ...(options.method ? { method: options.method } : {}),
        headers: options.headers,
      });
      const redirect = res.status >= 300 && res.status < 400;
      if (
        (!redirect && res.redirected) ||
        (res.url && !checkRemoteUrl(res.url, { kind: options.kind ?? 'media' }).ok)
      )
        throw new Error('Unvalidated remote redirect');
      if (redirect) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Missing redirect location');
        current = new URL(location, current).href;
        controller.abort();
        controller = new AbortController();
        continue;
      }
      if (!res.ok) throw new Error(`Remote fetch failed (${res.status})`);
      const length = res.headers.get('content-length');
      if (length && Number(length) > options.maxBytes) throw new Error('Remote body exceeds limit');
      if (options.method === 'HEAD')
        return { bytes: new Uint8Array(), url: current, headers: res.headers };
      if (!res.body?.getReader) throw new Error('Remote streaming unavailable');
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (expired) throw new Error('Remote fetch timed out');
          if (done) break;
          total += value.byteLength;
          if (total > options.maxBytes) throw new Error('Remote body exceeds limit');
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, url: current, headers: res.headers };
    }
    throw new Error('Too many remote redirects');
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
