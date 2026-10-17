import AsyncStorage from '@react-native-async-storage/async-storage';
import { perAccountKey } from './perAccountStorage';

// Per-account NIP-171 records kept outside the encrypted ticket table: none
// holds a secret. Each is one JSON blob per account; writes to a blob are
// serialised so concurrent updates (one per group) can't overwrite each other.

/**
 * What the user decided about a group. A group without a record is a pending
 * invitation. `at` is the newest ticket `created_at` the decision covers: a
 * later ticket for a declined or left group is a new invitation.
 */
export interface Nip171GroupStatus {
  status: 'accepted' | 'declined' | 'left';
  at: number;
}

export interface Nip171GroupMeta {
  name?: string;
  picture?: string;
  /** The group identity's kind-10050 DM relays: where its messages go. */
  relays?: string[];
}

function ownerJsonStore<T>(baseKey: string) {
  const chains = new Map<string, Promise<unknown>>();
  /** Throws on a failed read or a corrupt blob; only a missing one is empty. */
  const readStrict = async (owner: string): Promise<Record<string, T>> => {
    const raw = await AsyncStorage.getItem(perAccountKey(baseKey, owner));
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error(`${baseKey}: corrupt record`);
    return parsed as Record<string, T>;
  };
  /** For display: any failure reads as empty. */
  const read = (owner: string): Promise<Record<string, T>> => readStrict(owner).catch(() => ({}));
  /**
   * Read-modify-write, one at a time per account. Returns the new blob.
   * Rejects (writing nothing) if the read or the write fails: an empty
   * stand-in would wipe every other group's record, and these records are
   * what keep a declined or left group from coming back.
   */
  const update = (
    owner: string,
    change: (all: Record<string, T>) => void,
  ): Promise<Record<string, T>> => {
    const run = (chains.get(owner) ?? Promise.resolve()).then(async () => {
      const all = await readStrict(owner);
      change(all);
      await AsyncStorage.setItem(perAccountKey(baseKey, owner), JSON.stringify(all));
      return all;
    });
    chains.set(
      owner,
      run.catch(() => undefined),
    );
    return run;
  };
  const remove = (owner: string): Promise<void> => {
    const run = (chains.get(owner) ?? Promise.resolve()).then(() =>
      AsyncStorage.removeItem(perAccountKey(baseKey, owner)).catch(() => undefined),
    );
    chains.set(
      owner,
      run.catch(() => undefined),
    );
    return run;
  };
  return { read, update, remove };
}

export const nip171StatusStore = ownerJsonStore<Nip171GroupStatus>('nip171_group_status_v1');
export const nip171MetaStore = ownerJsonStore<Nip171GroupMeta>('nip171_group_meta_v1');
