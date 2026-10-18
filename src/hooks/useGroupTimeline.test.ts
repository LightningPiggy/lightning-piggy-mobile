import { encodeEncryptedFileUrl } from '../utils/encryptedFileUrl';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { GroupMessage } from '../services/groupMessagesStorageService';
import { useChatLocalHistory } from './useChatLocalHistory';
import type { DeviceNoticeView } from '../services/marmotDeviceTracker';
import {
  isDeviceNoticeRow,
  mergeDeviceNotices,
  useGroupTimeline,
  groupSenderLabel,
  type ClassifiedMessage,
} from './useGroupTimeline';

it.each(['local_pending', 'c'.repeat(64)])(
  'resolves the quoted parent of an own group reply before and after echo (%s)',
  (id) => {
    const me = 'a'.repeat(64);
    const peer = 'b'.repeat(64);
    const parent = { id: 'd'.repeat(64), createdAt: 1, senderPubkey: peer, text: 'original' };
    const reply = { id, createdAt: 2, senderPubkey: me, text: 'reply', replyTo: parent.id };
    const { result } = renderHook(() =>
      useGroupTimeline({
        messages: [parent, reply],
        myPubkey: me,
        memberNameByPubkey: new Map([[peer, 'Little Piggy']]),
        formatLocale: 'en',
        deviceNotices: [],
      }),
    );
    expect(result.current.rows[1]).toMatchObject({
      id,
      quote: { text: 'original', fromMe: false, authorName: 'Little Piggy' },
    });
  },
);

const msg = (id: string, createdAt: number) =>
  ({ id, createdAt, senderPubkey: 'a', text: id }) as unknown as ClassifiedMessage;
const notice = (id: string, at: number): DeviceNoticeView => ({
  id,
  at,
  epoch: 1,
  pubkey: 'b',
  joined: true,
  keys: ['k1', 'k2'],
  clients: ['Lightning Piggy', null],
});

it.each(['nip17:group', 'marmot:group'])(
  'keeps same-second arrivals in the group timeline after clearing %s',
  async (thread) => {
    await AsyncStorage.clear();
    const now = 1700000000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const raw: GroupMessage[] = [
      { id: 'old', createdAt: now - 1, senderPubkey: 'a', text: 'old' },
      { id: 'cleared', createdAt: now, senderPubkey: 'a', text: 'cleared' },
      { id: 'future', createdAt: now + 86400, senderPubkey: 'a', text: 'future' },
    ];
    const hook = renderHook(
      ({ messages }: { messages: GroupMessage[] }) => {
        const history = useChatLocalHistory('owner', thread, messages);
        const timeline = useGroupTimeline({
          messages: history.messages,
          myPubkey: 'b',
          memberNameByPubkey: new Map(),
          formatLocale: 'en',
          deviceNotices: [notice('old', now - 1), notice('same-second', now)],
          clearBoundary: history.clearBoundary,
        });
        return { ...history, ...timeline };
      },
      { initialProps: { messages: raw } },
    );
    try {
      await waitFor(() => expect(hook.result.current.messages).toEqual(raw));
      await act(() => hook.result.current.clear());
      expect(hook.result.current.rows).toEqual([]);
      hook.rerender({
        messages: [...raw, { id: 'arriving', createdAt: now, senderPubkey: 'a', text: 'new' }],
      });
      expect(hook.result.current.rows).toEqual([
        expect.objectContaining({
          id: 'arriving',
          createdAt: now,
          content: { kind: 'text', text: 'new' },
        }),
      ]);
    } finally {
      hook.unmount();
      clock.mockRestore();
    }
  },
);

it('retains device notices newer than the group clear boundary', () => {
  const { result } = renderHook(() =>
    useGroupTimeline({
      messages: [],
      myPubkey: 'a',
      memberNameByPubkey: new Map(),
      formatLocale: 'en',
      deviceNotices: [notice('old', 9), notice('same-second', 10), notice('new', 11)],
      clearBoundary: 10,
    }),
  );
  expect(result.current.rows.map((row) => row.id)).toEqual(['device-new']);
});

describe('mergeDeviceNotices', () => {
  it('returns the messages untouched when there are no notices', () => {
    const messages = [msg('m1', 10)];
    expect(mergeDeviceNotices(messages, [])).toBe(messages);
  });

  it('puts each notice before the first newer message, keeping message order', () => {
    const rows = mergeDeviceNotices(
      [msg('m1', 10), msg('m2', 20), msg('m3', 30)],
      [notice('n0', 5), notice('n1', 15), notice('n2', 40)],
    );
    expect(rows.map((r) => r.id)).toEqual([
      'device-n0',
      'm1',
      'device-n1',
      'm2',
      'm3',
      'device-n2',
    ]);
    const first = rows[0];
    expect(isDeviceNoticeRow(first) && first).toMatchObject({
      createdAt: 5,
      pubkey: 'b',
      joined: true,
      clients: ['Lightning Piggy', null],
    });
    expect(isDeviceNoticeRow(rows[1])).toBe(false);
  });

  it('shows notices in an empty chat', () => {
    expect(mergeDeviceNotices([], [notice('n', 1)]).map((r) => r.id)).toEqual(['device-n']);
  });
});

it('keeps unknown kinds and files as unread timeline messages', () => {
  const messages: GroupMessage[] = [
    { id: 'unknown1', senderPubkey: 'b', text: '', wireKind: 1234, createdAt: 1 },
    {
      id: 'file0001',
      senderPubkey: 'b',
      text: '[FILE]{"name":"invoice.pdf","mime":"application/pdf"}',
      wireKind: 15,
      createdAt: 2,
    },
  ];
  const { result } = renderHook(() =>
    useGroupTimeline({
      messages,
      myPubkey: 'a',
      memberNameByPubkey: new Map(),
      formatLocale: 'en',
      deviceNotices: [],
    }),
  );
  expect(result.current.rows).toHaveLength(2);
  expect(result.current.rows[0]).toMatchObject({ content: { kind: 'unsupported', rawKind: 1234 } });
  expect(result.current.rows[1]).toMatchObject({ wireKind: 15, content: { kind: 'file' } });
});

it.each([14, 15])('classifies kind %s file payloads before geo captions in groups', (wireKind) => {
  const text =
    '[FILE]' +
    JSON.stringify({
      name: 'geo:1,2.pdf',
      mime: 'application/pdf',
      caption: 'geo:1,2',
      encrypted: false,
      url: 'https://example.com/f',
    });
  const { result } = renderHook(() =>
    useGroupTimeline({
      messages: [{ id: 'f', createdAt: 1, senderPubkey: 'a', text, wireKind }],
      myPubkey: 'b',
      memberNameByPubkey: new Map(),
      formatLocale: 'en',
      deviceNotices: [],
    }),
  );
  const row = result.current.rows[0] as ClassifiedMessage;
  if (wireKind === 15)
    expect(row.content).toMatchObject({ kind: 'file', file: { name: 'geo:1,2.pdf' } });
  else expect(row.content.kind).not.toBe('file');
});

it.each(['You', 'Tú'])('labels own unsupported group messages with localized %s', (you) => {
  expect(groupSenderLabel(true, 'unsupported', 'Peer', you)).toBe(you);
  expect(groupSenderLabel(false, 'unsupported', 'Peer', you)).toBe('Peer');
  expect(groupSenderLabel(true, 'text', 'Peer', you)).toBeNull();
});

it('uses the derived kind for legacy encrypted document rows without wireKind', () => {
  const text = encodeEncryptedFileUrl({
    url: 'https://example.com/cipher',
    mime: 'application/pdf',
    filename: 'invoice.pdf',
    keyHex: '11'.repeat(32),
    nonceHex: '22'.repeat(12),
    sha256: '33'.repeat(32),
  });
  const { result } = renderHook(() =>
    useGroupTimeline({
      messages: [{ id: 'legacy', senderPubkey: 'b', createdAt: 1, text }],
      myPubkey: 'a',
      memberNameByPubkey: new Map(),
      formatLocale: 'en',
      deviceNotices: [],
    }),
  );
  expect(result.current.rows[0]).toMatchObject({
    wireKind: 15,
    content: { kind: 'file', file: { name: 'invoice.pdf' } },
  });
});
