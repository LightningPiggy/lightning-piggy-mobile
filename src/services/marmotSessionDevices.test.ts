// A person's devices in a Marmot chat (#1267), end to end over real MLS:
// Big invites both of Little's installs into a 1:1, and every client can say
// who is on how many devices, which app each one is, and draws the alpha
// "joined on N devices" notice locally from the commit. WebCrypto removed
// (Hermes has none), like the other session tests.
import { DM_DEVICE_SYNC_COOLDOWN_MS } from './marmotDmDeviceSync';
import { MARMOT_GROUP_ID_PREFIX } from './marmotSession';
import {
  makeInstall,
  makeRelay,
  makeSession,
  makeSigner,
  unwrapWelcomes,
  waitFor,
  waitForSettled,
} from './marmotSessionTestKit';

const mlsId = (appGroupId: string) => appGroupId.slice(MARMOT_GROUP_ID_PREFIX.length);

describe('MarmotSession devices per person (no WebCrypto)', () => {
  const realSubtle = globalThis.crypto.subtle;
  beforeAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true }),
  );
  afterAll(() =>
    Object.defineProperty(globalThis.crypto, 'subtle', { value: realSubtle, configurable: true }),
  );

  it('lists each person’s devices, names the apps it can, and notes who joined on how many', async () => {
    const relay = makeRelay();
    const big = makeSession(relay);
    const littleId = makeSigner();
    const [phone, tablet] = [makeInstall(relay, littleId), makeInstall(relay, littleId)];
    await Promise.all([big, phone, tablet].map((p) => p.session.start()));
    await waitFor(
      () =>
        relay.events.filter((e) => e.kind === 30443 && e.pubkey === littleId.pubkey).length === 2,
    );

    const changed: string[] = [];
    big.session.devices.subscribe((id) => changed.push(id));
    const dm = await big.session.getOrCreateDm(littleId.pubkey);
    const id = mlsId(dm.id);

    // Big's view: one leaf of his own, two of Little's.
    expect(big.session.devices.counts(id)).toEqual(
      new Map([
        [big.pubkey, 1],
        [littleId.pubkey, 2],
      ]),
    );
    // The invite commit is compared against the baseline taken at creation.
    await waitFor(() => changed.includes(id));
    const notices = await big.session.devices.notices(id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ pubkey: littleId.pubkey, joined: true, epoch: 1 });
    expect(notices[0].keys).toHaveLength(2);
    expect(notices[0].clients).toEqual(['Lightning Piggy', 'Lightning Piggy']);

    const bigView = await big.session.devices.devices(id);
    const mine = bigView?.people.get(big.pubkey) ?? [];
    expect(mine).toEqual([
      expect.objectContaining({
        isOwn: true,
        client: 'Lightning Piggy',
        baseline: true,
        firstEpoch: 0,
      }),
    ]);
    // We invited them, so we hold the invitation keys: app and time are known.
    const littles = bigView?.people.get(littleId.pubkey) ?? [];
    expect(littles).toHaveLength(2);
    for (const d of littles) {
      expect(d).toMatchObject({
        isOwn: false,
        client: 'Lightning Piggy',
        baseline: false,
        firstEpoch: 1,
      });
      expect(d.keyCreatedAt).toEqual(expect.any(Number));
    }
    expect(new Set(littles.map((d) => d.key)).size).toBe(2);

    // Little's phone joins: a baseline, so no notices on its side.
    const [welcome] = unwrapWelcomes(relay, littleId);
    await phone.session.acceptWelcome(welcome);
    const phoneId = id;
    await waitFor(() => phone.session.devices.counts(phoneId) !== null);
    const before = await phone.session.devices.devices(phoneId);
    expect(await phone.session.devices.notices(phoneId)).toEqual([]);
    const ownDevices = before?.people.get(littleId.pubkey) ?? [];
    expect(ownDevices.map((d) => d.isOwn).sort()).toEqual([false, true]);
    expect(ownDevices.find((d) => !d.isOwn)?.client).toBeNull();
    expect(ownDevices.every((d) => d.baseline)).toBe(true);

    // The sheet's relay lookup names the tablet (its invitation key is still
    // published); Big's creator leaf never came from a published key: unknown.
    expect(await phone.session.devices.resolveClients(phoneId)).toBe(true);
    const after = await phone.session.devices.devices(phoneId);
    expect(after?.people.get(littleId.pubkey)?.find((d) => !d.isOwn)?.client).toBe(
      'Lightning Piggy',
    );
    expect(after?.people.get(big.pubkey)?.[0].client).toBeNull();
    // Looked up once per cooldown: a second open doesn't query again.
    const requests = relay.requests.length;
    expect(await phone.session.devices.resolveClients(phoneId)).toBe(false);
    expect(relay.requests.length).toBe(requests);

    [big, phone, tablet].forEach((p) => p.session.stop());
  }, 90_000);

  it('resolves our two new devices from their published tags after a peer adds them', async () => {
    const relay = makeRelay();
    const big = makeSession(relay);
    const phone = makeSession(relay);
    const tablet = makeInstall(relay, phone);
    const desktop = makeInstall(relay, phone);
    const installs = [big, phone, tablet, desktop];
    try {
      await Promise.all([big, phone].map((p) => p.session.start()));
      await waitFor(() => relay.events.filter((e) => e.kind === 30443).length >= 2);
      const dm = await big.session.getOrCreateDm(phone.pubkey);
      await phone.session.acceptWelcome(unwrapWelcomes(relay, phone)[0]);
      const id = mlsId(dm.id);
      await waitForSettled(big.session, dm.id);
      await Promise.all([tablet, desktop].map((p) => p.session.start()));
      await waitFor(
        () =>
          new Set(
            relay.events
              .filter((e) => e.kind === 30443 && e.pubkey === phone.pubkey)
              .map((e) => e.tags.find((t) => t[0] === 'd')?.[1]),
          ).size === 3,
      );
      // Only Big holds the invitation keys when the Add commit is sent.
      const now = Date.now();
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(now + DM_DEVICE_SYNC_COOLDOWN_MS + 1_000);
      try {
        await big.session.syncDmDevices(dm.id, 'send');
      } finally {
        clock.mockRestore();
      }
      await waitFor(() => phone.session.devices.counts(id)?.get(phone.pubkey) === 3);
      await phone.session.devices.devices(id); // drain the observation write
      const before = await phone.session.devices.notices(id);
      expect(before).toEqual([
        expect.objectContaining({
          pubkey: phone.pubkey,
          joined: false,
          clients: [null, null],
        }),
      ]);
      const bigNotice = (await big.session.devices.notices(id)).find((n) => !n.joined);
      expect(bigNotice?.clients).toEqual(['Lightning Piggy', 'Lightning Piggy']);
      const published = relay.events.length;
      const stored = await phone.backend.get('deviceNotices', id);
      const changed = jest.fn();
      phone.session.devices.subscribe(changed);
      // The notice surface must request the same read-only lookup as the sheet.
      expect(await phone.session.devices.resolveClients(id)).toBe(true);
      const after = await phone.session.devices.notices(id);
      expect(after).toEqual([
        {
          ...before[0],
          clients: ['Lightning Piggy', 'Lightning Piggy'],
        },
      ]);
      expect(changed).toHaveBeenCalledWith(id);
      expect(await phone.backend.get('deviceNotices', id)).toBe(stored);
      expect(relay.events).toHaveLength(published);
    } finally {
      installs.forEach((p) => p.session.stop());
    }
  }, 90_000);
});
