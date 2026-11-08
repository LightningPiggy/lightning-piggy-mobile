import { knownInboxEvent } from './knownInboxEvent';
import {
  markWrapHandled,
  noteWrapInFlight,
  noteWrapStored,
} from '../services/dmWrapNotificationDedupe';

jest.mock('../services/notificationHistory', () => ({ removeNotificationsWhere: jest.fn() }));
jest.mock('../services/notificationService', () => ({
  cancelInFlightNotifications: jest.fn(),
  dismissNotificationsFor: jest.fn(),
}));

const OWNER = 'a'.repeat(64);

test('skips the owner’s stored ids but still fetches wraps a live sub holds in flight', () => {
  const ref = { current: { pubkey: OWNER, set: new Set(['stored', 'claimed']) } };
  noteWrapInFlight('claimed');
  const isKnown = knownInboxEvent(ref, OWNER);
  expect(isKnown('stored')).toBe(true);
  expect(isKnown('claimed')).toBe(false);
  expect(isKnown('new')).toBe(false);
  noteWrapStored('claimed');
  expect(isKnown('claimed')).toBe(true);
  markWrapHandled('claimed');
});

test('another account’s set never counts', () => {
  const ref = { current: { pubkey: 'b'.repeat(64), set: new Set(['stored']) } };
  expect(knownInboxEvent(ref, OWNER)('stored')).toBe(false);
});
