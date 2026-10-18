import { tryRouteGroupRumor } from './nostrGroupRouting';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { ingestInboxWraps } from './dmWrapIngest';
import {
  setKnownGroups,
  setSyntheticGroupReconciler,
  type SyntheticRoomInput,
} from '../services/groupRoutingRegistry';
import { appendGroupMessage } from '../services/groupMessagesStorageService';
import { upsertDmMessages } from '../services/dmDb';
import { routeMarmotWelcome } from '../services/marmotWelcomeRouter';
import { fireMessageNotification } from '../services/notificationService';
import { notifyDmMessage, notifyGroupMessage } from './nostrEventBus';
import { textForRumor, type DecodedRumor } from '../utils/nip17Unwrap';
import { dmRowPreview } from '../utils/dmRowPreview';
import { NWC_SHARE_KIND, serializeNwcShare } from '../utils/nwcShareMessage';
import type { Group } from '../types/groups';

jest.mock('../services/groupMessagesStorageService', () => ({ appendGroupMessage: jest.fn() }));
jest.mock('../services/dmDb', () => ({
  selectKnownEventIds: jest.fn(async () => new Set()),
  upsertDmMessages: jest.fn(async () => undefined),
}));
jest.mock('../services/marmotWelcomeRouter', () => ({ routeMarmotWelcome: jest.fn() }));
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: jest.fn(async () => 'notification'),
  isThreadActivelyViewed: jest.fn(() => false),
}));
jest.mock('../services/dmWrapNotificationDedupe', () => ({
  claimWrapNotification: jest.fn(() => true),
  markWrapHandled: jest.fn(),
  takeContentlessWrapAlert: jest.fn(),
}));
jest.mock('./nostrEventBus', () => ({
  notifyDmMessage: jest.fn(),
  notifyGroupMessage: jest.fn(),
}));
jest.mock('../services/nostrCrypto', () => ({
  nip44DecryptFrom: jest.fn(),
  nostrGetEventHash: () => 'rumor-id',
}));

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const SECRET = 'd'.repeat(64);
const rumor = (kind: number): DecodedRumor => ({
  pubkey: PEER,
  created_at: 20,
  kind,
  tags: [['p', ME]],
  content: 'hello',
});

beforeEach(() => {
  jest.clearAllMocks();
  setKnownGroups(
    [{ id: 'family', name: 'Family', memberPubkeys: [PEER], createdAt: 1, updatedAt: 1 }],
    ME,
  );
});
afterEach(() => {
  setKnownGroups([]);
  setSyntheticGroupReconciler(null);
});

it('does not wait for a concurrent room creation before delivering an unmarked DM', async () => {
  setKnownGroups([], ME);
  let finish!: (group: Group | null) => void;
  const reconcile = jest.fn(
    (_input: SyntheticRoomInput) => new Promise<Group | null>((resolve) => (finish = resolve)),
  );
  setSyntheticGroupReconciler(reconcile, ME);
  const marked = {
    ...rumor(14),
    tags: [
      ['p', ME],
      ['subject', 'Family'],
    ],
  };
  const first = tryRouteGroupRumor(marked, ME, 'first', undefined, () => true);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(await tryRouteGroupRumor(rumor(14), ME, 'direct')).toMatchObject({ kind: 'not-group' });
  expect(appendGroupMessage).not.toHaveBeenCalled();
  const input = reconcile.mock.calls[0][0];
  finish({
    id: input.groupId,
    name: input.name,
    memberPubkeys: [PEER],
    createdAt: 1,
    updatedAt: 1,
  });
  expect(await first).toMatchObject({ kind: 'routed' });
  expect(appendGroupMessage).toHaveBeenCalledTimes(1);
});

it.each([15, 444, NWC_SHARE_KIND])(
  'leaves subjectless kind-%s rumors on their specialized DM path despite a matching room',
  async (kind) => {
    expect(await tryRouteGroupRumor(rumor(kind), ME, 'wrap')).toEqual({ kind: 'not-group' });
    expect(appendGroupMessage).not.toHaveBeenCalled();
    expect(notifyGroupMessage).not.toHaveBeenCalled();
  },
);

describe.each([
  ['live', false],
  ['live', true],
  ['refresh', false],
  ['refresh', true],
] as const)('%s receive with a matching two-member room (subject=%s)', (path, hasSubject) => {
  async function receive(message: DecodedRumor, expectedStored = 1) {
    if (hasSubject) message.tags.push(['subject', 'Family']);
    if (path === 'refresh') {
      const result = await ingestInboxWraps({
        owner: ME,
        wraps: [{ id: 'wrap' }],
        unwrap: async () => message,
        passesFollowGate: () => true,
      });
      expect(result.stored).toBe(expectedStored);
      return result.entries[0];
    }
    const queueInboxEntry = jest.fn();
    const writes: Promise<void>[] = [];
    const surface = createLiveRumorSurfacer({
      viewerPubkey: ME,
      isCancelled: () => false,
      shouldAbort: () => false,
      followPubkeysRef: { current: new Set([PEER]) },
      followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
      isFollowHydrated: () => true,
      isFreshArrival: () => true,
      queueInboxEntry,
      knownWrapIds: new Set(),
      seen: new Set(),
      chainWrite: (task) => {
        writes.push(task());
      },
    });
    await surface(message, 'wrap');
    await Promise.all(writes);
    return queueInboxEntry.mock.calls[0]?.[0];
  }

  it.each([false, true])('routes text by its marker (sender echo=%s)', async (senderEcho) => {
    const message = rumor(14);
    if (senderEcho) {
      message.pubkey = ME;
      message.tags = [
        ['p', PEER],
        ['p', ME],
        ['p', PEER],
      ];
    }
    const entry = await receive(message, hasSubject ? 0 : 1);
    if (hasSubject) {
      expect(entry).toBeUndefined();
      expect(upsertDmMessages).not.toHaveBeenCalled();
      expect(appendGroupMessage).toHaveBeenCalledWith(
        ME,
        'family',
        expect.objectContaining({ text: 'hello', senderPubkey: message.pubkey }),
      );
    } else {
      expect(entry).toMatchObject({ partnerPubkey: PEER, fromMe: senderEcho, text: 'hello' });
      expect(upsertDmMessages).toHaveBeenCalledWith([
        expect.objectContaining({ conversation: PEER, content: 'hello', fromMe: senderEcho }),
      ]);
      expect(appendGroupMessage).not.toHaveBeenCalled();
      expect(notifyGroupMessage).not.toHaveBeenCalled();
    }
  });

  if (!hasSubject) {
    it.each([['subject', ''], ['subject', ' \t\n '], ['subject']])(
      'delivers a two-party message with invalid subject %j and no matching room as a DM',
      async (...subjectTag) => {
        setKnownGroups([], ME);
        const message = rumor(14);
        message.tags.push(subjectTag);
        const entry = await receive(message);
        expect(entry).toMatchObject({ partnerPubkey: PEER, text: 'hello', wireKind: 14 });
        expect(upsertDmMessages).toHaveBeenCalledWith([
          expect.objectContaining({ conversation: PEER, content: 'hello', wireKind: 14 }),
        ]);
        expect(appendGroupMessage).not.toHaveBeenCalled();
        expect(notifyGroupMessage).not.toHaveBeenCalled();
      },
    );
  }

  if (hasSubject) {
    it.each([
      ['image/jpeg', false, false],
      ['audio/mp4', false, false],
      ['application/pdf', false, false],
      ['application/pdf', true, false],
      ['application/pdf', false, true],
    ] as const)(
      'routes %s to group storage and redacts notifications (sender echo=%s, multi-party=%s)',
      async (mime, senderEcho, multiParty) => {
        const third = 'c'.repeat(64);
        const members = multiParty ? [PEER, third] : [PEER];
        setKnownGroups(
          [{ id: 'family', name: 'Family', memberPubkeys: members, createdAt: 1, updatedAt: 1 }],
          ME,
        );
        const message = rumor(15);
        message.pubkey = senderEcho ? ME : PEER;
        message.content = 'https://files.example/attachment?token=private';
        message.tags = [
          ['p', senderEcho ? PEER : ME],
          ...(multiParty ? [['p', third]] : []),
          ['file-type', mime],
          ['decryption-key', SECRET],
          ['decryption-nonce', 'e'.repeat(24)],
          ['imeta', 'name statement.pdf', 'size 2048'],
        ];
        const entry = await receive(message, 0);
        const converted = textForRumor(message);
        expect(converted).toContain(SECRET);
        expect(entry).toBeUndefined();
        expect(upsertDmMessages).not.toHaveBeenCalled();
        expect(notifyDmMessage).not.toHaveBeenCalled();
        expect(appendGroupMessage).toHaveBeenCalledWith(
          ME,
          'family',
          expect.objectContaining({ text: converted, wireKind: 15 }),
        );
        expect(notifyGroupMessage).toHaveBeenCalledWith(
          'family',
          expect.objectContaining({ text: converted, wireKind: 15 }),
        );
        if (path === 'live' && !senderEcho) {
          expect(fireMessageNotification).toHaveBeenCalledWith(
            expect.objectContaining({
              kind: 'group',
              threadId: 'family',
              body: dmRowPreview(converted, 15),
            }),
          );
          const notifications = JSON.stringify(jest.mocked(fireMessageNotification).mock.calls);
          for (const secret of [SECRET, 'e'.repeat(24), 'token=private', '[FILE]', '#lpe=1']) {
            expect(notifications).not.toContain(secret);
          }
        } else {
          expect(fireMessageNotification).not.toHaveBeenCalled();
        }
      },
    );
  }

  it('redacts wallet-share previews and notifications while retaining the encrypted-store payload', async () => {
    const content = serializeNwcShare({
      nwcUrl: `nostr+walletconnect://${PEER}?relay=wss%3A%2F%2Frelay.example&secret=${SECRET}`,
      walletName: 'Savings',
    });
    const entry = await receive({ ...rumor(NWC_SHARE_KIND), content });
    expect(entry.text).toBe('🔌 Shared wallet "Savings"');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({ conversation: PEER, content, wireKind: NWC_SHARE_KIND }),
    ]);
    expect(appendGroupMessage).not.toHaveBeenCalled();
    if (path === 'live') {
      expect(fireMessageNotification).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'dm', body: entry.text }),
      );
      expect(JSON.stringify(jest.mocked(fireMessageNotification).mock.calls)).not.toContain(SECRET);
    }
  });

  it('dispatches a Marmot Welcome to its join handler and keeps it out of group storage', async () => {
    const message = { ...rumor(444), content: 'serialized-mls-welcome' };
    jest.mocked(routeMarmotWelcome).mockResolvedValueOnce(true);
    const entry = await receive(message, 0);
    expect(routeMarmotWelcome).toHaveBeenCalledWith(
      message,
      ME,
      'wrap',
      path === 'live',
      path === 'live',
      expect.any(Function),
      ...(path === 'live' ? [undefined] : []),
    );
    expect(entry).toBeUndefined();
    expect(upsertDmMessages).not.toHaveBeenCalled();
    expect(appendGroupMessage).not.toHaveBeenCalled();
    expect(fireMessageNotification).not.toHaveBeenCalled();
  });

  it('converts encrypted attachment metadata for storage and redacts its preview', async () => {
    const message = rumor(15);
    message.content = 'https://files.example/photo';
    message.tags.push(
      ['file-type', 'image/jpeg'],
      ['decryption-key', SECRET],
      ['decryption-nonce', 'e'.repeat(24)],
    );
    const entry = await receive(message, hasSubject ? 0 : 1);
    const converted = textForRumor(message);
    expect(converted).toContain('#lpe=1');
    expect(converted).toContain(SECRET);
    if (hasSubject) {
      expect(entry).toBeUndefined();
      expect(upsertDmMessages).not.toHaveBeenCalled();
      expect(appendGroupMessage).toHaveBeenCalledWith(
        ME,
        'family',
        expect.objectContaining({ text: converted, wireKind: 15 }),
      );
    } else {
      expect(upsertDmMessages).toHaveBeenCalledWith([
        expect.objectContaining({ conversation: PEER, content: converted, wireKind: 15 }),
      ]);
      expect(entry.text).toBe('📎 Attachment');
      expect(appendGroupMessage).not.toHaveBeenCalled();
    }
    if (path === 'live') {
      expect(fireMessageNotification).toHaveBeenCalledWith(
        expect.objectContaining({ kind: hasSubject ? 'group' : 'dm', body: '📎 Attachment' }),
      );
    }
  });
});

describe.each(['live', 'refresh'] as const)('%s two-party room trust', (path) => {
  it.each([false, true])(
    'requires the follow gate before creating an unknown subject-tagged room (trusted=%s)',
    async (trusted) => {
      setKnownGroups([], ME);
      const reconcile = jest.fn(async (input) => ({
        id: input.groupId,
        name: input.name,
        memberPubkeys: input.memberPubkeys,
        createdAt: 1,
        updatedAt: 1,
      }));
      setSyntheticGroupReconciler(reconcile, ME);
      const message = rumor(14);
      message.tags.push(['subject', 'Unsolicited room']);
      const queueInboxEntry = jest.fn();
      const defer = jest.fn();
      if (path === 'refresh') {
        const result = await ingestInboxWraps({
          owner: ME,
          wraps: [{ id: 'untrusted-wrap' }],
          unwrap: () => message,
          passesFollowGate: (pk) => trusted && pk === PEER,
        });
        expect(result.stored).toBe(0);
        expect(result.entries).toEqual([]);
      } else {
        await createLiveRumorSurfacer({
          viewerPubkey: ME,
          isCancelled: () => false,
          shouldAbort: () => false,
          followPubkeysRef: { current: new Set(trusted ? [PEER] : [SECRET]) },
          followGateBuffer: { defer, reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
          isFollowHydrated: () => false,
          isFreshArrival: () => true,
          queueInboxEntry,
          knownWrapIds: new Set(),
          seen: new Set(),
          chainWrite: (task) => void task(),
        })(message, 'untrusted-wrap');
        expect(queueInboxEntry).not.toHaveBeenCalled();
        expect(defer).toHaveBeenCalledTimes(trusted ? 0 : 1);
      }
      expect(upsertDmMessages).not.toHaveBeenCalled();
      if (trusted) {
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(appendGroupMessage).toHaveBeenCalledTimes(1);
        expect(notifyGroupMessage).toHaveBeenCalledTimes(1);
        expect(fireMessageNotification).toHaveBeenCalledTimes(path === 'live' ? 1 : 0);
      } else {
        expect(reconcile).not.toHaveBeenCalled();
        expect(appendGroupMessage).not.toHaveBeenCalled();
        expect(notifyGroupMessage).not.toHaveBeenCalled();
        expect(fireMessageNotification).not.toHaveBeenCalled();
      }
    },
  );
});
