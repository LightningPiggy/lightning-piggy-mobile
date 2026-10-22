// Inviting every device of a contact (#1238): one commit, one Welcome per
// device, accounts (not leaves) everywhere above the session, and Welcome
// delivery tracked per person with retry from the outbox. Real MLS crypto,
// WebCrypto removed (Hermes has none).
import type { Event as NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools';

import { MarmotWelcomeDeliveryError } from './marmotInvitees';
import * as pushWake from './marmotPushWake';
import { MARMOT_CHAT_KIND, MarmotSession, buildMarmotRumor } from './marmotSession';
import { loadFailedInvites, parseWelcomeOutcome } from './marmotWelcomeOutcomes';
import {
  RELAY,
  makeInstall,
  makeRelay,
  makeSession,
  makeSigner,
  unwrapWelcomes,
  waitFor,
} from './marmotSessionTestKit';

describe('MarmotSession multi-device invites (no WebCrypto)', () => {
  const realSubtle = globalThis.crypto.subtle;
  beforeAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true }),
  );
  afterAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: realSubtle, configurable: true }),
  );

  it('multi-device: invites every device of a contact; one conversation, attributed per account', async () => {
    const relay = makeRelay();
    // Fault injection (installed before the sessions capture `publish`):
    // reject the next N Welcome gift wraps.
    const publish = relay.network.publish;
    let rejectWraps = 0;
    relay.network.publish = async (relays, event) => {
      if (event.kind === 1059 && rejectWraps > 0) {
        rejectWraps--;
        return Object.fromEntries(relays.map((r) => [r, { from: r, ok: false, message: 'no' }]));
      }
      return publish(relays, event);
    };
    const big = makeSession(relay);
    const bigOtherPhone = makeInstall(relay, big);
    const littleId = makeSigner();
    const [phone, tablet] = [makeInstall(relay, littleId), makeInstall(relay, littleId)];
    await Promise.all([big, bigOtherPhone, phone, tablet].map((p) => p.session.start()));
    const kps = (pk: string) => relay.events.filter((e) => e.kind === 30443 && e.pubkey === pk);
    await waitFor(() => kps(littleId.pubkey).length === 2 && kps(big.pubkey).length === 2);
    // Model a contact using both apps, retaining the real MLS key material
    // and signing the changed client tag so validation exercises the DM path.
    const [lpPackage, tabletPackage] = kps(littleId.pubkey);
    const wnPackage = finalizeEvent(
      {
        kind: tabletPackage.kind,
        content: tabletPackage.content,
        created_at: tabletPackage.created_at,
        tags: [...tabletPackage.tags.filter((t) => t[0] !== 'client'), ['client', 'White Noise']],
      },
      littleId.sk,
    );
    expect(lpPackage.tags).toContainEqual(['client', 'Lightning Piggy']);
    relay.events[relay.events.indexOf(tabletPackage)] = wnPackage;
    // A third Little key package that can't be used (bad signature, new slot):
    // skipped, the two good devices still join.
    const broken = JSON.parse(JSON.stringify(kps(littleId.pubkey)[0])) as NostrEvent;
    broken.tags = [...broken.tags.filter((t) => t[0] !== 'd'), ['d', 'b'.repeat(64)]];
    broken.created_at += 5;
    relay.events.push(broken);

    // One of the two Welcomes is refused once: it's republished straight
    // away from the outbox (no second commit, no new signature).
    rejectWraps = 1;
    const progress: number[] = [];
    big.session.subscribe({ onInviteProgress: ({ done, total }) => progress.push(done / total) });
    const dm = await big.session.getOrCreateDm(littleId.pubkey);
    expect(progress).toEqual([0, 0.5, 1]);
    // Three leaves (Big + two Little devices), still ONE DM with ONE member.
    expect(dm).toMatchObject({ isDm: true, memberPubkeys: [littleId.pubkey] });
    // Our own other phone is never invited (that would be device linking).
    expect(unwrapWelcomes(relay, big)).toHaveLength(0);
    // One Welcome per device, each naming that device's key package; the
    // MLS Welcome inside is identical (White Noise dedupes on it).
    const welcomes = unwrapWelcomes(relay, littleId);
    expect(welcomes).toHaveLength(2);
    expect(welcomes.flatMap((w) => w.tags.filter((t) => t[0] === 'e').map((t) => t[1]))).toEqual(
      expect.arrayContaining([lpPackage.id, wnPackage.id]),
    );
    expect(welcomes[0].content).toBe(welcomes[1].content);
    for (const device of [phone, tablet]) {
      const joined = await device.session.acceptWelcome(welcomes[0]);
      expect(joined).toMatchObject({ id: dm.id, isDm: true, memberPubkeys: [big.pubkey] });
      // The other device's copy is then handled, not retried forever.
      expect(await device.session.acceptWelcome(welcomes[1])).toBeNull();
      // Neither copy shows as a failed invite (#1269). The other copy names
      // the other device's key package — which that device may already have
      // rotated away after joining, so it can't always be told apart from an
      // old key; the shared commit fingerprint with the joined copy hides it.
      const outcome = async (i: number) =>
        parseWelcomeOutcome(await device.backend.get('welcomes', welcomes[i].id));
      const [first, second] = [await outcome(0), await outcome(1)];
      expect(first?.result).toBe('joined');
      expect(second?.commit).toBe(first?.commit);
      expect(await loadFailedInvites(device.backend)).toEqual([]);
    }

    // Both devices reply; Big sees one conversation, both attributed to Little.
    const fromPhone = buildMarmotRumor(littleId.pubkey, {
      kind: MARMOT_CHAT_KIND,
      content: 'phone',
    });
    const fromTablet = buildMarmotRumor(littleId.pubkey, {
      kind: MARMOT_CHAT_KIND,
      content: 'tablet',
    });
    const traffic = jest.spyOn(pushWake, 'noteMarmotGroupTraffic');
    await phone.session.sendRumor(dm.id, fromPhone);
    await waitFor(() => tablet.inbox.some((m) => m.rumor.id === fromPhone.id));
    // Sent from another device of the SAME account: it arrives authored by our
    // own pubkey (so the hooks show it as ours and never alert), and still
    // counts as authenticated traffic — a push wake it caused is covered.
    expect(tablet.inbox.find((m) => m.rumor.id === fromPhone.id)?.rumor.pubkey).toBe(
      littleId.pubkey,
    );
    // …noted as OUR OWN message: it can settle (retract) a push placeholder
    // it caused, never stand in for a peer's message.
    expect(traffic).toHaveBeenCalledWith(
      littleId.pubkey,
      expect.objectContaining({ createdAtSec: fromPhone.created_at, fromMe: true, message: true }),
    );
    traffic.mockRestore();
    await tablet.session.sendRumor(dm.id, fromTablet);
    await waitFor(() => big.inbox.filter((m) => m.group.id === dm.id).length >= 2);
    const received = big.inbox.filter((m) => m.group.id === dm.id);
    expect(received.map((m) => [m.rumor.content, m.rumor.pubkey])).toEqual([
      ['phone', littleId.pubkey],
      ['tablet', littleId.pubkey],
    ]);
    expect(big.session.listGroups()).toHaveLength(1);
    expect(await big.session.dmGroupIdsWith(littleId.pubkey)).toEqual([dm.id]);

    // Big's message reaches both of Little's devices.
    const hello = buildMarmotRumor(big.pubkey, { kind: MARMOT_CHAT_KIND, content: 'hi both' });
    await big.session.sendRumor(dm.id, hello);
    await waitFor(() => [phone, tablet].every((d) => d.inbox.some((m) => m.rumor.id === hello.id)));
    [big, bigOtherPhone, phone, tablet].forEach((p) => p.session.stop());
  }, 90_000);

  it('multi-device: a second Welcome for a group we already joined is handled, not retried', async () => {
    const relay = makeRelay();
    const big = makeSession(relay);
    const little = makeSession(relay);
    await Promise.all([big.session.start(), little.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === little.pubkey));
    const dm = await big.session.getOrCreateDm(little.pubkey);
    const [welcome] = unwrapWelcomes(relay, little);
    expect(await little.session.acceptWelcome(welcome)).toMatchObject({ id: dm.id });
    // The same Welcome under another rumor id (one gift wrap per invited
    // device of our account): no duplicate group, nothing left pending.
    const twin = buildMarmotRumor(welcome.pubkey, {
      kind: welcome.kind,
      content: welcome.content,
      tags: [...welcome.tags, ['client', 'second device']],
      created_at: welcome.created_at,
    });
    expect(await little.session.acceptWelcome(twin)).toBeNull();
    expect(little.session.listGroups()).toHaveLength(1);
    big.session.stop();
    little.session.stop();
  }, 60_000);

  it('multi-device: reports who was not reached and delivers later without another commit', async () => {
    const relay = makeRelay();
    const publish = relay.network.publish;
    let carolOffline = true;
    relay.network.publish = async (relays, event) =>
      event.kind === 1059 && carolOffline && event.tags.some((t) => t[1] === carol.pubkey)
        ? Object.fromEntries(relays.map((r) => [r, { from: r, ok: false, message: 'no' }]))
        : publish(relays, event);
    const big = makeSession(relay);
    const bob = makeSession(relay);
    const carol = makeSession(relay);
    await Promise.all([big, bob, carol].map((p) => p.session.start()));
    await waitFor(
      () =>
        relay.events.filter(
          (e) => e.kind === 30443 && [bob.pubkey, carol.pubkey].includes(e.pubkey),
        ).length === 2,
    );
    const group = await big.session.createGroup('Piggy Bank', [bob.pubkey, carol.pubkey]);
    expect(group.undelivered).toEqual([carol.pubkey]);
    expect(unwrapWelcomes(relay, carol)).toHaveLength(0);
    const commits = relay.events.filter((e) => e.kind === 445).length;

    // Carol's relays come back: the queued Welcome goes out at the next start.
    carolOffline = false;
    big.session.stop();
    const again = new MarmotSession({
      pubkey: big.pubkey,
      signerType: 'nsec',
      signer: big.signer,
      network: relay.network,
      backend: big.backend,
      getWriteRelays: () => [RELAY],
      getLookupRelays: () => [RELAY],
    });
    await again.start();
    await waitFor(() => unwrapWelcomes(relay, carol).length === 1);
    expect(relay.events.filter((e) => e.kind === 445)).toHaveLength(commits); // no new Add
    expect(await carol.session.acceptWelcome(unwrapWelcomes(relay, carol)[0])).toMatchObject({
      id: group.id,
    });
    [again, bob.session, carol.session].forEach((s) => s.stop());
  }, 90_000);

  it('multi-device: no group is left behind when every Welcome fails', async () => {
    const relay = makeRelay();
    const publish = relay.network.publish;
    relay.network.publish = async (relays, event) =>
      event.kind === 1059
        ? Object.fromEntries(relays.map((r) => [r, { from: r, ok: false, message: 'no' }]))
        : publish(relays, event);
    const big = makeSession(relay);
    const little = makeSession(relay);
    await Promise.all([big.session.start(), little.session.start()]);
    await waitFor(() => relay.events.some((e) => e.kind === 30443 && e.pubkey === little.pubkey));
    await expect(big.session.getOrCreateDm(little.pubkey)).rejects.toBeInstanceOf(
      MarmotWelcomeDeliveryError,
    );
    expect(big.session.listGroups()).toEqual([]);
    big.session.stop();
    little.session.stop();
  }, 60_000);
});
