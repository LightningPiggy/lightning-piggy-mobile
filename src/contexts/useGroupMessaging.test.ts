import { renderHook } from '@testing-library/react-native';
import { useGroupMessaging } from './useGroupMessaging';
import type { SignerType } from '../types/nostr';

const mockNsecSend = jest.fn();
const mockSignerSend = jest.fn();
const mockMarmotSend = jest.fn();
jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: ['wss://default'],
  createGroupChatRumor: () => ({ kind: 14, content: 'hello', tags: [], created_at: 1 }),
  sendNip17ToManyWithNsec: (...args: unknown[]) => mockNsecSend(...args),
  sendNip17ToManyWithSigner: (...args: unknown[]) => mockSignerSend(...args),
}));
jest.mock('../services/amberService', () => ({}));
jest.mock('../services/nostrConnectService', () => ({}));
jest.mock('./nostrSecretKeyCache', () => ({
  getMemoisedSecretKey: async () => new Uint8Array(32),
}));
jest.mock('./nostrDecryptPacing', () => ({ paintOptimisticBubble: async () => {} }));
jest.mock('../services/appRelayPrefs', () => ({ enabledAppRelays: () => ['wss://default'] }));
jest.mock('../services/dmRumorId', () => ({ directMessageRumorEventId: () => 'rumor-id' }));
jest.mock('../services/nip171Groups', () => ({ nip171Outgoing: jest.fn() }));
jest.mock('../services/marmotSession', () => ({
  isMarmotGroupId: (id: string) => id.startsWith('mls:'),
}));
jest.mock('../services/marmotSend', () => ({
  sendMarmotGroupRumor: (...args: unknown[]) => mockMarmotSend(...args),
}));

beforeEach(() => jest.clearAllMocks());

it.each<SignerType>(['nsec', 'amber', 'nip46'])(
  'forwards final delivery for the %s signer, preserving partial-send failure',
  async (signerType) => {
    const delivery = { delivered: true, relayResults: { a: 'ok' as const } };
    const send = jest.fn(
      async (input: { onDeliveryFinalized?: (status: typeof delivery) => void }) => {
        input.onDeliveryFinalized?.(delivery);
        return { wrapsPublished: 1, errors: ['one member failed'], delivery };
      },
    );
    mockNsecSend.mockImplementation(send);
    mockSignerSend.mockImplementation(send);
    const { result } = renderHook(() =>
      useGroupMessaging({
        pubkey: 'a'.repeat(64),
        isLoggedIn: true,
        signerType,
        relays: [],
      }),
    );
    const onDeliveryFinalized = jest.fn();
    const outcome = await result.current.sendGroupMessage(
      {
        groupId: 'group',
        subject: 'Group',
        memberPubkeys: [],
        text: 'hello',
      },
      { onDeliveryFinalized },
    );
    expect(onDeliveryFinalized).toHaveBeenCalledWith(delivery);
    expect(outcome).toMatchObject({ success: false, delivery });
  },
);

it('omits unrelated gift-wrap relays from the pending Marmot metadata', async () => {
  mockMarmotSend.mockResolvedValue({ success: true });
  const { result } = renderHook(() =>
    useGroupMessaging({
      pubkey: 'a'.repeat(64),
      isLoggedIn: true,
      signerType: 'nsec',
      relays: [],
    }),
  );
  const onRumorReady = jest.fn();
  await result.current.sendGroupMessage(
    {
      groupId: 'mls:group',
      subject: 'Group',
      memberPubkeys: [],
      text: 'hello',
    },
    { onRumorReady },
  );
  expect(onRumorReady).toHaveBeenCalledWith({ rumorId: 'rumor-id', kind: 14 });
  expect(mockNsecSend).not.toHaveBeenCalled();
});
