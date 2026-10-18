// marmot-ts `GenericKeyValueStore`s backed by the encrypted local DB.
//
// One `marmot_kv` table (localDb.ts) holds every store, partitioned by
// (owner, namespace) so multi-account devices never share MLS state. Values
// are JSON with Uint8Array / bigint tagged — MLS state is mostly bytes, and
// the library's records (key packages, invites) nest them inside objects.

import type { GenericKeyValueStore } from '@internet-privacy/marmot-ts/utils';

import { getLocalDb } from './localDb';

const U8 = '$u8';
const BIGINT = '$bi';

export function encodeMarmotValue(value: unknown): string {
  return JSON.stringify(value, function (key, v) {
    // Read the raw property: JSON.stringify has already run toJSON() on `v`.
    const raw = key === '' ? v : (this as Record<string, unknown>)[key];
    if (raw instanceof Uint8Array) return { [U8]: Buffer.from(raw).toString('base64') };
    if (typeof raw === 'bigint') return { [BIGINT]: raw.toString() };
    return v;
  });
}

export function decodeMarmotValue<T>(json: string): T {
  return JSON.parse(json, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === U8) return new Uint8Array(Buffer.from(v[U8], 'base64'));
      if (keys.length === 1 && keys[0] === BIGINT) return BigInt(v[BIGINT]);
    }
    return v;
  }) as T;
}

/** Minimal row store the KV adapter needs — op-sqlite in the app, a Map in tests. */
export interface MarmotKvBackend {
  /** Stable account identity across independently created SQL adapters. */
  readonly owner?: string;
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
  clear(namespace: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;
}

export function createSqliteMarmotBackend(owner: string): MarmotKvBackend {
  return {
    owner,
    async get(namespace, key) {
      const db = await getLocalDb();
      const res = await db.execute(
        'SELECT value FROM marmot_kv WHERE owner = ? AND namespace = ? AND key = ?;',
        [owner, namespace, key],
      );
      const v = res.rows?.[0]?.value;
      return typeof v === 'string' ? v : null;
    },
    async set(namespace, key, value) {
      const db = await getLocalDb();
      await db.execute(
        'INSERT OR REPLACE INTO marmot_kv (owner, namespace, key, value) VALUES (?, ?, ?, ?);',
        [owner, namespace, key, value],
      );
    },
    async remove(namespace, key) {
      const db = await getLocalDb();
      await db.execute('DELETE FROM marmot_kv WHERE owner = ? AND namespace = ? AND key = ?;', [
        owner,
        namespace,
        key,
      ]);
    },
    async clear(namespace) {
      const db = await getLocalDb();
      await db.execute('DELETE FROM marmot_kv WHERE owner = ? AND namespace = ?;', [
        owner,
        namespace,
      ]);
    },
    async keys(namespace) {
      const db = await getLocalDb();
      const res = await db.execute('SELECT key FROM marmot_kv WHERE owner = ? AND namespace = ?;', [
        owner,
        namespace,
      ]);
      return (res.rows ?? []).map((r) => String(r.key));
    },
  };
}

/**
 * Accounts on this device holding state for one MLS group (read-only): its
 * group state, or rows in its history / media-key namespaces (which outlive a
 * leave). Used by the group-history migration (#1240) to attribute legacy
 * device-wide blobs to their owners.
 */
export async function listMarmotOwnersForGroup(mlsGroupIdHex: string): Promise<string[]> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT DISTINCT owner FROM marmot_kv
       WHERE (namespace = 'groups' AND key = ?) OR namespace = ? OR namespace = ?;`,
    [mlsGroupIdHex, `history:${mlsGroupIdHex}`, `mediaKeys:${mlsGroupIdHex}`],
  );
  return (res.rows ?? []).map((r) => String(r.owner));
}

/** Delete every Marmot row for `owner` (per-account sign-out). */
export async function deleteMarmotStateForOwner(owner: string): Promise<void> {
  const db = await getLocalDb();
  await db.execute('DELETE FROM marmot_kv WHERE owner = ?;', [owner]);
}

export function createMarmotKvStore<T>(
  backend: MarmotKvBackend,
  namespace: string,
): GenericKeyValueStore<T> {
  return {
    async getItem(key) {
      const raw = await backend.get(namespace, key);
      return raw === null ? null : decodeMarmotValue<T>(raw);
    },
    async setItem(key, value) {
      await backend.set(namespace, key, encodeMarmotValue(value));
      return value;
    },
    removeItem: (key) => backend.remove(namespace, key),
    clear: () => backend.clear(namespace),
    keys: () => backend.keys(namespace),
  };
}

export function createMemoryMarmotBackend(): MarmotKvBackend {
  const data = new Map<string, Map<string, string>>();
  const ns = (n: string) => data.get(n) ?? data.set(n, new Map()).get(n)!;
  return {
    get: async (n, k) => ns(n).get(k) ?? null,
    set: async (n, k, v) => void ns(n).set(k, v),
    remove: async (n, k) => void ns(n).delete(k),
    clear: async (n) => void ns(n).clear(),
    keys: async (n) => [...ns(n).keys()],
  };
}
