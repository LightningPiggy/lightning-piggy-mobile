import { marmotReactionSource } from './marmotReactions';
// End-to-end Marmot round trip with WebCrypto REMOVED, approximating Hermes
// (which has no crypto.subtle). If any marmot-ts / ts-mls code path still
// reaches SubtleCrypto, this suite fails — that's the whole point of it.
import {
  MarmotClient,
  createApplicationMessageIntent,
  createChatRumor,
  deserializeApplicationData,
} from '@internet-privacy/marmot-ts';
import { InMemoryKeyValueStore } from '@internet-privacy/marmot-ts/extra';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import { installMarmotCryptoProvider, marmotCryptoProvider } from './marmotCryptoProvider';
import {
  MARMOT_CHAT_KIND,
  MarmotNoKeyPackageError,
  MarmotSession,
  MarmotUnusableKeyPackageError,
  isUsableKeyPackage,
  buildMarmotRumor,
  quiesceMarmotSession,
  setMarmotSession,
  type MarmotMessageEvent,
} from './marmotSession';
import { createMemoryMarmotBackend, decodeMarmotValue, encodeMarmotValue } from './marmotStore';
import { loadFailedInvites, parseWelcomeOutcome } from './marmotWelcomeOutcomes';
import { getFailedMarmotInvitesSnapshot } from './marmotFailedInvitesStore';
import { storedMarmotContent } from './marmotInbox';
import { decryptMarmotMedia, marmotImetaTag } from './marmotMedia';
import { parseImageMessage, parseVoiceNote } from '../utils/messageContent';
import {
  RELAY,
  makeRelay,
  makeSession,
  makeSigner,
  unwrapWelcomes,
  waitFor,
  waitForSettled,
} from './marmotSessionTestKit';

function makeClient(network: ReturnType<typeof makeRelay>['network']) {
  const { signer, pubkey } = makeSigner();
  const client = new MarmotClient({
    signer,
    network,
    cryptoProvider: marmotCryptoProvider,
    groupStateStore: new InMemoryKeyValueStore(),
    keyPackageStore: new InMemoryKeyValueStore(),
    clientId: 'lightning-piggy-test',
  });
  return { client, pubkey };
}

describe('Marmot without WebCrypto (Hermes smoke)', () => {
  const realSubtle = globalThis.crypto.subtle;

  beforeAll(() => {
    installMarmotCryptoProvider();
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(globalThis.crypto, 'subtle', { value: realSubtle, configurable: true });
  });

  it('creates a group, invites, joins and exchanges messages both ways', async () => {
    expect(globalThis.crypto.subtle).toBeUndefined();
    const relay = makeRelay();
    const alice = makeClient(relay.network);
    const bob = makeClient(relay.network);

    await bob.client.keyPackages.create({ relays: [RELAY] });
    const [bobKeyPackage] = await relay.network.request(
      [RELAY],
      [{ kinds: [30443, 443], authors: [bob.pubkey] }],
    );
    expect(bobKeyPackage).toBeDefined();

    const group = await alice.client.groups.create('Piggy Bank', {
      description: 'test group',
      relays: [RELAY],
      adminPubkeys: [alice.pubkey],
    });
    await alice.client.groups.invite(group.id, bobKeyPackage);

    // Bob receives the gift-wrapped kind-444 Welcome.
    const wraps = await relay.network.request([RELAY], [{ kinds: [1059], '#p': [bob.pubkey] }]);
    expect(wraps.length).toBeGreaterThan(0);
    for (const w of wraps) await bob.client.invites.ingestEvent(w);
    await bob.client.invites.decryptGiftWraps();
    const [welcomeRumor] = await bob.client.invites.getUnread();
    expect(welcomeRumor?.kind).toBe(444);
    const { group: bobGroup } = await bob.client.joinGroupFromWelcome({ welcomeRumor });

    // Alice → Bob
    const bobInbox: string[] = [];
    bobGroup.on('applicationMessage', (data) =>
      bobInbox.push(deserializeApplicationData(data).content),
    );
    await alice.client.groups.send(
      group.id,
      createApplicationMessageIntent(
        createChatRumor({ pubkey: alice.pubkey, content: 'hello bob' }),
      ),
    );
    const groupEvents = () => relay.network.request([RELAY], [{ kinds: [445] }]);
    for await (const _ of bobGroup.ingest(await groupEvents())) void _;
    expect(bobInbox).toContain('hello bob');

    // Bob → Alice
    const aliceInbox: string[] = [];
    group.on('applicationMessage', (data) =>
      aliceInbox.push(deserializeApplicationData(data).content),
    );
    await bob.client.groups.send(
      bobGroup.id,
      createApplicationMessageIntent(createChatRumor({ pubkey: bob.pubkey, content: 'oink back' })),
    );
    for await (const _ of group.ingest(await groupEvents())) void _;
    expect(aliceInbox).toContain('oink back');
  }, 60_000);
});

// --- MarmotSession (the app's wrapper) -----------------------------------------

describe('MarmotSession (no WebCrypto)', () => {
  const realSubtle = globalThis.crypto.subtle;
  beforeAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true }),
  );
  afterAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: realSubtle, configurable: true }),
  );

  it('drains key publication before account cleanup and cannot republish after stopping', async () => {
    const relay = makeRelay();
    const publish = relay.network.publish;
    let release!: () => void;
    let publishing = false;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    relay.network.publish = async (relays, event) => {
      if (event.kind === 30443) {
        publishing = true;
        await blocked;
      }
      return publish(relays, event);
    };
    const alice = makeSession(relay);
    setMarmotSession(alice.session);
    try {
      await alice.session.start();
      await waitFor(() => publishing);
      let drained = false;
      const cleanup = quiesceMarmotSession(alice.pubkey).then(() => (drained = true));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(drained).toBe(false);
      release();
      await cleanup;
      await alice.session.ensureKeyPackage();
      expect(relay.events.filter((e) => e.kind === 30443)).toHaveLength(1);
    } finally {
      release();
      setMarmotSession(null);
    }
  }, 60_000);

  /** A session whose kind-30443 signing waits for `gate` (an unanswered Amber / NIP-46 prompt). */
  function sessionWithSlowSigner(relay: ReturnType<typeof makeRelay>, gate: Promise<void>) {
    const who = makeSigner();
    const backend = createMemoryMarmotBackend();
    const session = new MarmotSession({
      pubkey: who.pubkey,
      signerType: 'nsec',
      signer: {
        ...who.signer,
        signEvent: async (draft: Parameters<typeof finalizeEvent>[0]) => {
          if (draft.kind === 30443) await gate;
          return finalizeEvent(draft, who.sk);
        },
      },
      network: relay.network,
      backend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
      keyPackageDrainMs: 200,
    });
    return { ...who, session, backend };
  }

  it('sign-out never hangs on a signer prompt nobody answers', async () => {
    const relay = makeRelay();
    const never = new Promise<void>(() => undefined);
    const alice = sessionWithSlowSigner(relay, never);
    setMarmotSession(alice.session);
    try {
      await alice.session.start();
      await waitFor(
        () =>
          (alice.session as unknown as { keyPackageRuns: { current: unknown } }).keyPackageRuns
            .current !== null,
      );
      const started = Date.now();
      await quiesceMarmotSession(alice.pubkey);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      setMarmotSession(null);
    }
  }, 30_000);

  it('a signer answer arriving after the wipe publishes and writes nothing', async () => {
    const relay = makeRelay();
    let answer!: () => void;
    const late = new Promise<void>((resolve) => (answer = resolve));
    const alice = sessionWithSlowSigner(relay, late);
    setMarmotSession(alice.session);
    try {
      await alice.session.start();
      await waitFor(
        () =>
          (alice.session as unknown as { keyPackageRuns: { current: unknown } }).keyPackageRuns
            .current !== null,
      );
      await quiesceMarmotSession(alice.pubkey);
      for (const ns of ['keyPackages', 'meta']) await alice.backend.clear(ns); // the wipe
      answer(); // the user approves the prompt after signing out
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(relay.events.filter((e) => e.kind === 30443)).toHaveLength(0);
      expect(await alice.backend.keys('keyPackages')).toEqual([]);
      expect(await alice.backend.keys('meta')).toEqual([]);
    } finally {
      setMarmotSession(null);
    }
  }, 30_000);

  it('bounds the wait for a stuck relay publish, and fences its late write', async () => {
    const relay = makeRelay();
    const publish = relay.network.publish;
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    relay.network.publish = async (relays, event) => {
      if (event.kind === 30443) await stuck;
      return publish(relays, event);
    };
    const alice = sessionWithSlowSigner(relay, Promise.resolve());
    setMarmotSession(alice.session);
    try {
      await alice.session.start();
      await waitFor(
        () =>
          (alice.session as unknown as { keyPackageRuns: { current: unknown } }).keyPackageRuns
            .current !== null,
      );
      const started = Date.now();
      await quiesceMarmotSession(alice.pubkey); // keyPackageDrainMs: 200
      expect(Date.now() - started).toBeLessThan(2_000);
      await alice.backend.clear('keyPackages'); // the wipe
      release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await alice.backend.keys('keyPackages')).toEqual([]);
    } finally {
      release();
      setMarmotSession(null);
    }
  }, 30_000);

  it('keeps a Welcome for our own key retryable when the join fails, even as "No matching secret"', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bobKeys = makeSigner();
    const bobBackend = createMemoryMarmotBackend();
    const bob = new MarmotSession({
      pubkey: bobKeys.pubkey,
      signerType: 'nsec',
      signer: bobKeys.signer,
      network: relay.network,
      backend: bobBackend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
    });
    await Promise.all([alice.session.start(), bob.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bobKeys.pubkey));
    await alice.session.getOrCreateDm(bobKeys.pubkey);
    const [welcome] = unwrapWelcomes(relay, bobKeys);

    // marmot-ts reports only the LAST key's error — here from an unrelated key.
    const join = jest
      .spyOn(MarmotClient.prototype, 'joinGroupFromWelcome')
      .mockRejectedValueOnce(
        new Error(
          'Failed to join group with any matching key package. Last error: No matching secret found',
        ),
      );
    expect(await bob.acceptWelcome(welcome)).toBeNull();
    expect(await bobBackend.get('welcomes', welcome.id)).toBeNull();
    expect(await bobBackend.keys('pendingWelcomes')).toEqual([welcome.id]);
    join.mockRestore();
    expect(await bob.acceptWelcome(welcome)).not.toBeNull(); // the retry joins
    alice.session.stop();
    bob.stop();
  }, 60_000);

  it("drops a Welcome meant for another of the account's devices", async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bobKeys = makeSigner();
    const device = (backend = createMemoryMarmotBackend()) => ({
      backend,
      session: new MarmotSession({
        pubkey: bobKeys.pubkey,
        signerType: 'nsec',
        signer: bobKeys.signer,
        network: relay.network,
        backend,
        getWriteRelays: () => [RELAY],
        getLookupRelays: () => [RELAY],
      }),
    });
    const phone = device();
    await Promise.all([alice.session.start(), phone.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bobKeys.pubkey));
    await alice.session.getOrCreateDm(bobKeys.pubkey); // invites the phone's key package
    const [welcome] = unwrapWelcomes(relay, bobKeys);

    const tablet = device();
    await tablet.session.start();
    await waitFor(
      () => relay.events.filter((e) => e.kind === 30443 && e.pubkey === bobKeys.pubkey).length > 1,
    );
    expect(await tablet.session.acceptWelcome(welcome)).toBeNull();
    expect(await tablet.backend.get('welcomes', welcome.id)).not.toBeNull(); // handled for good
    expect(await tablet.backend.keys('pendingWelcomes')).toEqual([]);
    // It named the phone's key package (another slot): not a failure to show
    // on the tablet (#1269).
    expect(parseWelcomeOutcome(await tablet.backend.get('welcomes', welcome.id))).toMatchObject({
      result: 'otherDevice',
    });
    expect(await loadFailedInvites(tablet.backend)).toEqual([]);
    for (const s of [alice.session, phone.session, tablet.session]) s.stop();
  }, 60_000);

  it('records an invite no key here opens, and not another device’s, as failed (#1269)', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bob = makeSession(relay);
    await Promise.all([alice.session.start(), bob.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    await alice.session.getOrCreateDm(bob.pubkey);
    const [welcome] = unwrapWelcomes(relay, bob);
    // Bob's key is gone (reinstall / old invitation key) and so is its event.
    const stale = makeSession(relay);
    const lost = new MarmotSession({
      pubkey: bob.pubkey,
      signerType: 'nsec',
      signer: bob.signer,
      network: relay.network,
      backend: stale.backend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
    });
    relay.events.splice(
      0,
      relay.events.length,
      ...relay.events.filter((e) => !(e.kind === 30443 && e.pubkey === bob.pubkey)),
    );
    await lost.start();
    // The relays answer (with this install's new key), just not the old key.
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    expect(await lost.acceptWelcome(welcome)).toBeNull();
    expect(parseWelcomeOutcome(await stale.backend.get('welcomes', welcome.id))).toMatchObject({
      result: 'failed',
      reason: 'noKey',
      sender: alice.pubkey,
    });
    const failed = [
      { id: welcome.id, sender: alice.pubkey, createdAt: welcome.created_at, reason: 'noKey' },
    ];
    expect(await loadFailedInvites(stale.backend)).toEqual(failed);
    // …and handed to the Messages UI for this account.
    await waitFor(() => getFailedMarmotInvitesSnapshot().invites.length === 1);
    expect(getFailedMarmotInvitesSnapshot()).toEqual({ owner: bob.pubkey, invites: failed });
    lost.stop();
    expect(getFailedMarmotInvitesSnapshot().owner).toBeNull(); // cleared with the session
    for (const s of [alice.session, bob.session, stale.session]) s.stop();
  }, 60_000);

  it('round-trips the KV codec (bytes + bigint nested in objects)', () => {
    const value = {
      a: new Uint8Array([1, 2, 255]),
      n: 12345678901234567890n,
      nested: [{ b: new Uint8Array() }],
    };
    expect(decodeMarmotValue(encodeMarmotValue(value))).toEqual(value);
  });

  it('DM: White Noise conventions, invite → accept → messages both ways', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bob = makeSession(relay);
    await Promise.all([alice.session.start(), bob.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));

    // Spec: the kind-30443 `d` slot is 32 random bytes (hex), stable per device.
    const bobKp = relay.events.find((e) => e.kind === 30443 && e.pubkey === bob.pubkey)!;
    expect(bobKp.tags.find((t) => t[0] === 'd')?.[1]).toMatch(/^[0-9a-f]{64}$/);

    const dm = await alice.session.getOrCreateDm(bob.pubkey);
    expect(dm).toMatchObject({ name: '', isDm: true, memberPubkeys: [bob.pubkey] });
    expect(dm.adminPubkeys.sort()).toEqual([alice.pubkey, bob.pubkey].sort());
    // Idempotent: a second open reuses the same group.
    expect((await alice.session.getOrCreateDm(bob.pubkey)).id).toBe(dm.id);

    const [welcome] = unwrapWelcomes(relay, bob);
    const joined = await bob.session.acceptWelcome(welcome);
    expect(joined).toMatchObject({ id: dm.id, isDm: true, memberPubkeys: [alice.pubkey] });
    expect(bob.session.findDm(alice.pubkey)?.id).toBe(dm.id);

    const hello = buildMarmotRumor(alice.pubkey, { kind: MARMOT_CHAT_KIND, content: 'hello bob' });
    await alice.session.sendRumor(dm.id, hello);
    await waitFor(() => bob.inbox.some((m) => m.rumor.id === hello.id));
    expect(bob.inbox.find((m) => m.rumor.id === hello.id)).toMatchObject({
      group: { id: dm.id, isDm: true },
      rumor: { pubkey: alice.pubkey, content: 'hello bob', kind: 9 },
    });

    // Any rumor kind rides along (here: a NIP-17-style kind-15 file message).
    const file = buildMarmotRumor(bob.pubkey, {
      kind: 15,
      content: 'https://blossom.example/abc',
      tags: [
        ['file-type', 'image/jpeg'],
        ['decryption-key', 'k'],
      ],
    });
    await bob.session.sendRumor(dm.id, file);
    await waitFor(() => alice.inbox.some((m) => m.rumor.id === file.id));
    expect(alice.inbox.find((m) => m.rumor.id === file.id)?.rumor.tags).toEqual(file.tags);

    // Group backfill queries are bounded (perf rule: limit on every filter).
    const groupQueries = relay.requests.flat().filter((f) => f.kinds?.includes(445));
    expect(groupQueries.length).toBeGreaterThan(0);
    expect(groupQueries.every((f) => typeof f.limit === 'number')).toBe(true);

    alice.session.stop();
    bob.session.stop();
  }, 60_000);

  it('group: create, rename, remove a member, leave', async () => {
    const relay = makeRelay();
    const [alice, bob, carol] = [makeSession(relay), makeSession(relay), makeSession(relay)];
    await Promise.all([alice, bob, carol].map((p) => p.session.start()));
    await waitFor(
      () =>
        relay.events.filter(
          (e) => e.kind === 30443 && [bob.pubkey, carol.pubkey].includes(e.pubkey),
        ).length === 2,
    );

    const group = await alice.session.createGroup('Piggy Bank', [bob.pubkey, carol.pubkey]);
    expect(group).toMatchObject({ name: 'Piggy Bank', isDm: false });
    expect(group.memberPubkeys.sort()).toEqual([bob.pubkey, carol.pubkey].sort());
    for (const who of [bob, carol]) {
      const [welcome] = unwrapWelcomes(relay, who);
      expect(await who.session.acceptWelcome(welcome)).not.toBeNull();
    }

    await alice.session.rename(group.id, 'Oink Club');
    expect(alice.session.getGroup(group.id)?.name).toBe('Oink Club');
    await waitFor(() => bob.session.getGroup(group.id)?.name === 'Oink Club');

    await alice.session.removeMember(group.id, carol.pubkey);
    expect(alice.session.getGroup(group.id)?.memberPubkeys).toEqual([bob.pubkey]);
    await waitFor(() => !bob.session.getGroup(group.id)?.memberPubkeys.includes(carol.pubkey));
    // Let Bob's client settle on the removal commit before he sends: a send in
    // the settle window can stay queued forever in marmot-ts (#1280).
    await waitForSettled(bob.session, group.id);

    const msg = buildMarmotRumor(bob.pubkey, { kind: MARMOT_CHAT_KIND, content: 'just us now' });
    await bob.session.sendRumor(group.id, msg);
    await waitFor(() => alice.inbox.some((m) => m.rumor.id === msg.id));
    expect(carol.inbox.some((m) => m.rumor.id === msg.id)).toBe(false);

    await bob.session.leave(group.id);
    expect(bob.session.getGroup(group.id)).toBeUndefined();

    for (const p of [alice, bob, carol]) p.session.stop();
  }, 90_000);

  it('pages the kind-445 backfill so a long offline gap loses no commits', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    await alice.session.start();
    // Bob is "offline": he publishes a key package but only starts later,
    // with a page size far smaller than the backlog.
    const bobKeys = makeSigner();
    const bobBackend = createMemoryMarmotBackend();
    const bobOpts = {
      pubkey: bobKeys.pubkey,
      signerType: 'nsec' as const,
      signer: bobKeys.signer,
      network: relay.network,
      backend: bobBackend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
      groupBackfillPageSize: 3,
    };
    const bobFirst = new MarmotSession(bobOpts);
    await bobFirst.start();
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bobKeys.pubkey));
    const dm = await alice.session.getOrCreateDm(bobKeys.pubkey);
    const [welcome] = unwrapWelcomes(relay, bobKeys);
    await bobFirst.acceptWelcome(welcome);
    bobFirst.stop();

    // While Bob is away: 10 messages and an epoch-changing commit in between.
    for (let i = 0; i < 5; i++) {
      await alice.session.sendRumor(
        dm.id,
        buildMarmotRumor(alice.pubkey, { kind: 9, content: `m${i}` }),
      );
    }
    await alice.session.rename(dm.id, ''); // commit (epoch++) — must not be skipped
    const last = buildMarmotRumor(alice.pubkey, { kind: 9, content: 'latest' });
    await alice.session.sendRumor(dm.id, last);

    // Bob comes back with page size 3: the backlog (> 3 events) must be paged.
    const bob = new MarmotSession(bobOpts);
    const inbox: MarmotMessageEvent[] = [];
    bob.subscribe({ onMessage: (m) => inbox.push(m) });
    await bob.start();
    await waitFor(() => inbox.some((m) => m.rumor.id === last.id));
    const pages = relay.requests
      .flat()
      .filter((f) => f.kinds?.includes(445) && f.until !== undefined);
    expect(pages.length).toBeGreaterThan(0);
    alice.session.stop();
    bob.stop();
  }, 90_000);

  it('single-flights DM creation, joins each Welcome once, and defers remote-signer publishing', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bob = makeSession(relay);
    // An Amber-style account must not be prompted to sign at startup.
    const carol = makeSession(relay, undefined, 'amber');
    await Promise.all([alice, bob, carol].map((p) => p.session.start()));
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    expect(relay.events.some((e) => e.kind === 30443 && e.pubkey === carol.pubkey)).toBe(false);

    // Two quick sends to a new peer → one DM group, one Welcome.
    const [a, b] = await Promise.all([
      alice.session.getOrCreateDm(bob.pubkey),
      alice.session.getOrCreateDm(bob.pubkey),
    ]);
    expect(a.id).toBe(b.id);
    const welcomes = unwrapWelcomes(relay, bob);
    expect(welcomes).toHaveLength(1);

    expect(await bob.session.acceptWelcome(welcomes[0])).not.toBeNull();
    // The same gift wrap re-surfacing (inbox refresh) is not re-joined.
    expect(await bob.session.acceptWelcome(welcomes[0])).toBeNull();
    expect(bob.session.findDm(alice.pubkey)?.id).toBe(a.id);

    // First Marmot use by the Amber account publishes its key package even
    // though the invite itself fails (dan has none) — so it becomes reachable.
    const dan = getPublicKey(generateSecretKey());
    await expect(carol.session.createGroup('x', [dan])).rejects.toBeInstanceOf(
      MarmotNoKeyPackageError,
    );
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === carol.pubkey));

    for (const p of [alice, bob, carol]) p.session.stop();
  }, 60_000);

  it('retries a Welcome left pending by a transient failure, and ignores future-dated 445s for the watermark', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bobKeys = makeSigner();
    const bobBackend = createMemoryMarmotBackend();
    const bobOpts = {
      pubkey: bobKeys.pubkey,
      signerType: 'nsec' as const,
      signer: bobKeys.signer,
      network: relay.network,
      backend: bobBackend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
    };
    const bobFirst = new MarmotSession(bobOpts);
    await Promise.all([alice.session.start(), bobFirst.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bobKeys.pubkey));
    const dm = await alice.session.getOrCreateDm(bobKeys.pubkey);
    const [welcome] = unwrapWelcomes(relay, bobKeys);
    bobFirst.stop();

    // Simulate a join that failed transiently last session: the invite is
    // still pending (its gift wrap won't be re-routed by the inbox).
    await bobBackend.set('pendingWelcomes', welcome.id, JSON.stringify(welcome));

    // An attacker publishes a validly-signed 445 with the group's public h
    // tag, dated a year ahead.
    const h = relay.events.find((e) => e.kind === 445)!.tags.find((t) => t[0] === 'h')![1];
    const attacker = generateSecretKey();
    relay.events.push(
      finalizeEvent(
        {
          kind: 445,
          created_at: Math.floor(Date.now() / 1000) + 365 * 86400,
          tags: [['h', h]],
          content: 'x',
        },
        attacker,
      ),
    );

    const bob = new MarmotSession(bobOpts);
    await bob.start();
    await waitFor(() => bob.findDm(alice.pubkey)?.id === dm.id);
    expect(await bobBackend.keys('pendingWelcomes')).toEqual([]);

    // A later reconnect must not ask relays only for events after the fake date.
    bob.stop();
    relay.requests.length = 0;
    const bobAgain = new MarmotSession(bobOpts);
    await bobAgain.start();
    await waitFor(() => relay.requests.flat().some((f) => f['#h']?.[0] === h));
    const since = relay.requests.flat().find((f) => f['#h']?.[0] === h)?.since ?? 0;
    expect(since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    alice.session.stop();
    bobAgain.stop();
  }, 60_000);

  it('uses the newest DM with a peer after they lose state and start a fresh one', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bobKeys = makeSigner();
    const bobOpts = (backend: ReturnType<typeof createMemoryMarmotBackend>) => ({
      pubkey: bobKeys.pubkey,
      signerType: 'nsec' as const,
      signer: bobKeys.signer,
      network: relay.network,
      backend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
    });
    await alice.session.start();
    // Bob's first install starts a DM with Alice.
    const bobOld = new MarmotSession(bobOpts(createMemoryMarmotBackend()));
    await bobOld.start();
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === alice.pubkey));
    const oldDm = await bobOld.getOrCreateDm(alice.pubkey);
    await alice.session.acceptWelcome(unwrapWelcomes(relay, alice).at(-1)!);
    bobOld.stop();
    // Bob reinstalls (same keys, no MLS state) and starts a new DM.
    await new Promise((r) => setTimeout(r, 5)); // distinct firstSeen
    const bobNew = new MarmotSession(bobOpts(createMemoryMarmotBackend()));
    await bobNew.start();
    const newDm = await bobNew.getOrCreateDm(alice.pubkey);
    expect(newDm.id).not.toBe(oldDm.id);
    await alice.session.acceptWelcome(unwrapWelcomes(relay, alice).at(-1)!);
    expect(alice.session.findDm(bobKeys.pubkey)?.id).toBe(newDm.id);

    alice.session.stop();
    bobNew.stop();
  }, 60_000);

  it('re-delivers a message the app never stored (died after MLS processed it)', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bobKeys = makeSigner();
    const bobBackend = createMemoryMarmotBackend();
    const bobOpts = {
      pubkey: bobKeys.pubkey,
      signerType: 'nsec' as const,
      signer: bobKeys.signer,
      network: relay.network,
      backend: bobBackend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
    };
    // Bob's first run: joins and MLS-processes the message, but nothing is
    // listening — the app "died" before persisting it to its own stores.
    const bobFirst = new MarmotSession(bobOpts);
    await Promise.all([alice.session.start(), bobFirst.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bobKeys.pubkey));
    const dm = await alice.session.getOrCreateDm(bobKeys.pubkey);
    await bobFirst.acceptWelcome(unwrapWelcomes(relay, bobKeys).at(-1)!);
    const lost = buildMarmotRumor(alice.pubkey, {
      kind: MARMOT_CHAT_KIND,
      content: 'do not lose me',
    });
    await alice.session.sendRumor(dm.id, lost);
    await waitFor(() => relay.events.filter((e) => e.kind === 445).length >= 2);
    await new Promise((r) => setTimeout(r, 300)); // let bobFirst ingest it
    bobFirst.stop();

    // Next start: the message is replayed from the durable history.
    const bob = new MarmotSession(bobOpts);
    const inbox: MarmotMessageEvent[] = [];
    bob.subscribe({ onMessage: (m) => inbox.push(m) });
    await bob.start();
    expect(inbox.map((m) => m.rumor.id)).toContain(lost.id);
    expect(inbox.filter((m) => m.rumor.id === lost.id)).toHaveLength(1);

    alice.session.stop();
    bob.stop();
  }, 60_000);

  it('skips unusable key packages, explains when none are usable, and leaves no orphan group', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bob = makeSession(relay);
    await Promise.all([alice.session.start(), bob.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    const good = relay.events.find((e) => e.kind === 30443 && e.pubkey === bob.pubkey)!;

    // The library's rules: valid now, expired later, malformed without its d tag.
    expect(isUsableKeyPackage(good)).toBe(true);
    expect(isUsableKeyPackage(good, Math.floor(Date.now() / 1000) + 365 * 86400)).toBe(false);
    expect(isUsableKeyPackage({ ...good, tags: good.tags.filter((t) => t[0] !== 'd') })).toBe(
      false,
    );

    // (a) Passes our pre-check (nostr-tools' cached "verified" marker survives
    // the spread) but the library rejects it at invite time: the error
    // propagates and the half-made group is destroyed — no orphan.
    const tampered = {
      ...good,
      id: 'f'.repeat(64),
      created_at: good.created_at + 10,
      tags: [...good.tags.filter((t) => t[0] !== 'd'), ['d', 'a'.repeat(64)]],
    };
    relay.events.splice(relay.events.indexOf(good), 1, tampered);
    await expect(alice.session.getOrCreateDm(bob.pubkey)).rejects.toThrow();
    expect(alice.session.listGroups()).toEqual([]);

    // (b) A plain (unverified) copy fails our pre-check: friendly error, no group.
    const broken = JSON.parse(JSON.stringify(tampered));
    relay.events.splice(relay.events.indexOf(tampered), 1, broken);
    await expect(alice.session.getOrCreateDm(bob.pubkey)).rejects.toBeInstanceOf(
      MarmotUnusableKeyPackageError,
    );
    expect(alice.session.listGroups()).toEqual([]);
    await expect(alice.session.canMessage(bob.pubkey)).rejects.toBeInstanceOf(
      MarmotUnusableKeyPackageError,
    );

    // A good one alongside the broken one is used.
    relay.events.push(good);
    const dm = await alice.session.getOrCreateDm(bob.pubkey);
    expect(dm.isDm).toBe(true);

    alice.session.stop();
    bob.session.stop();
  }, 60_000);

  it('photos: White Noise-compatible v2 media that decrypts from the stored row alone', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bob = makeSession(relay);
    await Promise.all([alice.session.start(), bob.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    // White Noise only invites people whose key package supports media v2.
    const bobKp = relay.events.find((e) => e.kind === 30443 && e.pubkey === bob.pubkey)!;
    expect(bobKp.tags.find((t) => t[0] === 'app_components')).toContain('0x800b');

    const dm = await alice.session.getOrCreateDm(bob.pubkey);
    await bob.session.acceptWelcome(unwrapWelcomes(relay, bob)[0]);

    const photo = new Uint8Array(4096).map((_, i) => (i * 31) % 256);
    const enc = await alice.session.encryptMedia(dm.id, photo, 'image/png', 'photo.png');
    expect(enc.attachment.version).toBe('encrypted-media-v2');
    const url = `https://blossom.example/${enc.attachment.ciphertextSha256}.bin`;
    const rumor = buildMarmotRumor(alice.pubkey, {
      kind: MARMOT_CHAT_KIND,
      content: '',
      tags: [marmotImetaTag(enc.attachment, url)],
    });
    await alice.session.sendRumor(dm.id, rumor);
    await waitFor(() => bob.inbox.some((m) => m.rumor.id === rumor.id));

    // Bob's row: an image (kind 15, `#lpe=1` URL) that decrypts with no group state.
    const received = bob.inbox.find((m) => m.rumor.id === rumor.id)!;
    expect(received.mediaKeys?.[enc.attachment.ciphertextSha256]).toMatchObject({ url });
    expect(received.mediaKeys?.[enc.attachment.ciphertextSha256]?.keysHex).toContain(enc.keyHex);
    const stored = storedMarmotContent(received.rumor, received.mediaKeys);
    expect(stored.kind).toBe(15);
    const image = parseImageMessage(stored.text)!;
    expect(image).toMatchObject({ url, mime: 'image/png', encrypted: true });
    expect(decryptMarmotMedia(enc.encrypted, { ...image, marmot: image.marmot! })).toEqual(photo);

    // Without keys (none derived) it's a labelled fallback — never an empty bubble.
    expect(storedMarmotContent(received.rumor, undefined)).toEqual({
      text: "Couldn't open attachment: photo.png",
      kind: 14,
    });

    alice.session.stop();
    bob.session.stop();
  }, 60_000);

  it('voice notes: audio/mp4 media (White Noise shape) decrypts into the voice-note bubble', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bob = makeSession(relay);
    await Promise.all([alice.session.start(), bob.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    const dm = await alice.session.getOrCreateDm(bob.pubkey);
    await bob.session.acceptWelcome(unwrapWelcomes(relay, bob)[0]);

    const clip = new Uint8Array(2048).map((_, i) => (i * 7) % 256);
    const enc = await alice.session.encryptMedia(dm.id, clip, 'audio/mp4', 'voice-2000ms.m4a');
    const url = `https://blossom.example/${enc.attachment.ciphertextSha256}.bin`;
    const rumor = buildMarmotRumor(alice.pubkey, {
      kind: MARMOT_CHAT_KIND,
      content: '',
      tags: [marmotImetaTag(enc.attachment, url)],
    });
    await alice.session.sendRumor(dm.id, rumor);
    await waitFor(() => bob.inbox.some((m) => m.rumor.id === rumor.id));

    const received = bob.inbox.find((m) => m.rumor.id === rumor.id)!;
    const stored = storedMarmotContent(received.rumor, received.mediaKeys);
    expect(stored.kind).toBe(15);
    expect(parseImageMessage(stored.text)).toBeNull();
    const voice = parseVoiceNote(stored.text)!;
    expect(voice).toMatchObject({ url, mime: 'audio/mp4', encrypted: true });
    expect(decryptMarmotMedia(enc.encrypted, { ...voice, marmot: voice.marmot! })).toEqual(clip);

    alice.session.stop();
    bob.session.stop();
  }, 60_000);

  it('group reactions: backend encrypts kind 7 / kind 5 between members, read back from history', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    const bob = makeSession(relay);
    await Promise.all([alice.session.start(), bob.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === bob.pubkey));
    const dm = await alice.session.createGroup('Reactions', [bob.pubkey]);
    await bob.session.acceptWelcome(unwrapWelcomes(relay, bob)[0]);

    const hello = buildMarmotRumor(alice.pubkey, { kind: MARMOT_CHAT_KIND, content: 'oink' });
    await alice.session.sendRumor(dm.id, hello);
    await waitFor(() => bob.inbox.some((m) => m.rumor.id === hello.id));

    setMarmotSession(bob.session);
    const source = marmotReactionSource(bob.pubkey, alice.pubkey, dm.id);
    const reactionId = await source.publishReaction({ emoji: '🐷', targetEventId: hello.id });
    expect(reactionId).not.toBeNull();
    await waitFor(() => alice.inbox.some((m) => m.rumor.id === reactionId));
    // Both sides read it back from history (the sender's own copy included).
    for (const who of [alice, bob]) {
      const found = (await who.session.queryHistory(dm.id, [7])).filter((r) =>
        r.tags.some((t) => t[0] === 'e' && t[1] === hello.id),
      );
      expect(found.map((r) => r.content)).toEqual(['🐷']);
    }
    expect(await source.deleteReaction(reactionId!)).toBe(true);
    await waitFor(() => alice.inbox.some((m) => m.rumor.kind === 5));
    const deletions = (await alice.session.queryHistory(dm.id, [5])).filter((r) =>
      r.tags.some((t) => t[0] === 'e' && t[1] === reactionId),
    );
    expect(deletions.map((d) => d.pubkey)).toEqual([bob.pubkey]);

    alice.session.stop();
    bob.session.stop();
  }, 60_000);

  it('refuses to start a chat with someone who has no key package', async () => {
    const relay = makeRelay();
    const alice = makeSession(relay);
    await alice.session.start();
    const stranger = getPublicKey(generateSecretKey());
    expect(await alice.session.canMessage(stranger)).toBe(false);
    await expect(alice.session.getOrCreateDm(stranger)).rejects.toBeInstanceOf(
      MarmotNoKeyPackageError,
    );
    alice.session.stop();
  });
});
