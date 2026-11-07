import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { routeMarmotWelcome } from '../services/marmotWelcomeRouter';
import { tryRouteGroupRumor } from './nostrGroupRouting';
import { upsertDmMessages } from '../services/dmDb';
import { markWrapHandled } from '../services/dmWrapNotificationDedupe';
jest.mock('../services/marmotWelcomeRouter', () => ({
  routeMarmotWelcome: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/dmDb', () => ({ upsertDmMessages: jest.fn() }));
jest.mock('./nostrGroupRouting', () => ({ tryRouteGroupRumor: jest.fn() }));
jest.mock('./nostrEventBus', () => ({ notifyDmMessage: jest.fn() }));
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: jest.fn(),
  isThreadActivelyViewed: jest.fn(),
}));
jest.mock('../services/dmWrapNotificationDedupe', () => ({
  takeContentlessWrapAlert: jest.fn(),
  noteWrapStored: jest.fn(),
  markWrapHandled: jest.fn(),
}));

it.each([true, false])(
  'live routes Welcome before follow-gate or DM storage (followed=%s)',
  async (followed) => {
    jest.clearAllMocks();
    const owner = 'a'.repeat(64),
      peer = 'b'.repeat(64);
    const defer = jest.fn(),
      queueInboxEntry = jest.fn();
    const knownWrapIds = new Set(['wrap-id']);
    const seen = new Set(['wrap-id']);
    const surface = createLiveRumorSurfacer({
      viewerPubkey: owner,
      isCancelled: () => false,
      shouldAbort: () => false,
      isFollowHydrated: () => true,
      followPubkeysRef: { current: new Set(followed ? [peer] : []) },
      followGateBuffer: { defer, clear: jest.fn(), reevaluate: jest.fn(), size: 0 },
      isFreshArrival: () => true,
      queueInboxEntry,
      knownWrapIds,
      seen,
      chainWrite: jest.fn(),
    });
    const welcome = {
      pubkey: peer,
      kind: 444,
      content: 'secret',
      tags: [['p', owner]],
      created_at: 1,
    };
    await surface(welcome, 'wrap-id');
    expect(routeMarmotWelcome).toHaveBeenCalledWith(
      welcome,
      owner,
      'wrap-id',
      followed,
      true,
      expect.any(Function),
      undefined,
    );
    expect(knownWrapIds.has('wrap-id')).toBe(true);
    expect(seen.has('wrap-id')).toBe(true);
    expect(tryRouteGroupRumor).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
    expect(queueInboxEntry).not.toHaveBeenCalled();
    expect(upsertDmMessages).not.toHaveBeenCalled();
  },
);

it('releases both live claims on a failed Welcome route so redelivery can retry', async () => {
  jest.clearAllMocks();
  const failure = new Error('storage unavailable');
  (routeMarmotWelcome as jest.Mock).mockRejectedValueOnce(failure);
  const knownWrapIds = new Set(['retry-wrap', 'other-wrap']);
  const seen = new Set(['retry-wrap', 'other-wrap']);
  const surface = createLiveRumorSurfacer({
    viewerPubkey: 'a'.repeat(64),
    isCancelled: () => false,
    shouldAbort: () => false,
    isFollowHydrated: () => true,
    followPubkeysRef: { current: new Set() },
    followGateBuffer: { defer: jest.fn(), clear: jest.fn(), reevaluate: jest.fn(), size: 0 },
    isFreshArrival: () => true,
    queueInboxEntry: jest.fn(),
    knownWrapIds,
    seen,
    chainWrite: jest.fn(),
  });
  const welcome = { pubkey: 'b'.repeat(64), kind: 444, content: 'secret', tags: [], created_at: 1 };
  await expect(surface(welcome, 'retry-wrap')).rejects.toBe(failure);
  expect([...knownWrapIds]).toEqual(['other-wrap']);
  expect([...seen]).toEqual(['other-wrap']);
  expect(markWrapHandled).not.toHaveBeenCalled();
  expect(tryRouteGroupRumor).not.toHaveBeenCalled();
  expect(upsertDmMessages).not.toHaveBeenCalled();

  await surface(welcome, 'retry-wrap');
  expect(routeMarmotWelcome).toHaveBeenCalledTimes(2);
  expect(markWrapHandled).toHaveBeenCalledWith('retry-wrap');
});
