import type { MarmotKvBackend } from './marmotStore';
import type { DecodedRumor } from '../utils/nip17Unwrap';
import { getPendingMarmotInvitations, routeMarmotWelcome } from './marmotWelcomeRouter';
import { fireMessageNotification } from './notificationService';
import { MarmotPendingInvitations } from './marmotPendingInvitations';
import { createLiveRumorSurfacer } from '../contexts/liveDmRumorSurface';
import {
  claimWrapNotification,
  noteContentlessWrapAlert,
  __resetForTests,
} from './dmWrapNotificationDedupe';
import { dismissNotificationsFor } from './notificationService';

const mockBackends = new Map<string, MarmotKvBackend>();
const mockAccept = jest.fn().mockResolvedValue({ id: 'joined-group' });
const mockPreview = jest.fn().mockResolvedValue({
  forThisDevice: true,
  groupId: 'mls-group',
  group: { name: 'Private family' },
});
let mockSession: {
  pubkey: string;
  getGroup: () => undefined;
  acceptWelcome: typeof mockAccept;
  previewWelcome: typeof mockPreview;
} | null = null;
let mockSessionChanged: (s: typeof mockSession) => void;
jest.mock('./marmotSession', () => ({
  getMarmotSession: () => mockSession,
  subscribeMarmotSession: (listener: typeof mockSessionChanged) => {
    mockSessionChanged = listener;
  },
}));
jest.mock('./localDb', () => ({ getLocalDb: jest.fn() }));
jest.mock('./marmotStore', () => {
  const actual = jest.requireActual('./marmotStore');
  return {
    ...actual,
    createSqliteMarmotBackend: (owner: string) => {
      if (!mockBackends.has(owner)) mockBackends.set(owner, actual.createMemoryMarmotBackend());
      return mockBackends.get(owner);
    },
  };
});
jest.mock('./notificationService', () => ({
  fireMessageNotification: jest.fn().mockResolvedValue('notification'),
  dismissNotificationsFor: jest.fn().mockResolvedValue(0),
  cancelInFlightNotifications: jest.fn(),
  isThreadActivelyViewed: jest.fn().mockReturnValue(false),
}));
jest.mock('./notificationHistory', () => ({
  removeNotificationsWhere: jest.fn().mockResolvedValue([]),
}));
jest.mock('./dmDb', () => ({ upsertDmMessages: jest.fn() }));
jest.mock('../contexts/nostrGroupRouting', () => ({ tryRouteGroupRumor: jest.fn() }));
jest.mock('../contexts/nostrEventBus', () => ({ notifyDmMessage: jest.fn() }));

const rumor: DecodedRumor = {
  kind: 444,
  pubkey: 'b'.repeat(64),
  created_at: 100,
  content: 'secret MLS payload',
  tags: [],
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  mockSession = null;
  mockSessionChanged(null);
});

it('stores a cold-start stranger durably, then previews without joining when Marmot starts', async () => {
  const owner = 'a'.repeat(64);
  await routeMarmotWelcome(rumor, owner, 'cold-wrap', false, true);
  expect(await mockBackends.get(owner)!.get('welcomeInvitations', 'cold-wrap')).toContain(
    '"status":"pending"',
  );
  mockSession = {
    pubkey: owner,
    acceptWelcome: mockAccept,
    previewWelcome: mockPreview,
    getGroup: () => undefined,
  };
  mockSessionChanged(mockSession);
  await settle();
  expect(mockAccept).not.toHaveBeenCalled();
  expect(mockPreview).toHaveBeenCalledTimes(1);
  expect(fireMessageNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      owner,
      title: 'New group invitation',
      body: 'New group invitation',
      data: { groupInvitation: true, senderPubkey: rumor.pubkey },
    }),
  );
  expect(JSON.stringify((fireMessageNotification as jest.Mock).mock.calls)).not.toContain(
    rumor.content,
  );
});
it("live and backfill delivery of a followed sender's wrap: one invitation, one alert, no auto-join", async () => {
  const owner = 'c'.repeat(64);
  mockSession = {
    pubkey: owner,
    acceptWelcome: mockAccept,
    previewWelcome: mockPreview,
    getGroup: () => undefined,
  };
  await Promise.all([
    routeMarmotWelcome(rumor, owner, 'same-wrap', true, true),
    routeMarmotWelcome(rumor, owner, 'same-wrap', true, false),
  ]);
  await settle();
  expect(mockAccept).not.toHaveBeenCalled();
  expect(fireMessageNotification).toHaveBeenCalledTimes(1);
});
it('does not join or notify own, malformed, or cancelled Welcomes', async () => {
  const owner = 'd'.repeat(64);
  expect(await routeMarmotWelcome({ ...rumor, pubkey: owner }, owner, 'own', true, true)).toBe(
    true,
  );
  expect(await routeMarmotWelcome({ ...rumor, pubkey: 'bad' }, owner, 'bad', true, true)).toBe(
    true,
  );
  expect(await routeMarmotWelcome(rumor, owner, 'cancelled', true, true, () => true)).toBe(true);
  expect(mockBackends.has(owner)).toBe(false);
  expect(mockAccept).not.toHaveBeenCalled();
  expect(fireMessageNotification).not.toHaveBeenCalled();
});

it.each([null, 'f'.repeat(64)])(
  'fences in-flight invitation writes when the session changes to %s',
  async (nextOwner) => {
    const owner = 'e'.repeat(64);
    mockSession = {
      pubkey: owner,
      acceptWelcome: mockAccept,
      previewWelcome: mockPreview,
      getGroup: () => undefined,
    };
    mockSessionChanged(mockSession);
    await settle();
    const backend = mockBackends.get(owner)!;
    const read = backend.get.bind(backend);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const spy = jest.spyOn(backend, 'get').mockImplementation(async (namespace, key) => {
      if (namespace === 'welcomeInvitations' && key === 'in-flight-wrap') {
        started();
        await blocked;
      }
      return read(namespace, key);
    });
    try {
      const routing = routeMarmotWelcome(rumor, owner, 'in-flight-wrap', false);
      await reading;
      mockSession = nextOwner
        ? {
            pubkey: nextOwner,
            acceptWelcome: mockAccept,
            previewWelcome: mockPreview,
            getGroup: () => undefined,
          }
        : null;
      mockSessionChanged(mockSession);
      release();
      await routing;
      expect(await read('welcomeInvitations', 'in-flight-wrap')).toBeNull();
      expect(await backend.keys('welcomeInvitationRumorWraps')).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
      mockSession = null;
      mockSessionChanged(null);
    }
  },
);

it('coalesces a burst during blocked MLS work into one follow-up pass with bounded reads', async () => {
  jest.useFakeTimers();
  const owner = '1'.repeat(64);
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (unblock = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const processing = jest.spyOn(MarmotPendingInvitations.prototype, 'resume');
  mockPreview.mockImplementationOnce(async () => {
    entered();
    await blocked;
    return { forThisDevice: true, groupId: 'mls-group', group: { name: 'Family' } };
  });
  try {
    await routeMarmotWelcome(rumor, owner, 'burst-first', false, true);
    const backend = mockBackends.get(owner)!;
    for (let i = 0; i < 30; i++)
      await backend.set(
        'welcomeInvitations',
        `old-${i}`,
        JSON.stringify({ id: `old-${i}`, status: 'declined' }),
      );
    const keys = jest.spyOn(backend, 'keys');
    const get = jest.spyOn(backend, 'get');
    mockSession = {
      pubkey: owner,
      acceptWelcome: mockAccept,
      previewWelcome: mockPreview,
      getGroup: () => undefined,
    };
    mockSessionChanged(mockSession);
    await jest.advanceTimersByTimeAsync(150);
    await started;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        routeMarmotWelcome(
          { ...rumor, content: `distinct-${i}` },
          owner,
          `burst-${i}`,
          false,
          true,
        ),
      ),
    );
    expect(mockPreview).toHaveBeenCalledTimes(1);
    // Durable ingestion finishes even though preview is blocked.
    expect(await backend.get('welcomeInvitations', 'burst-19')).toContain('distinct-19');
    unblock();
    await jest.advanceTimersByTimeAsync(600);
    expect(mockPreview).toHaveBeenCalledTimes(21);
    expect(processing).toHaveBeenCalledTimes(2);
    expect(mockAccept).not.toHaveBeenCalled();
    expect(getPendingMarmotInvitations(owner)).toHaveLength(1);
    // Two processing passes scan twice each; at most three snapshot scans.
    expect(
      keys.mock.calls.filter(([ns]) => ns === 'welcomeInvitations').length,
    ).toBeLessThanOrEqual(7);
    expect(get.mock.calls.filter(([ns]) => ns === 'welcomeInvitations').length).toBeLessThanOrEqual(
      380,
    );
    expect(fireMessageNotification).toHaveBeenCalledTimes(1);
    keys.mockRestore();
    get.mockRestore();
  } finally {
    processing.mockRestore();
    unblock();
    mockSession = null;
    mockSessionChanged(null);
    jest.useRealTimers();
  }
});

it('replaces a claimed background alert after live ingestion and delayed session startup, once', async () => {
  const owner = '2'.repeat(64);
  const wrapId = 'background-welcome';
  expect(claimWrapNotification(wrapId)).toBe(true);
  noteContentlessWrapAlert(wrapId);
  const surface = createLiveRumorSurfacer({
    viewerPubkey: owner,
    isCancelled: () => false,
    shouldAbort: () => false,
    isFollowHydrated: () => true,
    followPubkeysRef: { current: new Set() },
    followGateBuffer: { defer: jest.fn(), clear: jest.fn(), reevaluate: jest.fn(), size: 0 },
    isFreshArrival: () => true,
    queueInboxEntry: jest.fn(),
    knownWrapIds: new Set(),
    seen: new Set(),
    chainWrite: jest.fn(),
  });
  await surface(rumor, wrapId);
  expect(dismissNotificationsFor).toHaveBeenCalledWith({ wrapId });
  expect(fireMessageNotification).not.toHaveBeenCalled();
  mockSession = {
    pubkey: owner,
    acceptWelcome: mockAccept,
    previewWelcome: mockPreview,
    getGroup: () => undefined,
  };
  mockSessionChanged(mockSession);
  await settle();
  expect(fireMessageNotification).toHaveBeenCalledTimes(1);
  expect(fireMessageNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      owner,
      threadId: `invite:${wrapId}`,
      title: 'New group invitation',
      body: 'New group invitation',
    }),
  );
  await surface(rumor, wrapId);
  await settle();
  expect(fireMessageNotification).toHaveBeenCalledTimes(1);
  expect(mockAccept).not.toHaveBeenCalled();
});
