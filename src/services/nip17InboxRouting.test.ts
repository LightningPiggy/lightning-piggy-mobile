// End-to-end routing of real sends to the recipients' relays (#1570): the
// NIP-17 1:1, group and Gamma order paths and NIP-04, over a mocked pool.
// The 1:1 peer and the Gamma seller are passed as chosen (as the app's
// senders do); group members are reached only when trusted (#1749).
import type { Event } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { getMemoisedSecretKey } from '../contexts/nostrSecretKeyCache';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { sendNip04Message } from './nostrNip04Send';
import { sendNip17ToManyWithNsec, sendNip17ToManyWithSigner } from './nostrNip17Send';
import { pool } from './nostrPool';
import { sendNip17Rumor } from './nip17RumorSend';
import { clearPeerRelayListCache } from './peerRelayLists';
import { clearFollowGateStores, publishFollowSet } from './followSetEvents';

jest.mock('./nostrPool', () => ({
  pool: {
    publish: jest.fn((relays: string[]) => relays.map(() => Promise.resolve('saved'))),
    querySyncFilters: jest.fn(),
  },
  trackRelays: jest.fn(),
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  releaseNewIdleRelays: jest.fn(),
}));
jest.mock('./appRelayPrefs', () => ({
  enabledAppRelays: (_group: string, list: readonly string[]) => list,
}));
jest.mock('./nostrService', () => ({
  ...jest.requireActual('./nostrNip17Send'),
  DEFAULT_RELAYS: ['wss://default.example.com'],
}));
jest.mock('../contexts/nostrSecretKeyCache', () => ({ getMemoisedSecretKey: jest.fn() }));
jest.mock('./amberService', () => ({}));
jest.mock('./nostrConnectService', () => ({}));

const publish = jest.mocked(pool.publish);
const query = jest.mocked(pool.querySyncFilters);
const base = ['wss://base.example.com'];
const rumor = { kind: 14, created_at: 123, tags: [], content: 'hello' };

const listEvent = (pubkey: string, kind: number, tags: string[][]): Event => ({
  id: `${kind}-${pubkey.slice(0, 6)}`,
  pubkey,
  kind,
  created_at: 100,
  tags,
  content: '',
  sig: '',
});

/** Peers' published lists: inbox (10050) and NIP-65 read relays (10002). */
function published(lists: Record<string, { inbox?: string[]; read?: string[] }>) {
  query.mockImplementation(async (_relays, filters) =>
    (filters[0].authors ?? []).flatMap((pk) => {
      const entry = lists[pk];
      if (!entry) return [];
      return [
        ...(entry.inbox
          ? [
              listEvent(
                pk,
                10050,
                entry.inbox.map((u) => ['relay', u]),
              ),
            ]
          : []),
        ...(entry.read
          ? [
              listEvent(
                pk,
                10002,
                entry.read.map((u) => ['r', u, 'read']),
              ),
            ]
          : []),
      ];
    }),
  );
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Every relay set each event id was published to. */
function destinations(): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const [relays, event] of publish.mock.calls) {
    out.set(event.id, [...(out.get(event.id) ?? []), relays]);
  }
  return out;
}

const recipientOf = (event: { tags: string[][] }) => event.tags.find((t) => t[0] === 'p')?.[1];

function wrapIdFor(pubkey: string): string {
  const call = publish.mock.calls.find(([, event]) => recipientOf(event) === pubkey);
  if (!call) throw new Error(`no wrap for ${pubkey}`);
  return call[1].id;
}

beforeEach(() => {
  clearPeerRelayListCache();
  clearFollowGateStores();
  jest.clearAllMocks();
  query.mockReset();
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(performance.now());
    return 0;
  });
});

afterEach(() => {
  setCurrentUserPubkey(null);
  jest.restoreAllMocks();
});

it('1:1: the recipient wrap goes to their 10050, the self-copy to my own 10050', async () => {
  const myKey = generateSecretKey();
  const me = getPublicKey(myKey);
  const peer = getPublicKey(generateSecretKey());
  published({
    [peer]: { inbox: ['wss://peer-inbox.example.com'] },
    [me]: { inbox: ['wss://my-inbox.example.com'] },
  });
  const result = await sendNip17ToManyWithNsec({
    senderSecretKey: myKey,
    rumor,
    recipientPubkeys: [peer],
    relays: base,
    peerRouting: { lookupRelays: ['wss://my-read.example.com'], chosenRecipients: [peer] },
  });
  await settle();
  expect(result.wrapsPublished).toBe(2);
  const sent = destinations();
  expect(sent.get(wrapIdFor(peer))).toEqual([base, ['wss://peer-inbox.example.com/']]);
  expect(sent.get(wrapIdFor(me))).toEqual([base, ['wss://my-inbox.example.com/']]);
  // The lookup asked my read relays too.
  expect(query.mock.calls[0][0]).toContain('wss://my-read.example.com');
});

it('remote signer: routes the same signed wraps, with no extra signing', async () => {
  const me = getPublicKey(generateSecretKey());
  const peer = getPublicKey(generateSecretKey());
  const sealKey = generateSecretKey();
  published({ [peer]: { inbox: ['wss://peer-inbox.example.com'] } });
  const signSeal = jest.fn(async (seal) => finalizeEvent(seal, sealKey));
  await sendNip17ToManyWithSigner({
    senderPubkey: me,
    rumor: { ...rumor, pubkey: me },
    recipientPubkeys: [peer],
    relays: base,
    peerRouting: { chosenRecipients: [peer] },
    signerNip44Encrypt: async () => 'ciphertext',
    signerSignSeal: signSeal,
  });
  await settle();
  expect(signSeal).toHaveBeenCalledTimes(2);
  expect(destinations().get(wrapIdFor(peer))).toEqual([base, ['wss://peer-inbox.example.com/']]);
});

it("group: each followed member's wrap goes to THAT member's inbox; a stranger's does not", async () => {
  const myKey = generateSecretKey();
  const me = getPublicKey(myKey);
  const members = [1, 2, 3].map(() => getPublicKey(generateSecretKey()));
  const stranger = getPublicKey(generateSecretKey());
  publishFollowSet(
    me,
    members.map((pubkey) => ({ pubkey, relay: null, petname: null, profile: null })),
  );
  published({
    ...Object.fromEntries(
      members.map((pk, i) => [pk, { inbox: [`wss://member${i}-inbox.example.com`] }]),
    ),
    [stranger]: { inbox: ['wss://stranger-inbox.example.com'] },
  });
  await sendNip17ToManyWithNsec({
    senderSecretKey: myKey,
    rumor,
    recipientPubkeys: [...members, stranger],
    relays: base,
  });
  await settle();
  const sent = destinations();
  members.forEach((pk, i) => {
    expect(sent.get(wrapIdFor(pk))).toEqual([base, [`wss://member${i}-inbox.example.com/`]]);
  });
  // The stranger's wrap stays on the usual set, and their list isn't even looked up.
  expect(sent.get(wrapIdFor(stranger))).toEqual([base]);
  // One batched lookup for the trusted members (self included).
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][1][0].authors).not.toContain(stranger);
});

it('peerRouting: false (a NIP-171 epoch key) looks nothing up and adds no relays', async () => {
  const epoch = getPublicKey(generateSecretKey());
  published({ [epoch]: { inbox: ['wss://epoch.example.com'] } });
  await sendNip17ToManyWithNsec({
    senderSecretKey: generateSecretKey(),
    rumor,
    recipientPubkeys: [epoch],
    relays: base,
    includeSelf: false,
    peerRouting: false,
  });
  await settle();
  expect(query).not.toHaveBeenCalled();
  for (const [relays] of publish.mock.calls) expect(relays).toEqual(base);
});

it('Gamma order: the wrap reaches the seller inbox', async () => {
  const buyerKey = generateSecretKey();
  const buyer = getPublicKey(buyerKey);
  const seller = getPublicKey(generateSecretKey());
  jest.mocked(getMemoisedSecretKey).mockResolvedValue(buyerKey);
  published({ [seller]: { inbox: ['wss://seller-inbox.example.com'] } });
  await sendNip17Rumor({
    senderPubkey: buyer,
    signerType: 'nsec',
    relays: [{ url: 'wss://buyer-write.example.com', write: true, read: false }],
    rumor: { pubkey: buyer, kind: 16, created_at: 123, tags: [['p', seller]], content: '{}' },
    recipientPubkey: seller,
    recipientChosen: true,
  });
  await settle();
  expect(destinations().get(wrapIdFor(seller))).toEqual([
    ['wss://buyer-write.example.com', 'wss://default.example.com'],
    ['wss://seller-inbox.example.com/'],
  ]);
});

it('NIP-04: the kind 4 also goes to the recipient NIP-65 read relays', async () => {
  const myKey = generateSecretKey();
  const me = getPublicKey(myKey);
  const peer = getPublicKey(generateSecretKey());
  jest.mocked(getMemoisedSecretKey).mockResolvedValue(myKey);
  published({
    [peer]: { inbox: ['wss://peer-inbox.example.com'], read: ['wss://peer-read.example.com'] },
  });
  await sendNip04Message({
    senderPubkey: me,
    recipientPubkey: peer,
    plaintext: 'hi',
    signerType: 'nsec',
    relays: base,
    peerRouting: { chosenRecipients: [peer] },
  });
  await settle();
  const event = publish.mock.calls[0][1];
  expect(event.kind).toBe(4);
  expect(destinations().get(event.id)).toEqual([base, ['wss://peer-read.example.com/']]);
});

it('NIP-04 with peerRouting: false looks nothing up and adds no relays', async () => {
  const myKey = generateSecretKey();
  const peer = getPublicKey(generateSecretKey());
  jest.mocked(getMemoisedSecretKey).mockResolvedValue(myKey);
  published({ [peer]: { read: ['wss://peer-read.example.com'] } });
  await sendNip04Message({
    senderPubkey: getPublicKey(myKey),
    recipientPubkey: peer,
    plaintext: '-',
    signerType: 'nsec',
    relays: base,
    peerRouting: false,
  });
  await settle();
  expect(query).not.toHaveBeenCalled();
  for (const [relays] of publish.mock.calls) expect(relays).toEqual(base);
});

it('a late lookup still publishes the SAME signed wrap to the inbox after the send resolved', async () => {
  const myKey = generateSecretKey();
  const peer = getPublicKey(generateSecretKey());
  let answer!: (events: Event[]) => void;
  query.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const result = await sendNip17ToManyWithNsec({
    senderSecretKey: myKey,
    rumor,
    recipientPubkeys: [peer],
    relays: base,
    peerRouting: { chosenRecipients: [peer] },
  });
  // The send resolved without waiting for the lookup: only the usual set so far.
  expect(result.wrapsPublished).toBe(2);
  const peerWrap = wrapIdFor(peer);
  expect(destinations().get(peerWrap)).toHaveLength(1);
  answer([listEvent(peer, 10050, [['relay', 'wss://peer-inbox.example.com']])]);
  await settle();
  expect(destinations().get(peerWrap)).toEqual([base, ['wss://peer-inbox.example.com/']]);
});

it('extra relays never change the result or the delivery tick', async () => {
  const myKey = generateSecretKey();
  const peer = getPublicKey(generateSecretKey());
  published({ [peer]: { inbox: ['wss://dead-inbox.example.com'] } });
  publish.mockImplementation((relays: string[]) =>
    relays.map((url) =>
      url.includes('dead-inbox') ? Promise.reject(new Error('blocked')) : Promise.resolve('saved'),
    ),
  );
  const onDeliveryFinalized = jest.fn();
  const result = await sendNip17ToManyWithNsec({
    senderSecretKey: myKey,
    rumor,
    recipientPubkeys: [peer],
    relays: base,
    peerRouting: { chosenRecipients: [peer] },
    onDeliveryFinalized,
  });
  await settle();
  expect(publish).toHaveBeenCalledWith(['wss://dead-inbox.example.com/'], expect.anything());
  expect(result.errors).toEqual([]);
  expect(result.wrapsPublished).toBe(2);
  expect(result.delivery).toMatchObject({
    delivered: true,
    relayResults: { [base[0]]: 'ok' },
    targetRelayCount: 1,
  });
  expect(onDeliveryFinalized).toHaveBeenCalledTimes(1);
  expect(onDeliveryFinalized.mock.calls[0][0].relayResults).toEqual({ [base[0]]: 'ok' });
});

it('lockdown: a test account sending to a public 10050 reaches only the test relay', async () => {
  const myKey = generateSecretKey();
  const me = getPublicKey(myKey);
  const peer = getPublicKey(generateSecretKey());
  const originalHas = TEST_ACCOUNT_PUBKEYS.has.bind(TEST_ACCOUNT_PUBKEYS);
  jest.spyOn(TEST_ACCOUNT_PUBKEYS, 'has').mockImplementation((pk) => pk === me || originalHas(pk));
  setCurrentUserPubkey(me);
  published({
    [peer]: { inbox: ['wss://public-inbox.example.com', 'wss://relay.damus.io'] },
    [me]: { inbox: ['wss://my-public-inbox.example.com'] },
  });
  const result = await sendNip17ToManyWithNsec({
    senderSecretKey: myKey,
    rumor,
    recipientPubkeys: [peer],
    relays: ['wss://relay.damus.io', ...base],
    peerRouting: { lookupRelays: ['wss://my-read.example.com'], chosenRecipients: [peer] },
  });
  await settle();
  expect(result.wrapsPublished).toBe(2);
  expect(publish).toHaveBeenCalled();
  for (const [relays] of publish.mock.calls) expect(relays).toEqual([TEST_RELAY_URL]);
  expect(query).toHaveBeenCalled();
  for (const [relays] of query.mock.calls) expect(relays).toEqual([TEST_RELAY_URL]);
});
