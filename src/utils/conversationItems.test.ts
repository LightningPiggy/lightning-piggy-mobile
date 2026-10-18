// Tests for the pure 1:1-conversation item-building extracted from
// ConversationScreen. classifyMessageContent is the only collaborator; we let
// the real one run (it's pure regex/parse) so gif/location detection is
// exercised end-to-end.
//
// classifyMessageContent → messageContent → boltzService pulls in
// bitcoinjs-lib's bip32 (ESM Jest can't resolve under jest-expo). Mock the one
// helper that drags it in; we don't exercise bitcoin-address detection here.
import {
  buildConversationItems,
  buildZapItems,
  formatDayHeader,
  orderIdsNeedingHistory,
  suppressDuplicateOrderInvoiceNotes,
  type ConversationMessageInput,
  type TimedItem,
} from './conversationItems';
import { NWC_SHARE_KIND } from './nwcShareMessage';
import type { WalletState, ZapCounterpartyInfo } from '../types/wallet';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useChatLocalHistory } from '../hooks/useChatLocalHistory';

jest.mock('../services/boltzService', () => ({
  isBitcoinAddress: () => false,
}));

const PEER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// Minimal zap-counterparty builder — only `pubkey` + `comment` matter to the
// builders under test; the rest of ZapCounterpartyInfo is filled with nulls.
function cp(pubkey: string, comment = ''): ZapCounterpartyInfo {
  return { pubkey, comment, profile: null, anonymous: false };
}

// 2024-06-15 12:00:00 UTC and 2024-06-14 12:00:00 UTC — fixed so day-grouping
// is deterministic regardless of the runner's clock for the relative labels we
// don't assert on.
const DAY2 = Math.floor(Date.UTC(2024, 5, 15, 12) / 1000);
const DAY1 = Math.floor(Date.UTC(2024, 5, 14, 12) / 1000);

function walletWithTx(tx: Partial<WalletState['transactions'][number]>): WalletState {
  return {
    transactions: [
      {
        type: 'incoming',
        amount: 1000,
        created_at: DAY2,
        ...tx,
      } as WalletState['transactions'][number],
    ],
  } as WalletState;
}

describe('buildConversationItems', () => {
  it.each(['nip17:peer', 'marmot:peer'])(
    'keeps same-second arrivals in the rendered timeline after clearing %s',
    async (thread) => {
      await AsyncStorage.clear();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(DAY2 * 1000);
      const raw: ConversationMessageInput[] = [
        { id: 'old', fromMe: false, text: 'old', createdAt: DAY2 - 1 },
        { id: 'cleared', fromMe: false, text: 'cleared', createdAt: DAY2 },
        { id: 'future', fromMe: false, text: 'future', createdAt: DAY2 + 86400 },
      ];
      const hook = renderHook(
        ({ messages }: { messages: ConversationMessageInput[] }) => {
          const history = useChatLocalHistory('owner', thread, messages);
          return {
            ...history,
            items: buildConversationItems(
              history.messages,
              [],
              undefined,
              [],
              'en',
              [],
              history.clearBoundary,
            ),
          };
        },
        { initialProps: { messages: raw } },
      );
      try {
        await waitFor(() => expect(hook.result.current.messages).toEqual(raw));
        await act(() => hook.result.current.clear());
        expect(hook.result.current.items).toEqual([]);
        hook.rerender({
          messages: [...raw, { id: 'arriving', fromMe: false, text: 'new', createdAt: DAY2 }],
        });
        expect(hook.result.current.items.filter((i) => i.kind !== 'dayHeader')).toEqual([
          expect.objectContaining({ kind: 'message', id: 'dm-arriving', createdAt: DAY2 }),
        ]);
      } finally {
        hook.unmount();
        clock.mockRestore();
      }
    },
  );

  it('applies the clear cutoff only to supplemental zaps, invites and device notices', () => {
    const times = [DAY2 - 1, DAY2, DAY2 + 1];
    const zaps = buildZapItems(
      times.map((at) =>
        walletWithTx({ paymentHash: `zap-${at}`, settled_at: at, zapCounterparty: cp(PEER) }),
      ),
      PEER,
    );
    const items = buildConversationItems(
      [{ id: 'arriving', fromMe: false, text: 'new', createdAt: DAY2 }],
      zaps,
      undefined,
      times.map((at) => ({ id: `invite-${at}`, createdAt: at })),
      'en',
      times.map((at) => ({
        id: `notice-${at}`,
        createdAt: at,
        isSelf: false,
        joined: true,
        clients: [],
      })),
      DAY2,
    ).filter((i) => i.kind !== 'dayHeader');
    expect(items).toHaveLength(4);
    expect(items.filter((i) => i.kind !== 'message').map((i) => i.createdAt)).toEqual([
      DAY2 + 1,
      DAY2 + 1,
      DAY2 + 1,
    ]);
    expect(items[3]).toMatchObject({ kind: 'message', id: 'dm-arriving', createdAt: DAY2 });
  });

  it('returns an empty array for no messages and no zaps', () => {
    expect(buildConversationItems([], [])).toEqual([]);
  });

  it('classifies plain text as a message and sorts newest-first', () => {
    const messages: ConversationMessageInput[] = [
      { id: '1', fromMe: false, text: 'older', createdAt: DAY1 },
      { id: '2', fromMe: true, text: 'newer', createdAt: DAY2 },
    ];
    const items = buildConversationItems(messages, []);
    const nonHeaders = items.filter((i) => i.kind !== 'dayHeader');
    expect(nonHeaders[0]).toMatchObject({ kind: 'message', id: 'dm-2', text: 'newer' });
    expect(nonHeaders[1]).toMatchObject({ kind: 'message', id: 'dm-1', text: 'older' });
  });

  it('inserts a day-header divider between messages from different days', () => {
    const messages: ConversationMessageInput[] = [
      { id: '1', fromMe: false, text: 'day one', createdAt: DAY1 },
      { id: '2', fromMe: true, text: 'day two', createdAt: DAY2 },
    ];
    const headers = buildConversationItems(messages, []).filter((i) => i.kind === 'dayHeader');
    // Two distinct days → a divider after each day's group (inverted list).
    expect(headers.length).toBe(2);
  });

  it('detects a gif URL and tags it as a gif item', () => {
    const items = buildConversationItems(
      [
        {
          id: 'g',
          fromMe: true,
          text: 'https://media.giphy.com/media/abc/giphy.gif',
          createdAt: DAY2,
        },
      ],
      [],
    );
    expect(items.find((i) => i.kind === 'gif')).toMatchObject({ kind: 'gif', id: 'dm-g' });
  });

  it('builds an nwcShare card from an NWC-share row, or unsupported when corrupt', () => {
    const nwcUrl =
      'nostr+walletconnect://b0e2c8f9b0e2c8f9b0e2c8f9b0e2c8f9b0e2c8f9b0e2c8f9b0e2c8f9b0e2c8f9' +
      '?relay=wss%3A%2F%2Frelay.example.com&secret=abcdef0123456789abcdef0123456789';
    const items = buildConversationItems(
      [
        {
          id: 'w',
          fromMe: false,
          text: JSON.stringify({ nwcUrl, walletName: 'Pocket money' }),
          createdAt: DAY2,
          wireKind: NWC_SHARE_KIND,
        },
        // A corrupt NWC-share row must NOT leak its content as a bubble.
        { id: 'bad', fromMe: false, text: 'not json', createdAt: DAY1, wireKind: NWC_SHARE_KIND },
      ],
      [],
    );
    expect(items.find((i) => i.kind === 'nwcShare')).toMatchObject({
      kind: 'nwcShare',
      id: 'dm-w',
      card: { nwcUrl, walletName: 'Pocket money' },
    });
    expect(items.find((i) => i.id === 'dm-bad')).toMatchObject({
      kind: 'unsupported',
      rawKind: NWC_SHARE_KIND,
    });
  });

  it('merges zap items in with messages by timestamp', () => {
    const zaps = buildZapItems(
      [
        walletWithTx({
          type: 'incoming',
          amount: 500,
          settled_at: DAY2 + 10,
          paymentHash: 'hash1',
          zapCounterparty: cp(PEER, 'gm'),
        }),
      ],
      PEER,
    );
    const items = buildConversationItems(
      [{ id: '1', fromMe: false, text: 'hi', createdAt: DAY2 }],
      zaps,
    );
    const zapItem = items.find((i) => i.kind === 'zap');
    expect(zapItem).toMatchObject({ kind: 'zap', amountSats: 500, comment: 'gm' });
  });
});

describe('buildZapItems', () => {
  it('includes only txs whose zap counterparty is this peer', () => {
    const wallets = [
      walletWithTx({ paymentHash: 'h1', settled_at: DAY2, zapCounterparty: cp(PEER) }),
      walletWithTx({ paymentHash: 'h2', settled_at: DAY2, zapCounterparty: cp(OTHER) }),
    ];
    const out = buildZapItems(wallets, PEER);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'zap', fromMe: false });
  });

  it('marks outgoing txs as fromMe and uses the absolute amount', () => {
    const out = buildZapItems(
      [
        walletWithTx({
          type: 'outgoing',
          amount: -250,
          settled_at: DAY2,
          paymentHash: 'h3',
          zapCounterparty: cp(PEER),
        }),
      ],
      PEER,
    );
    expect(out[0]).toMatchObject({ fromMe: true, amountSats: 250 });
  });

  it('skips txs with no settled_at or created_at timestamp', () => {
    const out = buildZapItems(
      [
        walletWithTx({
          created_at: undefined,
          settled_at: undefined,
          zapCounterparty: cp(PEER),
        }),
      ],
      PEER,
    );
    expect(out).toHaveLength(0);
  });
});

describe('buildConversationItems — unsupported message-kind fallback', () => {
  it('maps a message whose wireKind we do not render to an `unsupported` item', () => {
    const messages: ConversationMessageInput[] = [
      // kind 30023 (long-form article) is not a renderable DM kind.
      {
        id: '1',
        fromMe: false,
        text: 'whatever the raw body is',
        createdAt: DAY2,
        wireKind: 30023,
      },
    ];
    const items = buildConversationItems(messages, []).filter((i) => i.kind !== 'dayHeader');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'unsupported',
      id: 'dm-1',
      fromMe: false,
      rawKind: 30023,
      createdAt: DAY2,
    });
  });

  it('does NOT mark plain text (no wireKind) as unsupported', () => {
    const items = buildConversationItems(
      [{ id: '1', fromMe: false, text: 'hi', createdAt: DAY2 }],
      [],
    ).filter((i) => i.kind !== 'dayHeader');
    expect(items[0].kind).toBe('message');
  });
});

describe('buildConversationItems — structured NIP-88 polls (#203)', () => {
  const pollJson = JSON.stringify({
    pollId: 'poll-1',
    author: PEER,
    question: 'Dinner?',
    options: [
      { id: '1', label: 'Pasta' },
      { id: '2', label: 'Curry' },
    ],
    pollType: 'singlechoice',
  });

  it('renders a kind-1068 row as a poll item keyed by the embedded pollId', () => {
    const items = buildConversationItems(
      [{ id: 'w1', fromMe: false, text: pollJson, createdAt: DAY2, wireKind: 1068 }],
      [],
    ).filter((i) => i.kind !== 'dayHeader');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'poll',
      id: 'dm-w1',
      pollId: 'poll-1',
      fromMe: false,
    });
    expect(items[0]).toHaveProperty('poll.question', 'Dinner?');
  });

  it('drops a kind-1018 vote row from the visible list', () => {
    const voteJson = JSON.stringify({
      pollId: 'poll-1',
      voter: PEER,
      optionIds: ['1'],
      createdAt: DAY2,
    });
    const items = buildConversationItems(
      [
        { id: 'w1', fromMe: false, text: pollJson, createdAt: DAY1, wireKind: 1068 },
        { id: 'w2', fromMe: true, text: voteJson, createdAt: DAY2, wireKind: 1018 },
      ],
      [],
    ).filter((i) => i.kind !== 'dayHeader');
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('poll');
  });

  it('falls back to the unsupported placeholder for a corrupt kind-1068 row', () => {
    const items = buildConversationItems(
      [{ id: 'w1', fromMe: false, text: 'not json', createdAt: DAY2, wireKind: 1068 }],
      [],
    ).filter((i) => i.kind !== 'dayHeader');
    expect(items[0]).toMatchObject({ kind: 'unsupported', rawKind: 1068 });
  });

  it('does NOT mark renderable wire kinds (4/14/15) as unsupported', () => {
    for (const wireKind of [4, 14, 15]) {
      const items = buildConversationItems(
        [{ id: '1', fromMe: false, text: 'hi', createdAt: DAY2, wireKind }],
        [],
      ).filter((i) => i.kind !== 'dayHeader');
      expect(items[0].kind).toBe('message');
    }
  });

  it('renders a valid kind-16 order as a structured card', () => {
    const orderJson = JSON.stringify({
      kind: 16,
      orderId: 'abc-123',
      type: 'order',
      items: [],
      message: '',
    });
    const items = buildConversationItems(
      [{ id: '1', fromMe: false, text: orderJson, createdAt: DAY2, wireKind: 16 }],
      [],
    ).filter((i) => i.kind !== 'dayHeader');
    expect(items).toEqual([expect.objectContaining({ kind: 'order', id: 'dm-1' })]);
  });

  it('hides an unparseable kind-16/17 row from chat', () => {
    // A non-order payload sharing the kind (e.g. a NIP-18 repost) or a corrupt row.
    const notAnOrder = JSON.stringify({ kind: 1, id: 'abc', content: 'gm' });
    const items = buildConversationItems(
      [{ id: '1', fromMe: false, text: notAnOrder, createdAt: DAY2, wireKind: 16 }],
      [],
    ).filter((i) => i.kind !== 'dayHeader');
    expect(items).toEqual([]);
  });
});

describe('buildConversationItems — duplicate order-invoice note dedup', () => {
  // A bech32 data part comfortably over the {50,} floor the bolt11 regex
  // shares with INVOICE_REGEX. Two distinct invoices for the no-match case.
  const DATA = '210n1p' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2);
  const INVOICE = `lnbc${DATA}`;
  const OTHER_INVOICE = `lntb${DATA}`;

  // kind-16 type-2 "Payment" order card JSON carrying `invoice` as its payable
  // bolt11 — exactly what the order-service sends as the rich card.
  const paymentOrderJson = (invoice: string, orderId = 'order-abc'): string =>
    JSON.stringify({
      kind: 16,
      type: 'payment',
      orderId,
      items: [],
      message: '',
      payment: { method: 'lightning', value: invoice },
    });

  // The kind-14 chat-note fallback: a human-readable line + the SAME raw bolt11.
  const noteText = (invoice: string): string =>
    `New order — please pay ${invoice} to confirm. Thanks!`;

  const cardMsg = (invoice: string): ConversationMessageInput => ({
    id: 'card',
    fromMe: false,
    text: paymentOrderJson(invoice),
    createdAt: DAY2 + 1,
    wireKind: 16,
  });
  const noteMsg = (invoice: string): ConversationMessageInput => ({
    id: 'note',
    fromMe: false,
    text: noteText(invoice),
    createdAt: DAY2,
    wireKind: 14,
  });

  const nonHeader = (msgs: ConversationMessageInput[]) =>
    buildConversationItems(msgs, []).filter((i) => i.kind !== 'dayHeader');

  it('suppresses the kind-14 note when a matching kind-16 order card exists', () => {
    const items = nonHeader([cardMsg(INVOICE), noteMsg(INVOICE)]);
    expect(items).toEqual([expect.objectContaining({ kind: 'order', id: 'dm-card' })]);
  });

  it('suppresses regardless of arrival order (note before OR after the card)', () => {
    const noteFirst = nonHeader([noteMsg(INVOICE), cardMsg(INVOICE)]);
    const cardFirst = nonHeader([cardMsg(INVOICE), noteMsg(INVOICE)]);
    for (const items of [noteFirst, cardFirst]) {
      expect(items).toEqual([expect.objectContaining({ kind: 'order', id: 'dm-card' })]);
    }
  });

  it('shows the kind-14 note when no kind-16 order card is present (fallback)', () => {
    const items = nonHeader([noteMsg(INVOICE)]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', id: 'dm-note' });
  });

  it('shows the note when the order card carries a DIFFERENT invoice', () => {
    const items = nonHeader([cardMsg(OTHER_INVOICE), noteMsg(INVOICE)]);
    expect(items.some((i) => i.kind === 'order')).toBe(true);
    expect(items.some((i) => i.kind === 'message' && i.id === 'dm-note')).toBe(true);
  });

  it('never suppresses a non-order kind-14 chat message (no invoice)', () => {
    const items = nonHeader([
      cardMsg(INVOICE),
      { id: 'chat', fromMe: false, text: 'gm, when does it ship?', createdAt: DAY2, wireKind: 14 },
    ]);
    expect(items.some((i) => i.kind === 'message' && i.id === 'dm-chat')).toBe(true);
  });

  it('does NOT suppress a non-kind-14 row (e.g. NIP-04 kind-4) sharing the invoice', () => {
    // Only a kind-14 NIP-17 note is the order-invoice fallback; a kind-4 message
    // that happens to quote the same invoice must stay.
    const items = nonHeader([
      cardMsg(INVOICE),
      { id: 'nip04', fromMe: false, text: noteText(INVOICE), createdAt: DAY2, wireKind: 4 },
    ]);
    expect(items.some((i) => i.kind === 'message' && i.id === 'dm-nip04')).toBe(true);
  });

  it('does NOT suppress when the only card is a non-payable order (kind-16 type-1 placed)', () => {
    // An order-placed card has no payable bolt11, so it can never shadow a note.
    const placedJson = JSON.stringify({
      kind: 16,
      type: 'order',
      orderId: 'order-abc',
      items: [],
      message: '',
    });
    const items = nonHeader([
      { id: 'card', fromMe: false, text: placedJson, createdAt: DAY2 + 1, wireKind: 16 },
      noteMsg(INVOICE),
    ]);
    expect(items.some((i) => i.kind === 'message' && i.id === 'dm-note')).toBe(true);
  });

  describe('suppressDuplicateOrderInvoiceNotes (unit)', () => {
    const orderItem = (invoice: string): TimedItem => ({
      kind: 'order',
      id: 'dm-card',
      fromMe: false,
      createdAt: DAY2 + 1,
      order: {
        kind: 16,
        type: 'payment',
        orderId: 'order-abc',
        items: [],
        message: '',
        payment: { method: 'lightning', value: invoice },
      },
    });
    const messageItem = (text: string, wireKind = 14): TimedItem => ({
      kind: 'message',
      id: 'dm-note',
      fromMe: false,
      text,
      createdAt: DAY2,
      wireKind,
    });

    it('drops only the matching kind-14 message item', () => {
      const out = suppressDuplicateOrderInvoiceNotes([
        orderItem(INVOICE),
        messageItem(noteText(INVOICE)),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe('order');
    });

    it('is a no-op when there are no order cards', () => {
      const input: TimedItem[] = [messageItem(noteText(INVOICE))];
      expect(suppressDuplicateOrderInvoiceNotes(input)).toEqual(input);
    });
  });
});

describe('formatDayHeader', () => {
  // Build an epoch (seconds) at NOON on the calendar day `offsetDays` from
  // today. Calendar arithmetic via setDate + noon means a DST ±1h shift can't
  // push the timestamp across a day boundary (which `now - 24*3600` could).
  const noonEpochOffset = (offsetDays: number): number => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    d.setHours(12, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };

  it('labels today and yesterday relatively', () => {
    expect(formatDayHeader(noonEpochOffset(0))).toBe('Today');
    expect(formatDayHeader(noonEpochOffset(-1))).toBe('Yesterday');
  });

  it('falls back to a numeric date for older days', () => {
    const label = formatDayHeader(DAY1);
    expect(label).not.toBe('Today');
    expect(label).not.toBe('Yesterday');
    expect(label).toMatch(/\d/);
  });
});

describe('Gamma orders appear as cards in chat', () => {
  it.each(['order', 'payment', 'status', 'shipping', 'receipt'])(
    'renders %s in both directions',
    (type) => {
      for (const fromMe of [true, false]) {
        const wireKind = type === 'receipt' ? 17 : 16;
        expect(
          buildConversationItems(
            [
              {
                id: 'order',
                fromMe,
                createdAt: DAY2,
                wireKind,
                text: JSON.stringify({
                  kind: wireKind,
                  type,
                  orderId: 'o',
                  items: [],
                  message: 'private',
                }),
              },
              { id: 'chat', fromMe: false, createdAt: DAY2, wireKind: 14, text: 'hello' },
            ],
            [],
          ).filter((item) => item.kind !== 'dayHeader'),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'message', id: 'dm-chat', text: 'hello' }),
            expect.objectContaining({ kind: 'order', id: 'dm-order', fromMe }),
          ]),
        );
      }
    },
  );
});

describe('orderIdsNeedingHistory', () => {
  const stored = (id: string, fromMe: boolean, type: string, orderId: string, payable = false) => ({
    id,
    fromMe,
    createdAt: DAY2,
    wireKind: 16,
    text: JSON.stringify({
      kind: 16,
      type,
      orderId,
      items: [],
      message: '',
      ...(payable ? { payment: { method: 'lightning', value: `lnbc1${'a'.repeat(60)}` } } : {}),
    }),
  });
  it('lists received payable requests whose outgoing order is not loaded, sorted + deduped', () => {
    expect(
      orderIdsNeedingHistory([
        stored('r1', false, 'payment', 'old-b', true),
        stored('r2', false, 'payment', 'old-a', true),
        stored('r3', false, 'payment', 'old-a', true),
        stored('r4', false, 'payment', 'loaded', true),
        stored('o1', true, 'order', 'loaded'),
      ]),
    ).toEqual(['old-a', 'old-b']);
  });
  it('includes received kind-17 receipts whose order is not loaded', () => {
    const receipt = {
      id: 'rc1',
      fromMe: false,
      createdAt: DAY2,
      wireKind: 17,
      text: JSON.stringify({ kind: 17, type: 'receipt', orderId: 'old-receipt', items: [], message: '' }), // prettier-ignore
    };
    expect(orderIdsNeedingHistory([receipt])).toEqual(['old-receipt']);
  });
  it('ignores requests without a payable invoice and merchant-authored "orders"', () => {
    expect(
      orderIdsNeedingHistory([
        stored('r1', false, 'payment', 'no-invoice'),
        stored('r2', false, 'payment', 'forged', true),
        stored('f1', false, 'order', 'forged'),
        { id: 'chat', fromMe: false, createdAt: DAY2, wireKind: 14, text: 'hello' },
      ]),
    ).toEqual(['forged']);
  });
});

describe('buildConversationItems — Marmot replies and edits', () => {
  const base = (over: Partial<ConversationMessageInput>): ConversationMessageInput => ({
    id: 'm',
    fromMe: false,
    text: 'x',
    createdAt: 1,
    wireKind: 14,
    ...over,
  });
  const messageItems = (msgs: ConversationMessageInput[]) =>
    buildConversationItems(msgs, []).filter((i) => i.kind === 'message');

  it('attaches the quoted parent to a reply', () => {
    const items = messageItems([
      base({ id: 'p', fromMe: true, text: 'parent text', createdAt: 1 }),
      base({ id: 'r', text: 'the reply', createdAt: 2, replyTo: 'p' }),
    ]);
    const reply = items.find((i) => i.id === 'dm-r');
    expect(reply).toMatchObject({ quote: { text: 'parent text', fromMe: true } });
    expect(items.find((i) => i.id === 'dm-p')).not.toHaveProperty('quote');
  });

  it('flags a reply whose parent is not loaded', () => {
    const [reply] = messageItems([base({ id: 'r', replyTo: 'old' })]);
    expect(reply).toMatchObject({ quote: { text: null } });
  });

  it('quotes the parent on GIF and location replies too (not just text)', () => {
    const items = buildConversationItems(
      [
        base({ id: 'p', fromMe: true, text: 'parent text', createdAt: 1 }),
        base({ id: 'g', text: 'https://media.giphy.com/media/abc/giphy.gif', replyTo: 'p' }),
        base({ id: 'l', text: 'geo:51.5,-0.12', replyTo: 'p' }),
      ],
      [],
    );
    expect(items.find((i) => i.id === 'dm-g')).toMatchObject({
      kind: 'gif',
      quote: { text: 'parent text' },
    });
    expect(items.find((i) => i.id === 'dm-l')).toMatchObject({
      kind: 'location',
      quote: { text: 'parent text' },
    });
  });

  it('marks an edited message', () => {
    const items = messageItems([
      base({ id: 'e', text: 'v2', editedAt: 5 }),
      base({ id: 'n', text: 'plain' }),
    ]);
    expect(items.find((i) => i.id === 'dm-e')).toMatchObject({ edited: true });
    expect(items.find((i) => i.id === 'dm-n')).not.toHaveProperty('edited');
  });
});

describe('buildConversationItems — Marmot device notices (#1267)', () => {
  it('interleaves local device notices by time, never as bubbles from anyone', () => {
    const items = buildConversationItems(
      [
        { id: 'm1', text: 'hi', fromMe: false, createdAt: DAY2 } as ConversationMessageInput,
        { id: 'm2', text: 'yo', fromMe: true, createdAt: DAY2 + 60 } as ConversationMessageInput,
      ],
      [],
      undefined,
      [],
      'en-GB',
      [
        {
          id: 'n1',
          createdAt: DAY2 + 30,
          isSelf: false,
          joined: true,
          clients: ['White Noise', 'Lightning Piggy'],
        },
      ],
    );
    const timed = items.filter((i) => i.kind !== 'dayHeader');
    expect(timed.map((i) => i.id)).toEqual(['dm-m2', 'device-n1', 'dm-m1']);
    expect(timed[1]).toEqual({
      kind: 'deviceNotice',
      id: 'device-n1',
      fromMe: false,
      createdAt: DAY2 + 30,
      isSelf: false,
      joined: true,
      clients: ['White Noise', 'Lightning Piggy'],
    });
  });
});

it.each([14, 15])('binds file actions to kind %s before geo detection', (wireKind) => {
  const text =
    '[FILE]' +
    JSON.stringify({
      name: 'geo:1,2.pdf',
      caption: 'geo:1,2',
      mime: 'application/pdf',
      encrypted: false,
      url: 'https://example.com/file',
    });
  const item = buildConversationItems(
    [{ id: 'f', fromMe: false, text, wireKind, createdAt: 1 }],
    [],
  ).find((row) => row.id === 'dm-f');
  if (wireKind === 15)
    expect(item).toMatchObject({ kind: 'message', file: { name: 'geo:1,2.pdf' } });
  else expect(item).not.toHaveProperty('file');
});
