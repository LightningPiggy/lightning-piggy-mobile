// A message held while follows load, then turned away at reconciliation, may
// still alert per the chosen tier. If a remote-signer background watch already
// posted a contentless placeholder for it (and so holds the claim), the real
// alert must REPLACE it, as on the live drop path (#1764).
import { clearParkedAudienceAlerts, notifyDroppedDeferred } from './liveDmAudienceNotify';
import {
  claimWrapNotification,
  noteContentlessWrapAlert,
  wasWrapDecided,
  __resetForTests as __resetDedupe,
} from '../services/dmWrapNotificationDedupe';
import {
  __resetNotificationAudiences,
  publishNotificationAudience,
} from '../services/notificationAudience';
import type { DeferredFollowGateEntry } from './liveSubFollowGate';

const mockFire = jest.fn();
const mockDismiss = jest.fn(async () => undefined);
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFire(...a),
  isThreadActivelyViewed: () => false,
  cancelInFlightNotifications: jest.fn(),
  dismissNotificationsFor: (...a: unknown[]) => mockDismiss(...(a as [])),
}));
jest.mock('../services/notificationHistory', () => ({
  removeNotificationsWhere: jest.fn(async () => undefined),
}));

const VIEWER = 'a'.repeat(64);
const STRANGER = 'd'.repeat(64);
const item = (id: string): DeferredFollowGateEntry => ({
  partnerPubkey: STRANGER,
  entry: { id, partnerPubkey: STRANGER, fromMe: false, createdAt: 1, text: 'hi', wireKind: 14 },
  notify: { title: 'New message', body: 'hi' },
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetDedupe();
  __resetNotificationAudiences();
  clearParkedAudienceAlerts();
  mockFire.mockResolvedValue('real-alert');
});

it('replaces the watch placeholder with the real alert under an explicit All', async () => {
  publishNotificationAudience(VIEWER, { tier: 'all', fof: null });
  // The contentless watch alerted first: it holds the claim and the placeholder.
  claimWrapNotification('w1');
  noteContentlessWrapAlert('w1');
  notifyDroppedDeferred(VIEWER, item('w1'));
  await flush();
  expect(mockFire).toHaveBeenCalledTimes(1);
  expect(mockFire.mock.calls[0][0]).toMatchObject({
    data: { conversationPubkey: STRANGER, messageId: 'w1' },
  });
  expect(mockDismiss).toHaveBeenCalledWith({ wrapId: 'w1' });
  expect(wasWrapDecided('w1')).toBe(true);
});

it('keeps the placeholder when the real alert could not be written', async () => {
  publishNotificationAudience(VIEWER, { tier: 'fof', fof: new Set([STRANGER]) });
  claimWrapNotification('w2');
  noteContentlessWrapAlert('w2');
  mockFire.mockResolvedValue(null);
  notifyDroppedDeferred(VIEWER, item('w2'));
  await flush();
  expect(mockFire).toHaveBeenCalledTimes(1);
  expect(mockDismiss).not.toHaveBeenCalled();
});

it('never alerts twice without a placeholder, and stays silent outside the tier', async () => {
  publishNotificationAudience(VIEWER, { tier: 'all', fof: null });
  claimWrapNotification('w3'); // alerted already, no placeholder
  notifyDroppedDeferred(VIEWER, item('w3'));
  publishNotificationAudience(VIEWER, { tier: 'friends', fof: null });
  noteContentlessWrapAlert('w4');
  notifyDroppedDeferred(VIEWER, item('w4'));
  await flush();
  expect(mockFire).not.toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
});

describe('held alerts wait for an audience that cannot answer yet', () => {
  it('alerts once the friends-of-friends set loads', async () => {
    // Follows reconciled before the set was read from cache.
    publishNotificationAudience(VIEWER, { tier: 'fof', fof: null });
    notifyDroppedDeferred(VIEWER, item('p1'));
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
    publishNotificationAudience(VIEWER, { tier: 'fof', fof: new Set([STRANGER]) });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
    // Released once: a later publish doesn't alert again.
    publishNotificationAudience(VIEWER, { tier: 'fof', fof: new Set([STRANGER]) });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the tier turns out not to admit the sender, or on sign-out', async () => {
    notifyDroppedDeferred(VIEWER, item('p2')); // nothing published yet
    publishNotificationAudience(VIEWER, { tier: 'friends', fof: null });
    notifyDroppedDeferred(VIEWER, item('p3'));
    __resetNotificationAudiences();
    notifyDroppedDeferred(VIEWER, item('p4'));
    clearParkedAudienceAlerts();
    publishNotificationAudience(VIEWER, { tier: 'all', fof: null });
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('drops an alert parked for longer than a minute', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    notifyDroppedDeferred(VIEWER, item('p5'));
    now.mockReturnValue(1_000_000 + 61_000);
    publishNotificationAudience(VIEWER, { tier: 'all', fof: null });
    await flush();
    now.mockRestore();
    expect(mockFire).not.toHaveBeenCalled();
  });
});

it('an ordinary DM held with its rumor alerts; a room chat (subject) does not', async () => {
  publishNotificationAudience(VIEWER, { tier: 'all', fof: null });
  const rumor = { pubkey: STRANGER, kind: 14, content: 'hi', created_at: 1 };
  notifyDroppedDeferred(VIEWER, { ...item('d1'), groupRumor: { ...rumor, tags: [] } });
  notifyDroppedDeferred(VIEWER, {
    ...item('d2'),
    groupRumor: { ...rumor, tags: [['subject', 'Book club']] },
  });
  await flush();
  expect(mockFire.mock.calls.map((c) => c[0].data.messageId)).toEqual(['d1']);
});
