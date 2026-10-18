// Kinds safety for Gamma Markets orders: kind 16 (order lifecycle) and kind 17
// (payment receipt) must only ever travel as NIP-17 rumors inside gift wraps.
// Public kind 16 is a NIP-18 generic repost; public kind 17 is a NIP-25
// reaction to a website. These tests pin every outbound seam (sign, relay
// publish, Marmot send) and the inbound renderer.
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import * as nip59 from 'nostr-tools/nip59';
import {
  WRAP_ONLY_KINDS,
  WrapOnlyKindError,
  assertNotWrapOnlyKind,
  isWrapOnlyKind,
} from './wrapOnlyKinds';
import { nostrFinalizeEvent } from '../services/nostrCrypto';
import { pool } from '../services/nostrPool';
import { buildMarmotRumor, setMarmotSession, type MarmotSession } from '../services/marmotSession';
import { sendMarmotDm, sendMarmotGroupRumor } from '../services/marmotSend';
import { buildConversationItems } from './conversationItems';
import { buildMarketOrder } from './marketOrder';
import { serializeOrder, parseOrderEvent } from './orderEvents';

jest.mock('../services/relayHealth', () => ({
  hydrateRelayHealth: jest.fn(),
  selectHealthyRelays: (urls: string[]) => urls,
  noteNetworkActivity: jest.fn(),
  recordRelayPublish: jest.fn(),
}));
jest.mock('../services/boltzService', () => ({ isBitcoinAddress: () => false }));

const ME = 'a'.repeat(64);
const SELLER = 'b'.repeat(64);

const template = (kind: number) => ({
  kind,
  created_at: 1_700_000_000,
  tags: [['p', SELLER]],
  content: '',
});

describe('wrap-only kinds', () => {
  it('lists exactly the Gamma order (16) and receipt (17) kinds', () => {
    expect(WRAP_ONLY_KINDS).toEqual([16, 17]);
    expect(isWrapOnlyKind(16)).toBe(true);
    expect(isWrapOnlyKind(17)).toBe(true);
    for (const kind of [1, 4, 13, 14, 15, 1059, 30402]) expect(isWrapOnlyKind(kind)).toBe(false);
  });

  it('assertNotWrapOnlyKind names the refused path', () => {
    expect(() => assertNotWrapOnlyKind(16, 'publish')).toThrow(WrapOnlyKindError);
    expect(() => assertNotWrapOnlyKind(17, 'sign')).toThrow(/kind-17/);
    expect(() => assertNotWrapOnlyKind(14, 'marmot')).not.toThrow();
  });
});

describe('sign path', () => {
  const sk = generateSecretKey();

  it.each([16, 17])('refuses to sign a bare kind %i event', (kind) => {
    expect(() => nostrFinalizeEvent(template(kind), sk)).toThrow(WrapOnlyKindError);
  });

  it('still signs ordinary kinds, seals and gift wraps', () => {
    expect(nostrFinalizeEvent(template(1), sk).kind).toBe(1);
    expect(nostrFinalizeEvent(template(13), sk).kind).toBe(13);
    expect(nostrFinalizeEvent(template(1059), sk).kind).toBe(1059);
  });

  it('gift-wrapping a kind-16 order rumor still works (the rumor is never signed)', () => {
    const buyerSk = generateSecretKey();
    const { rumor } = buildMarketOrder({
      buyerPubkey: getPublicKey(buyerSk),
      vendorPubkey: getPublicKey(sk),
      lines: [{ merchantPubkey: getPublicKey(sk), dTag: 'mug', quantity: 1, priceSats: 21 }],
      orderId: 'order-1',
    });
    const wrap = nip59.wrapEvent(rumor, buyerSk, getPublicKey(sk));
    expect(wrap.kind).toBe(1059);
    expect(nip59.unwrapEvent(wrap, sk).kind).toBe(16);
  });
});

describe('relay publish path', () => {
  it.each([16, 17])('refuses to publish a bare kind %i event to any relay', (kind) => {
    const event = { ...template(kind), id: 'x', pubkey: ME, sig: 'y' } as Event;
    expect(() => pool.publish(['wss://relay.example'], event)).toThrow(WrapOnlyKindError);
  });
});

describe('Marmot send path', () => {
  const sent: unknown[] = [];
  beforeEach(() => {
    sent.length = 0;
    setMarmotSession({
      pubkey: ME,
      stop: () => undefined,
      getOrCreateDm: async () => ({ id: 'marmot:dm', relays: ['wss://r1'] }),
      // sendMarmotDm adds a peer's newer devices before sending (#1559).
      syncDmDevices: async () => undefined,
      sendRumor: async (_groupId: string, rumor: unknown) => {
        sent.push(rumor);
        return { 'wss://r1': true };
      },
    } as unknown as MarmotSession);
  });
  afterEach(() => setMarmotSession(null));

  it.each([16, 17])('buildMarmotRumor rejects kind %i', (kind) => {
    expect(() => buildMarmotRumor(ME, { kind, content: '' })).toThrow(WrapOnlyKindError);
  });

  it.each([16, 17])(
    'sendMarmotDm / sendMarmotGroupRumor fail kind %i without sending',
    async (kind) => {
      const dm = await sendMarmotDm(ME, SELLER, { kind, content: '', tags: [['p', SELLER]] });
      const group = await sendMarmotGroupRumor(ME, 'marmot:group', { kind, content: '' });
      expect(dm.success).toBe(false);
      expect(group.success).toBe(false);
      expect(sent).toHaveLength(0);
    },
  );

  it('still sends ordinary chat text', async () => {
    const dm = await sendMarmotDm(ME, SELLER, { kind: 14, content: 'hi' });
    expect(dm.success).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe('incoming kind 16/17 never render as chat text', () => {
  const order = parseOrderEvent({
    kind: 16,
    content: 'Please gift-wrap',
    tags: [
      ['type', '1'],
      ['order', 'o-1'],
      ['amount', '21'],
      ['item', `30402:${SELLER}:mug`, '1'],
    ],
  })!;

  it('an order row renders as a structured card', () => {
    const items = buildConversationItems(
      [{ id: 'm1', fromMe: false, text: serializeOrder(order), createdAt: 10, wireKind: 16 }],
      [],
    );
    expect(items.filter((i) => i.kind !== 'dayHeader').map((i) => i.kind)).toEqual(['order']);
  });

  it.each([16, 17])('a non-order kind-%i row stays out of chat', (wireKind) => {
    const repost = JSON.stringify({ kind: 1, content: 'reposted note', tags: [] });
    const items = buildConversationItems(
      [{ id: 'm2', fromMe: false, text: repost, createdAt: 10, wireKind }],
      [],
    );
    const kinds = items.filter((i) => i.kind !== 'dayHeader').map((i) => i.kind);
    expect(kinds).toEqual([]);
    expect(kinds).not.toContain('message');
  });
});
