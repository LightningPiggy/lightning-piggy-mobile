// Legacy text-poll votes must stay in the thread's own protocol (#1122): a
// vote in a NIP-04 thread falling back to NIP-17 would vanish from the poll
// and land in the other thread.
import { act, renderHook } from '@testing-library/react-native';
import { useConversationPolls } from './useConversationPolls';
import { buildPollMessage } from '../utils/pollMessage';
import type { ConversationMessage } from '../contexts/nostrContextTypes';
import { useMessageSend } from '../contexts/useMessageSend';
import { getMarmotSession } from '../services/marmotSession';
import { sendMarmotDm } from '../services/marmotSend';
import { sendNip17ToManyWithNsec } from '../services/nostrService';
import { preferredDmProtocol } from '../services/preferredDmProtocol';
import { directMessageRumorEventId } from '../services/dmRumorId';
import { buildPollRumor, POLL_KIND, VOTE_KIND, serializePollFromRumor } from '../utils/nip88Poll';
import { protocolForWireKind } from '../utils/dmProtocol';

jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('../services/marmotSession', () => ({ getMarmotSession: jest.fn() }));
jest.mock('../services/marmotSend', () => ({ sendMarmotDm: jest.fn() }));
jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: ['wss://relay.example'],
  sendNip17ToManyWithNsec: jest.fn(),
}));
jest.mock('../services/nostrNip04Send', () => ({ sendNip04Message: jest.fn() }));
jest.mock('../services/amberService', () => ({}));
jest.mock('../services/nostrConnectService', () => ({}));
// Fake timers also fake requestAnimationFrame: skip the paint-a-frame yield.
jest.mock('../contexts/nostrDecryptPacing', () => ({
  ...jest.requireActual('../contexts/nostrDecryptPacing'),
  paintOptimisticBubble: async () => undefined,
}));
jest.mock('../contexts/nostrSecretKeyCache', () => ({
  getMemoisedSecretKey: jest.fn().mockResolvedValue(new Uint8Array(32)),
}));

const PEER = 'b'.repeat(64);
const poll: ConversationMessage = {
  id: 'poll-1',
  fromMe: false,
  text: buildPollMessage('Pizza?', ['Yes', 'No']),
  createdAt: 1,
  wireKind: 4,
};

function setup(protocol: 'nip04' | 'nip17') {
  const sendDirectMessage = jest.fn().mockResolvedValue({ success: true });
  let rows: ConversationMessage[] = [poll];
  const setMessages = jest.fn((update: React.SetStateAction<ConversationMessage[]>) => {
    rows = typeof update === 'function' ? update(rows) : update;
  });
  const { result } = renderHook(() =>
    useConversationPolls({
      messages: [poll],
      myPubkey: 'a'.repeat(64),
      pubkey: PEER,
      sendDirectMessage,
      protocol,
      sendDirectRumor: jest.fn(),
      appendLocalDmMessage: jest.fn(),
      setMessages,
    }),
  );
  return { result, sendDirectMessage, getRows: () => rows };
}

it.each([
  ['nip04', 4],
  ['nip17', 14],
] as const)(
  'sends a legacy %s vote in that thread and tags the optimistic row',
  async (protocol, kind) => {
    const { result, sendDirectMessage, getRows } = setup(protocol);
    await act(async () => {
      await result.current.handleVotePoll('poll-1', '1');
    });
    expect(sendDirectMessage).toHaveBeenCalledWith(PEER, expect.any(String), { protocol });
    expect(getRows().at(-1)).toMatchObject({ fromMe: true, wireKind: kind });
  },
);

describe('structured polls in an open thread with a Marmot-capable recipient (#1498)', () => {
  const viewer = 'a'.repeat(64);
  let rumor: ReturnType<typeof buildPollRumor>;
  let structuredPoll: ConversationMessage;

  beforeEach(() => {
    // Event hashing schedules a dev-only crypto performance summary.
    jest.useFakeTimers();
    jest.clearAllMocks();
    rumor = buildPollRumor({
      senderPubkey: PEER,
      recipientPubkeys: [viewer],
      question: 'Pizza?',
      options: ['Yes', 'No'],
    });
    structuredPoll = {
      id: 'structured-poll',
      fromMe: false,
      text: serializePollFromRumor(rumor)!,
      createdAt: rumor.created_at,
      wireKind: POLL_KIND,
    };
    jest.mocked(getMarmotSession).mockReturnValue({
      pubkey: viewer,
      findDm: jest.fn().mockReturnValue({ id: 'secure-dm' }),
    } as unknown as NonNullable<ReturnType<typeof getMarmotSession>>);
    jest.mocked(sendNip17ToManyWithNsec).mockResolvedValue({
      wrapsPublished: 2,
      errors: [],
      delivery: { delivered: true },
    } as unknown as Awaited<ReturnType<typeof sendNip17ToManyWithNsec>>);
    jest.mocked(sendMarmotDm).mockImplementation(async (_viewer, _peer, outgoing, hooks) => {
      hooks?.onRumorReady?.({
        eventId: directMessageRumorEventId({
          ...outgoing,
          pubkey: _viewer,
          tags: outgoing.tags ?? [],
          created_at: outgoing.created_at ?? Math.floor(Date.now() / 1000),
        }),
        kind: outgoing.kind,
        relays: [],
      });
      return { success: true };
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each([
    ['nip17', 'poll', POLL_KIND],
    ['nip17', 'vote', VOTE_KIND],
    ['marmot', 'poll', POLL_KIND],
    ['marmot', 'vote', VOTE_KIND],
  ] as const)(
    'keeps the open %s thread for a structured %s and persists a matching row',
    async (protocol, action, kind) => {
      // Without a thread override this recipient really would select Marmot.
      expect(await preferredDmProtocol(viewer, PEER)).toBe('marmot');
      let rows: ConversationMessage[] = [structuredPoll];
      const appendLocalDmMessage = jest.fn().mockResolvedValue(undefined);
      const setMessages = jest.fn((update: React.SetStateAction<ConversationMessage[]>) => {
        rows = typeof update === 'function' ? update(rows) : update;
      });
      const { result } = renderHook(() => {
        const send = useMessageSend({
          pubkey: viewer,
          isLoggedIn: true,
          signerType: 'nsec',
          relays: [],
        });
        return useConversationPolls({
          messages: [structuredPoll],
          myPubkey: viewer,
          pubkey: PEER,
          protocol,
          sendDirectMessage: send.sendDirectMessage,
          sendDirectRumor: send.sendDirectRumor,
          appendLocalDmMessage,
          setMessages,
        });
      });

      await act(async () => {
        if (action === 'poll') {
          expect(await result.current.handleSendPoll('Dinner?', ['Pizza', 'Pasta'])).toBe(true);
        } else {
          await result.current.handleVotePoll(directMessageRumorEventId(rumor), '1');
        }
      });

      if (protocol === 'nip17') {
        expect(sendNip17ToManyWithNsec).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientPubkeys: [PEER],
            rumor: expect.objectContaining({ kind }),
          }),
        );
        expect(sendMarmotDm).not.toHaveBeenCalled();
      } else {
        expect(sendMarmotDm).toHaveBeenCalledWith(
          viewer,
          PEER,
          expect.objectContaining({ kind }),
          expect.objectContaining({ protocol }),
        );
        expect(sendNip17ToManyWithNsec).not.toHaveBeenCalled();
      }
      const row = rows.find((message) => message.fromMe && message.wireKind === kind)!;
      expect(row).toMatchObject({ id: expect.stringMatching(/^local-/), fromMe: true });
      expect(protocolForWireKind(row.wireKind, row.protocol)).toBe(protocol);
      expect(appendLocalDmMessage).toHaveBeenCalledWith(PEER, row);
      expect(appendLocalDmMessage).toHaveBeenCalledTimes(1);
    },
  );
});
