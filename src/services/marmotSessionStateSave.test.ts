// #1754 end to end with real MLS: after each kind of commit the session makes
// (create + invite, add, rename, admins, remove), a failed group-state save —
// reported by marmot-ts as `persistence.kind === 'failed'` — is retried and
// lands, and one that keeps failing marks the chat for Repair. Plain sends
// need no save and are left alone. WebCrypto removed (Hermes has none).
import type { NostrNetworkInterface } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent } from 'nostr-tools';

import { MARMOT_CHAT_KIND, buildMarmotRumor, toMlsGroupId } from './marmotSession';
import { makeRelay, makeSession, waitFor, waitForSettled } from './marmotSessionTestKit';
import { createMemoryMarmotBackend, type MarmotKvBackend } from './marmotStore';
import { getMarmotUnsavedStateSnapshot } from './marmotUnsavedStateStore';

/**
 * Alice's storage, where the group-state write right after her next commit
 * publish fails `failures` times. Armed by `failNextSave`; the publish of the
 * commit (kind 445) is what turns it on, so the write that fails is exactly
 * marmot-ts's post-confirmation save.
 */
function flakyStorage(relay: ReturnType<typeof makeRelay>) {
  const inner = createMemoryMarmotBackend();
  let armed = 0;
  let failures = 0;
  /** What storage held for each group when its save last failed. */
  const atFailure = new Map<string, string | null>();
  const backend: MarmotKvBackend = {
    owner: inner.owner,
    get: (ns, k) => inner.get(ns, k),
    remove: (ns, k) => inner.remove(ns, k),
    clear: (ns) => inner.clear(ns),
    keys: (ns) => inner.keys(ns),
    async set(ns, k, v) {
      if (ns === 'groups' && failures > 0) {
        failures--;
        atFailure.set(k, await inner.get(ns, k));
        throw new Error('disk full');
      }
      return inner.set(ns, k, v);
    },
  };
  const network = {
    ...relay.network,
    async publish(relays: string[], event: NostrEvent) {
      const response = await relay.network.publish(relays, event);
      if (armed > 0 && event.kind === 445) [failures, armed] = [armed, 0];
      return response;
    },
  } as unknown as NostrNetworkInterface;
  return {
    backend,
    network,
    inner,
    atFailure,
    failNextSave: (times: number) => (armed = times),
    stopFailing: () => ([armed, failures] = [0, 0]),
  };
}

const RETRY_MS = [20, 20, 20];

describe('MarmotSession: a failed group-state save after a commit (#1754, no WebCrypto)', () => {
  const realSubtle = globalThis.crypto.subtle;
  beforeAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true }),
  );
  afterAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: realSubtle, configurable: true }),
  );
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('retries the save at every commit call site, and marks for Repair only when it keeps failing', async () => {
    const relay = makeRelay();
    const storage = flakyStorage(relay);
    const alice = makeSession(relay, undefined, 'nsec', {
      backend: storage.backend,
      network: storage.network,
      stateSaveRetryMs: RETRY_MS,
    });
    const [bob, carol] = [makeSession(relay), makeSession(relay)];
    await Promise.all([alice, bob, carol].map((p) => p.session.start()));
    await waitFor(
      () =>
        relay.events.filter(
          (e) => e.kind === 30443 && [bob.pubkey, carol.pubkey].includes(e.pubkey),
        ).length === 2,
    );
    const saves = alice.session.stateSaves;
    const check = jest.spyOn(saves, 'check');
    const failedSeen = () =>
      check.mock.calls.some(([, results]) => results.some((r) => r.persistence.kind === 'failed'));

    /** Run `op` with its commit's save failing once: the retry must land. */
    async function recovers(name: string, op: () => Promise<unknown>) {
      check.mockClear();
      storage.atFailure.clear();
      storage.failNextSave(1);
      await op();
      const id = toMlsGroupId(groupId);
      expect([name, failedSeen(), storage.atFailure.has(id)]).toEqual([name, true, true]);
      await saves.settled(id);
      expect([name, saves.isUnsaved(id)]).toEqual([name, false]);
      // The retry wrote the group's new state over what the failed write left.
      const now = await storage.inner.get('groups', id);
      expect([name, now !== null && now !== storage.atFailure.get(id)]).toEqual([name, true]);
      await waitForSettled(alice.session, groupId);
    }
    let groupId = '';

    // createGroup → inviteDevices → sendIntent (the invite commit).
    await recovers(
      'createGroup',
      async () => (groupId = (await alice.session.createGroup('Piggy Bank', [bob.pubkey])).id),
    );
    await recovers('rename', () => alice.session.rename(groupId, 'Oink Club'));
    await recovers('setAdmins', () =>
      alice.session.setAdmins(groupId, (current) => [...current, bob.pubkey]),
    );
    await recovers('addMembers', () => alice.session.addMembers(groupId, [carol.pubkey]));
    await recovers('removeMember', () => alice.session.removeMember(groupId, carol.pubkey));

    // A plain send: no save to make, nothing to retry or mark.
    check.mockClear();
    const save = jest.spyOn(storage.backend, 'set');
    const msg = buildMarmotRumor(alice.pubkey, { kind: MARMOT_CHAT_KIND, content: 'oink' });
    await alice.session.sendRumor(groupId, msg);
    expect(check).toHaveBeenCalledTimes(1);
    expect(failedSeen()).toBe(false);
    expect(save.mock.calls.some(([ns]) => ns === 'unsavedState')).toBe(false);
    save.mockRestore();

    // The save keeps failing: the chat is marked for Repair, in storage and the UI.
    const mlsId = toMlsGroupId(groupId);
    storage.failNextSave(Infinity);
    await alice.session.rename(groupId, 'Still Oinking');
    await saves.settled(mlsId);
    expect(saves.isUnsaved(mlsId)).toBe(true);
    const snapshot = getMarmotUnsavedStateSnapshot();
    expect(snapshot.owner).toBe(alice.pubkey);
    expect(snapshot.chatIds.has(mlsId)).toBe(true);
    expect(await storage.inner.get('unsavedState', mlsId)).not.toBeNull();

    // Storage recovers; the next commit saves fine and the mark clears.
    storage.stopFailing();
    await waitForSettled(alice.session, groupId);
    await alice.session.rename(groupId, 'Oink Club');
    expect(saves.isUnsaved(mlsId)).toBe(false);
    expect(getMarmotUnsavedStateSnapshot().chatIds.has(mlsId)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(await storage.inner.get('unsavedState', mlsId)).toBeNull();

    for (const p of [alice, bob, carol]) p.session.stop();
    expect(getMarmotUnsavedStateSnapshot().owner).toBeNull();
  }, 120_000);
});
