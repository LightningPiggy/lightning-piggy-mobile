// A NIP-46 account creating a Marmot chat whose signer declines, goes quiet,
// or fails part-way (#1402), through the app's real remote-signer path
// (createMarmotSigner → nostrConnectService, with the bunker mocked) and
// real MLS. Once the Add has committed the chat is kept, its invitation is
// queued with the reason and nothing is reported as a failed create; a
// failure before the commit leaves nothing behind.
import { MarmotSession } from './marmotSession';
import { makeRelay, makeSession, makeSigner, RELAY, unwrapWelcomes } from './marmotSessionTestKit';
import { createMemoryMarmotBackend } from './marmotStore';
import { NO_RELAYS_RETRY_MS } from './marmotWelcomePayloads';

/** The bunker's key, and how it answers each event kind ('ok' by default). */
const mockBunker: { sk?: Uint8Array; answer: Map<number, 'deny' | 'timeout'> } = {
  answer: new Map(),
};
jest.mock('./nostrConnectService', () => ({
  requestEventSignature: async (json: string) => {
    const { NostrConnectError, SignerTimeoutError } = jest.requireActual('./signerErrors');
    const { finalizeEvent } = jest.requireActual('nostr-tools');
    const template = JSON.parse(json);
    const answer = mockBunker.answer.get(template.kind);
    if (answer === 'deny')
      throw new NostrConnectError('permission', 'NIP-46 signer denied sign_event');
    // The signer's own deadline (unit-tested in marmotSigner.test) firing.
    if (answer === 'timeout') throw new SignerTimeoutError('NIP-46 signer did not answer in time');
    return { event: JSON.stringify(finalizeEvent(template, mockBunker.sk!)) };
  },
  requestNip44Encrypt: async (plaintext: string, peer: string) => {
    const { nip44 } = jest.requireActual('nostr-tools');
    return nip44.encrypt(plaintext, nip44.getConversationKey(mockBunker.sk!, peer));
  },
  requestNip44Decrypt: async (ciphertext: string, peer: string) => {
    const { nip44 } = jest.requireActual('nostr-tools');
    return nip44.decrypt(ciphertext, nip44.getConversationKey(mockBunker.sk!, peer));
  },
}));

const SEAL = 13;
const IDENTITY_PROOF = 450;

async function setup(opts: { refuseWraps?: boolean } = {}) {
  const relay = makeRelay();
  if (opts.refuseWraps) {
    // Relays that won't take a gift wrap — set before any session reads the network.
    const publish = relay.network.publish;
    relay.network.publish = async (relays, event) =>
      event.kind === 1059
        ? Object.fromEntries(relays.map((r) => [r, { from: r, ok: false, message: 'no' }]))
        : publish(relays, event);
  }
  const bob = makeSession(relay);
  const who = makeSigner();
  mockBunker.sk = who.sk;
  mockBunker.answer.clear();
  const backend = createMemoryMarmotBackend();
  const little = new MarmotSession({
    pubkey: who.pubkey,
    signerType: 'nip46',
    network: relay.network,
    backend,
    getWriteRelays: () => [RELAY],
    getLookupRelays: () => [RELAY],
  });
  await little.start();
  await bob.session.start();
  await bob.session.ensureKeyPackage();
  await little.ensureKeyPackage();
  const outbox = (little as unknown as { outbox: { pending(): Promise<unknown[]> } }).outbox;
  const stop = () => {
    little.stop();
    bob.session.stop();
  };
  return { relay, bob, little, backend, outbox, stop };
}

afterEach(() => jest.restoreAllMocks());

test('a declined Welcome after the commit keeps the chat, reports it, and asks again on a send', async () => {
  const t = await setup();
  mockBunker.answer.set(SEAL, 'deny');
  const group = await t.little.createGroup('PendingInvite', [t.bob.pubkey]);
  expect(group).toMatchObject({
    undelivered: [t.bob.pubkey],
    needsSigner: [t.bob.pubkey],
    waitingForRelays: [],
  });
  expect(t.little.listGroups().map((g) => g.id)).toEqual([group.id]);
  expect(await t.little.pendingInvites(group.id)).toEqual(new Map([[t.bob.pubkey, 'needsSigner']]));
  expect(unwrapWelcomes(t.relay, t.bob)).toHaveLength(0);

  // The user approves next time: their next send in the chat (past the
  // backoff) asks the signer again and delivers it.
  mockBunker.answer.clear();
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + NO_RELAYS_RETRY_MS);
  t.little.retryInvites(group.id, 'send');
  for (let i = 0; i < 200 && unwrapWelcomes(t.relay, t.bob).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(unwrapWelcomes(t.relay, t.bob)).toHaveLength(1);
  expect(await t.little.pendingInvites(group.id)).toEqual(new Map());
  t.stop();
});

test('a signer that never answers the Welcome: the create completes with the invitation queued', async () => {
  const t = await setup();
  mockBunker.answer.set(SEAL, 'timeout');
  const group = await t.little.createGroup('PendingInvite', [t.bob.pubkey]);
  expect(group).toMatchObject({ undelivered: [t.bob.pubkey], needsSigner: [t.bob.pubkey] });
  expect(t.little.listGroups()).toHaveLength(1);
  const [raw] = await Promise.all(
    (await t.backend.keys('welcomePayloads')).map((k) => t.backend.get('welcomePayloads', k)),
  );
  expect(JSON.parse(raw ?? '{}')).toMatchObject({ reason: 'signerTimeout' });
  t.stop();
});

test('a denial before the commit fails the create and leaves nothing behind', async () => {
  const t = await setup();
  // The creator's own leaf needs an identity proof before the group exists.
  mockBunker.answer.set(IDENTITY_PROOF, 'deny');
  mockBunker.answer.set(SEAL, 'deny');
  await expect(t.little.createGroup('PendingInvite', [t.bob.pubkey])).rejects.toThrow('denied');
  expect(t.little.listGroups()).toEqual([]);
  expect(await t.backend.keys('welcomePayloads')).toEqual([]);
  expect(await t.outbox.pending()).toEqual([]);
  t.stop();
});

test('anything failing after the commit is reported as not delivered, never as a failed create', async () => {
  const t = await setup({ refuseWraps: true });
  const outbox = (t.little as unknown as { outbox: { resend: () => Promise<never> } }).outbox;
  // The invite's own resend of the refused Welcome blows up after the commit.
  const resend = jest.spyOn(outbox, 'resend').mockRejectedValue(new Error('storage exploded'));
  const group = await t.little.createGroup('PendingInvite', [t.bob.pubkey]);
  expect(resend).toHaveBeenCalled();
  expect(group.undelivered).toEqual([t.bob.pubkey]);
  expect(t.little.listGroups().map((g) => g.id)).toEqual([group.id]);
  t.stop();
});
