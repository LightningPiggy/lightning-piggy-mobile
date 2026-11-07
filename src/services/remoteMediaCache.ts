import {
  cacheDirectory,
  getInfoAsync,
  writeAsStringAsync,
  makeDirectoryAsync,
  moveAsync,
  deleteAsync,
  readDirectoryAsync,
} from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { checkRemoteUrl, fetchBounded, MEDIA_MAX_BYTES } from '../utils/remoteUrlPolicy';

const pending = new Map<string, Promise<string>>();
const publishing = new Map<string, Set<Promise<void>>>();
const generations = new Map<string, number>();
// When each cached file was last (re)written, so a decode error reported
// against an older copy can't delete a newer download at the same path.
const writtenAt = new Map<string, number>();
let activeOwner: string | null = null;
const hash = (value: string) => bytesToHex(sha256(utf8ToBytes(value)));
const generation = (owner: string) => generations.get(owner) ?? 0;
const ownerDirectory = (owner: string) => `${cacheDirectory}remote-media-${hash(owner)}/`;

export function setRemoteMediaOwner(owner: string | null): void {
  const next = owner?.toLowerCase() ?? null;
  if (next === activeOwner) return;
  if (activeOwner) generations.set(activeOwner, generation(activeOwner) + 1);
  activeOwner = next;
}

/** Cache only bounded downloads; native image/audio loaders receive local URIs. */
export async function resolveRemoteMedia(url: string, maxBytes = MEDIA_MAX_BYTES): Promise<string> {
  const checked = checkRemoteUrl(url, { kind: 'media' });
  if (!checked.ok) throw new Error('Blocked remote URL');
  const owner = activeOwner;
  if (!owner || !cacheDirectory) throw new Error('Media cache unavailable');
  const gen = generation(owner);
  const assertCurrent = () => {
    if (activeOwner !== owner || generation(owner) !== gen)
      throw new Error('Media cache cancelled');
  };
  const dir = ownerDirectory(owner);
  const uri = `${dir}${hash(`${maxBytes}:${checked.url}`)}`;
  const key = `${uri}:${gen}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = (async () => {
    if (!(await getInfoAsync(uri)).exists) {
      const { bytes } = await fetchBounded(checked.url, {
        maxBytes,
        timeoutMs: 30000,
        redirects: 'https-only',
        maxRedirects: 3,
      });
      assertCurrent();
      const publish = (async () => {
        const tmp = `${uri}.${gen}-${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await makeDirectoryAsync(dir, { intermediates: true });
          await writeAsStringAsync(tmp, Buffer.from(bytes).toString('base64'), {
            encoding: 'base64',
          });
          assertCurrent();
          await moveAsync({ from: tmp, to: uri });
          writtenAt.set(uri, Date.now());
        } finally {
          await deleteAsync(tmp, { idempotent: true });
        }
      })();
      let writes = publishing.get(owner);
      if (!writes) publishing.set(owner, (writes = new Set()));
      writes.add(publish);
      try {
        await publish;
      } finally {
        writes.delete(publish);
        if (!writes.size) publishing.delete(owner);
      }
    }
    assertCurrent();
    return uri;
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

/**
 * Forget the active account's cached copy of `url` (same key as
 * resolveRemoteMedia), so the next resolve downloads it again. For a file
 * that downloaded but couldn't be decoded: a retry must not reuse it.
 * `resolvedAt` is when the caller got the file: if another view of the same
 * URL has re-downloaded it since then, the newer copy stays.
 */
export async function evictRemoteMedia(
  url: string,
  maxBytes = MEDIA_MAX_BYTES,
  resolvedAt = Infinity,
): Promise<void> {
  const checked = checkRemoteUrl(url, { kind: 'media' });
  const owner = activeOwner;
  if (!checked.ok || !owner || !cacheDirectory) return;
  const uri = `${ownerDirectory(owner)}${hash(`${maxBytes}:${checked.url}`)}`;
  if ((writtenAt.get(uri) ?? 0) > resolvedAt) return;
  writtenAt.delete(uri);
  await deleteAsync(uri, { idempotent: true });
}

/** Retire the account immediately; late downloads cannot publish plaintext. */
export async function wipeRemoteMediaForOwner(pubkey: string): Promise<void> {
  const owner = pubkey.toLowerCase();
  generations.set(owner, generation(owner) + 1);
  if (activeOwner === owner) activeOwner = null;
  await Promise.allSettled([...(publishing.get(owner) ?? [])]);
  if (!cacheDirectory) return;
  await deleteAsync(ownerDirectory(owner), { idempotent: true });
  // Pre-account cache files cannot be attributed to an owner: remove on any logout.
  for (const name of await readDirectoryAsync(cacheDirectory)) {
    if (/^remote-[a-f0-9]{64}$/.test(name))
      await deleteAsync(`${cacheDirectory}${name}`, { idempotent: true });
  }
}
