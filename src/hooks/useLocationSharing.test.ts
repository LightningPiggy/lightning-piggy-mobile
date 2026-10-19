import { act, renderHook } from '@testing-library/react-native';
import { Alert } from '../components/BrandedAlert';
import { getCurrentLocation, formatGeoMessage } from '../services/locationService';
import { useGroupComposerActions } from './useGroupComposerActions';
import { useConversationComposerActions } from './useConversationComposerActions';
import type { Group } from '../types/groups';

const mockSendGroup = jest.fn();
const mockSendDirect = jest.fn();
const mockPubkey = 'me';
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({
    pubkey: mockPubkey,
    isLoggedIn: true,
    relays: [],
    signEvent: jest.fn(),
    sendGroupMessage: mockSendGroup,
    sendDirectMessage: mockSendDirect,
    appendLocalDmMessage: jest.fn(),
  }),
  useNostrContacts: () => ({ contacts: [] }),
  notifyGroupMessage: jest.fn(),
}));
jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
// The group composer reads `t` from LocaleContext; a stable identity translator.
const mockT = (key: string) => key;
jest.mock('../contexts/LocaleContext', () =>
  (() => {
    const context = { useTranslation: () => mockT };
    return {
      ...context,
      useLocale: () => ({ t: context.useTranslation(), locale: 'en', formatLocale: 'en' }),
    };
  })(),
);
jest.mock('../services/locationService', () => ({
  ...jest.requireActual('../services/locationService'),
  getCurrentLocation: jest.fn(),
}));
const alert = jest.mocked(Alert.alert);
const location = { lat: 51.5074, lon: -0.1278, accuracyMeters: 5 };
const group: Group = {
  id: 'test-group',
  name: 'Family',
  memberPubkeys: ['me', 'big', 'little'],
  createdAt: 1,
  updatedAt: 1,
};
const params = {
  draft: '',
  setDraft: jest.fn(),
  setMessages: jest.fn(),
  scrollToEnd: jest.fn(),
  setAttachPanelOpen: jest.fn(),
  setGifPickerOpen: jest.fn(),
  setContactPickerOpen: jest.fn(),
  setVoiceSheetOpen: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getCurrentLocation).mockResolvedValue({ ok: true, location });
  mockSendGroup.mockResolvedValue({ success: true });
  mockSendDirect.mockResolvedValue({ success: true });
});

describe.each(['group', 'direct'] as const)('%s location sharing', (kind) => {
  function useActions() {
    const groupActions = useGroupComposerActions({ ...params, group });
    const directActions = useConversationComposerActions({
      ...params,
      pubkey: 'big',
      name: 'Big Piggy',
      protocol: 'nip17',
    });
    return kind === 'group' ? groupActions : directActions;
  }

  it.each(['cancel', 'dismiss', 'share'])('%s gates the actual composer send', async (action) => {
    const { result } = renderHook(useActions);
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleShareLocation();
    });
    expect(mockSendGroup).not.toHaveBeenCalled();
    expect(mockSendDirect).not.toHaveBeenCalled();
    expect(params.setMessages).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe(
      kind === 'group'
        ? 'Share your location with the 2 people in Family?'
        : 'Share your location with Big Piggy?',
    );
    await act(async () => {
      if (action === 'dismiss') alert.mock.calls[0][3]!.onDismiss!();
      else alert.mock.calls[0][2]![action === 'share' ? 1 : 0].onPress!();
      await pending;
    });
    const send = kind === 'group' ? mockSendGroup : mockSendDirect;
    if (action === 'share') {
      expect(send).toHaveBeenCalledTimes(1);
      if (kind === 'group') expect(send.mock.calls[0][0].text).toBe(formatGeoMessage(location));
      else expect(send.mock.calls[0][1]).toBe(formatGeoMessage(location));
    } else {
      expect(send).not.toHaveBeenCalled();
      expect(params.setMessages).not.toHaveBeenCalled();
    }
    expect(result.current.sharingLocation).toBe(false);
  });
});

it('does not acquire or send a location when the group is unavailable', async () => {
  const { result } = renderHook(() => useGroupComposerActions({ ...params, group: undefined }));
  await act(async () => {
    await result.current.handleShareLocation();
  });
  expect(getCurrentLocation).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(mockSendGroup).not.toHaveBeenCalled();
});

it('re-asks and sends to the latest roster when members change while the dialog is open', async () => {
  const { result, rerender } = renderHook(
    (props: { group: Group }) => useGroupComposerActions({ ...params, group: props.group }),
    { initialProps: { group } },
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleShareLocation();
  });
  expect(alert.mock.calls[0][0]).toBe('Share your location with the 2 people in Family?');

  // A roster update removes Little Piggy while the confirmation is still open.
  const smaller: Group = { ...group, memberPubkeys: ['me', 'big'], updatedAt: 2 };
  rerender({ group: smaller });
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(mockSendGroup).not.toHaveBeenCalled();
  expect(alert.mock.calls[1][0]).toBe('Share your location with the other person in Family?');

  await act(async () => {
    alert.mock.calls[1][2]![1].onPress!();
    await pending;
  });
  expect(mockSendGroup).toHaveBeenCalledTimes(1);
  expect(mockSendGroup.mock.calls[0][0].memberPubkeys).toEqual(['me', 'big']);
});

it('after a group switch mid-dialog, re-asks and records the optimistic row in the group it went to', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const storage = require('../services/groupMessagesStorageService');
  const append = jest.spyOn(storage, 'appendGroupMessage').mockResolvedValue([]);
  const { result, rerender } = renderHook(
    (props: { group: Group }) => useGroupComposerActions({ ...params, group: props.group }),
    { initialProps: { group } },
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleShareLocation();
  });
  const other: Group = { ...group, id: 'other-group', name: 'Cousins' };
  rerender({ group: other });
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(mockSendGroup).not.toHaveBeenCalled();
  expect(alert.mock.calls[1][0]).toBe('Share your location with the 2 people in Cousins?');

  mockSendGroup.mockImplementation(async (_args, hooks) => {
    hooks?.onRumorReady?.({ rumorId: 'rumor', kind: 14 });
    return { success: true };
  });
  await act(async () => {
    alert.mock.calls[1][2]![1].onPress!();
    await pending;
  });
  expect(mockSendGroup.mock.calls[0][0].groupId).toBe('other-group');
  expect(append).toHaveBeenCalledWith(mockPubkey, 'other-group', expect.anything());
  append.mockRestore();
});
