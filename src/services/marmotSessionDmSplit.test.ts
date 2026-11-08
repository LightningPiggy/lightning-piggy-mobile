// A 1:1 that split into two MLS groups — the 1.6.0 field bug, reproduced with
// real MLS crypto (WebCrypto removed — Hermes has none). Ben has two installs
// of one account; each started the chat with Emily at the same time, so Ben's
// installs each sit in a different group and Emily is in both. The pure
// ranking / relay rules are unit-tested in marmotDmChoice.test.ts.
import * as dmChoice from './marmotDmChoice';
import { DM_DEVICE_SYNC_COOLDOWN_MS } from './marmotDmDeviceSync';
import { buildMarmotRumor, MARMOT_CHAT_KIND, type MarmotSession } from './marmotSession';
import {
  RELAY,
  makeInstall,
  makeRelay,
  makeSession,
  unwrapWelcomes,
  waitFor,
} from './marmotSessionTestKit';

const OPTS = { dmDeviceSyncWaitMs: 60_000 };
type Install = ReturnType<typeof makeSession>;

describe('MarmotSession: a split 1:1 converges (no WebCrypto)', () => {
  const realSubtle = globalThis.crypto.subtle;
  const realNow = Date.now;
  let offset = 0;
  /** Past the device-sync cooldown, and onto a later relay second. */
  const later = () => (offset += DM_DEVICE_SYNC_COOLDOWN_MS + 1_000);

  beforeAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true }),
  );
  afterAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: realSubtle, configurable: true }),
  );
  beforeEach(() => {
    offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  });
  afterEach(() => jest.restoreAllMocks());

  const slots = (relay: ReturnType<typeof makeRelay>, pubkey: string) =>
    new Set(
      relay.events
        .filter((e) => e.kind === 30443 && e.pubkey === pubkey)
        .map((e) => e.tags.find((t) => t[0] === 'd')?.[1]),
    ).size;
  const got = (d: Install, text: string) => d.inbox.some((m) => m.rumor.content === text);
  /**
   * Send as `from` with sendMarmotDm's steps (findDm → device sync → send),
   * on the session directly: switching the app's one active session between
   * installs would stop the other one.
   */
  const say = async (from: Install, to: string, content: string) => {
    const dm = from.session.findDm(to);
    if (!dm) throw new Error(`no 1:1 with ${to}`);
    await from.session.syncDmDevices(dm.id, 'send');
    const rumor = buildMarmotRumor(from.pubkey, { kind: MARMOT_CHAT_KIND, content });
    expect(Object.values(await from.session.sendRumor(dm.id, rumor))).toContain(true);
  };
  /**
   * Join with whichever Welcome is for this install. Jest's SecureStore mock is
   * shared, so two installs of one account clobber each other's leaf signing
   * key and the peer's sync may re-invite the other install too — a harness
   * artifact (each app has its own keystore on a phone).
   */
  const joinAny = async (d: Install, welcomes: ReturnType<typeof unwrapWelcomes>) => {
    for (const w of welcomes) {
      const joined = await d.session.acceptWelcome(w).catch(() => null);
      if (joined) return joined;
    }
    return null;
  };
  const activityOf = (s: MarmotSession, id: string) =>
    s.listGroups().find((g) => g.id === id)?.activityAt;

  it('both sides settle on one group, and a late join of the other never flips it', async () => {
    const relay = makeRelay();
    const benA = makeSession(relay, undefined, 'nsec', OPTS);
    const benB = makeInstall(relay, benA, OPTS);
    const emily = makeSession(relay, undefined, 'nsec', OPTS);
    const all = [benA, benB, emily];
    try {
      await Promise.all(all.map((d) => d.session.start()));
      await waitFor(() => slots(relay, benA.pubkey) === 2 && slots(relay, emily.pubkey) === 1);

      // Both of Ben's installs start the chat with Emily: two DM groups.
      const g1 = await benA.session.getOrCreateDm(emily.pubkey);
      later();
      const g2 = await benB.session.getOrCreateDm(emily.pubkey);
      expect(g2.id).not.toBe(g1.id);
      const [welcomeG1, welcomeG2] = unwrapWelcomes(relay, emily);

      // Emily joins Ben-B's group first. Ben-A isn't in it — before the fix
      // this is where the chat split: her messages never reached Ben-A.
      expect(await emily.session.acceptWelcome(welcomeG2)).toMatchObject({ id: g2.id });
      later();
      await say(emily, benA.pubkey, 'Yo');
      // Her device sync adds the Ben install missing from her group (all of
      // a contact's devices, #1664) — Ben-A joins and reads what follows.
      const toBenA = unwrapWelcomes(relay, benA);
      expect(await joinAny(benA, toBenA)).toMatchObject({ id: g2.id });
      await waitFor(() => got(benB, 'Yo') && got(benA, 'Yo'));
      // Ben-A now has both groups and picks the live one; its reply reaches Emily.
      await waitFor(() => activityOf(benA.session, g2.id) !== undefined);
      expect(benA.session.findDm(emily.pubkey)?.id).toBe(g2.id);
      later();
      await say(benA, emily.pubkey, 'Got it');
      await waitFor(() => got(emily, 'Got it') && got(benB, 'Got it'));

      // Days later Ben-A's original Welcome finally lands (outbox retry).
      // The old "joined last wins" rule moved Emily into that stale group,
      // which Ben-B isn't in. Relay activity keeps her where the chat is.
      later();
      expect(await emily.session.acceptWelcome(welcomeG1)).toMatchObject({ id: g1.id });
      expect(emily.session.findDm(benA.pubkey)?.id).toBe(g2.id);
      later();
      await say(emily, benA.pubkey, 'Hello 1');
      // Both of Ben's installs read it — no new Welcome needed.
      await waitFor(() => got(benA, 'Hello 1') && got(benB, 'Hello 1'));
      expect(unwrapWelcomes(relay, benA)).toHaveLength(toBenA.length);
    } finally {
      all.forEach((d) => d.session.stop());
    }
  }, 180_000);

  it('a create whose Welcome went unacknowledged keeps the chat and delivers it on a send (#1402)', async () => {
    // Relays reachable one way only (flaky mobile data / VPN): the Welcome is
    // stored, but no relay acknowledges it. The Add has committed, so the chat
    // and its queued invitation are kept: no second group, no split.
    const relay = makeRelay();
    const publish = relay.network.publish;
    let acklessWraps = false;
    relay.network.publish = async (relays, event) => {
      const result = await publish(relays, event);
      if (event.kind !== 1059 || !acklessWraps) return result;
      return Object.fromEntries(relays.map((r) => [r, { from: r, ok: false, message: 'timeout' }]));
    };
    const ben = makeSession(relay, undefined, 'nsec', OPTS);
    const emily = makeSession(relay, undefined, 'nsec', OPTS);
    try {
      await Promise.all([ben.session.start(), emily.session.start()]);
      await waitFor(() => slots(relay, emily.pubkey) === 1 && slots(relay, ben.pubkey) === 1);
      acklessWraps = true;
      const dm = await ben.session.getOrCreateDm(emily.pubkey);
      expect(ben.session.findDm(emily.pubkey)?.id).toBe(dm.id);
      expect(await ben.session.pendingInvites(dm.id)).toEqual(new Map([[emily.pubkey, 'pending']]));

      // Connection back: Ben's next send republishes the same Welcome.
      acklessWraps = false;
      later();
      await say(ben, emily.pubkey, 'retry message');
      for (let i = 0; i < 200 && (await ben.session.pendingInvites(dm.id)).size > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await ben.session.pendingInvites(dm.id)).toEqual(new Map());
      expect(await emily.session.acceptWelcome(unwrapWelcomes(relay, emily)[0])).toMatchObject({
        id: dm.id,
      });
      await waitFor(() => got(emily, 'retry message'));
      later();
      await say(emily, ben.pubkey, 'after retry');
      await waitFor(() => got(ben, 'after retry'));
      expect(ben.session.listGroups()).toHaveLength(1);
    } finally {
      [ben, emily].forEach((d) => d.session.stop());
    }
  }, 180_000);

  it('Repair starts a fresh 1:1 that both sides then use', async () => {
    const relay = makeRelay();
    const ben = makeSession(relay, undefined, 'nsec', OPTS);
    const emily = makeSession(relay, undefined, 'nsec', OPTS);
    try {
      await Promise.all([ben.session.start(), emily.session.start()]);
      await waitFor(() => slots(relay, emily.pubkey) === 1 && slots(relay, ben.pubkey) === 1);
      const old = await ben.session.getOrCreateDm(emily.pubkey);
      await emily.session.acceptWelcome(unwrapWelcomes(relay, emily)[0]);
      later();
      await say(ben, emily.pubkey, 'before');
      await waitFor(() => got(emily, 'before'));

      later();
      const fresh = await ben.session.restartDm(emily.pubkey);
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.relays.length).toBeGreaterThanOrEqual(dmChoice.MIN_GROUP_RELAYS);
      expect(ben.session.findDm(emily.pubkey)?.id).toBe(fresh.id);
      // Emily has not accepted Repair yet: her first message still uses G1.
      later();
      await say(emily, ben.pubkey, 'peer sends before accepting repair');
      await waitFor(() => got(ben, 'peer sends before accepting repair'));
      expect(activityOf(ben.session, old.id)).toBeGreaterThan(activityOf(ben.session, fresh.id)!);
      expect(ben.session.findDm(emily.pubkey)?.id).toBe(fresh.id);
      expect(await ben.backend.get('dmSuperseded', old.id)).toBe('1');
      // Ben's next message goes into the fresh chat; once Emily accepts the
      // invitation and reads it, she's there too.
      later();
      await say(ben, emily.pubkey, 'repaired');
      const [, welcome] = unwrapWelcomes(relay, emily);
      expect(await emily.session.acceptWelcome(welcome)).toMatchObject({ id: fresh.id });
      await waitFor(() => got(emily, 'repaired'));
      expect(emily.session.findDm(ben.pubkey)?.id).toBe(fresh.id);

      later();
      await say(emily, ben.pubkey, 'after');
      await waitFor(() => got(ben, 'after'));
      expect(ben.inbox.find((m) => m.rumor.content === 'after')?.group.id).toBe(fresh.id);
    } finally {
      [ben, emily].forEach((d) => d.session.stop());
    }
  }, 180_000);

  it('first-use creation never marks an existing 1:1 superseded (only Repair does)', async () => {
    const relay = makeRelay();
    const ben = makeSession(relay, undefined, 'nsec', OPTS);
    const emily = makeSession(relay, undefined, 'nsec', OPTS);
    try {
      await Promise.all([ben.session.start(), emily.session.start()]);
      await waitFor(() => slots(relay, emily.pubkey) === 1 && slots(relay, ben.pubkey) === 1);
      const existing = await ben.session.getOrCreateDm(emily.pubkey);
      // The create path getOrCreateDm takes when findDm misses (e.g. a Welcome
      // joined in the gap): the group that's already there must stay unmarked.
      later();
      const created = await ben.session.restartDm(emily.pubkey, false);
      expect(created.id).not.toBe(existing.id);
      expect(await ben.backend.get('dmSuperseded', existing.id)).toBeFalsy();
    } finally {
      [ben, emily].forEach((d) => d.session.stop());
    }
  }, 120_000);

  it('tops a single-relay 1:1 up to more relays, for both members', async () => {
    const relay = makeRelay();
    const ben = makeSession(relay, undefined, 'nsec', OPTS);
    const emily = makeSession(relay, undefined, 'nsec', OPTS);
    try {
      await Promise.all([ben.session.start(), emily.session.start()]);
      await waitFor(() => slots(relay, emily.pubkey) === 1);
      // A chat made by 1.6.0 for an account with one write relay.
      jest.spyOn(dmChoice, 'groupRelaysFor').mockReturnValueOnce([RELAY]);
      const dm = await ben.session.getOrCreateDm(emily.pubkey);
      expect(dm.relays).toEqual([RELAY]);
      await emily.session.acceptWelcome(unwrapWelcomes(relay, emily)[0]);

      later();
      await say(ben, emily.pubkey, 'more relays');
      const relaysOf = (s: MarmotSession) => s.getGroup(dm.id)?.relays ?? [];
      await waitFor(() => relaysOf(emily.session).length >= dmChoice.MIN_GROUP_RELAYS);
      expect(relaysOf(ben.session)).toContain(RELAY);
      expect(relaysOf(emily.session)).toEqual(relaysOf(ben.session));
      await waitFor(() => got(emily, 'more relays'));
      // Still one chat, and it keeps working after the change.
      later();
      await say(emily, ben.pubkey, 'still here');
      await waitFor(() => got(ben, 'still here'));
      expect(ben.session.listGroups()).toHaveLength(1);
    } finally {
      [ben, emily].forEach((d) => d.session.stop());
    }
  }, 180_000);
});
