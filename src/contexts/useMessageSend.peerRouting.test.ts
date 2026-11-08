// Which recipients a 1:1 send marks as chosen for inbox-relay routing (#1749).
import { renderHook } from '@testing-library/react-native';
import * as nostrService from '../services/nostrService';
import { sendNip04Message } from '../services/nostrNip04Send';
import { useMessageSend } from './useMessageSend';

jest.mock('../services/nostrService', () => ({
  createDirectMessageRumor: jest.fn(() => ({
    kind: 14,
    created_at: 1,
    tags: [],
    content: 'hi',
    pubkey: 'e'.repeat(64),
  })),
  sendNip17ToManyWithNsec: jest.fn(async () => ({
    wrapsPublished: 2,
    errors: [],
    wrapOutcomes: [],
    delivery: { delivered: true },
  })),
}));
jest.mock('../services/nostrNip04Send', () => ({
  sendNip04Message: jest.fn(async () => ({
    wrapsPublished: 1,
    errors: [],
    wrapOutcomes: [],
    delivery: { delivered: true },
    rumorCreatedAt: 1,
  })),
}));
jest.mock('../services/marmotSend', () => ({ sendMarmotDm: jest.fn() }));
jest.mock('../services/amberService', () => ({}));
jest.mock('../services/nostrConnectService', () => ({}));
jest.mock('../services/preferredDmProtocol', () => ({
  preferredDmProtocol: jest.fn(async (_v: string, _p: string, explicit?: string) => explicit ?? 'nip17'), // prettier-ignore
}));
jest.mock('./nostrSecretKeyCache', () => ({
  getMemoisedSecretKey: jest.fn(async () => new Uint8Array(32)),
}));
jest.mock('./nostrDecryptPacing', () => ({ paintOptimisticBubble: jest.fn(async () => {}) }));

const me = 'e'.repeat(64);
const peer = 'a'.repeat(64);

function send() {
  const { result } = renderHook(() =>
    useMessageSend({
      pubkey: me,
      isLoggedIn: true,
      signerType: 'nsec',
      relays: [{ url: 'wss://mine.example.com', read: true, write: true }],
    }),
  );
  return result.current.sendDirectMessage;
}

const nip17Routing = () =>
  jest.mocked(nostrService.sendNip17ToManyWithNsec).mock.calls.at(-1)![0].peerRouting;

beforeEach(() => jest.clearAllMocks());

it('marks the peer of a 1:1 as chosen', async () => {
  await send()(peer, 'hi');
  expect(nip17Routing()).toEqual(expect.objectContaining({ chosenRecipients: [peer] }));
});

it('marks the peer of a NIP-04 1:1 as chosen too', async () => {
  await send()(peer, 'hi', { protocol: 'nip04' });
  expect(jest.mocked(sendNip04Message).mock.calls[0][0].peerRouting).toEqual(
    expect.objectContaining({ chosenRecipients: [peer] }),
  );
});

it('turns routing off when the recipient is a key, not a person (NIP-171 leave)', async () => {
  await send()(peer, '-', { protocol: 'nip17', peerRouting: false });
  expect(nip17Routing()).toBe(false);
});
