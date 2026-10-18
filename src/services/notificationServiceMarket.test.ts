// Marketplace history must respect preferences and source-event chronology.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireNotification, __resetForTests } from './notificationService';
import { listNotifications } from './notificationHistory';
const mockScheduleNotificationAsync = jest.fn().mockResolvedValue('notif-id');
const mockGetPresented = jest.fn().mockResolvedValue([]);
const mockDismiss = jest.fn().mockResolvedValue(undefined);
const mockGetScheduled = jest.fn().mockResolvedValue([]);
const mockCancel = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  scheduleNotificationAsync: (...args: unknown[]) => mockScheduleNotificationAsync(...args),
  getPresentedNotificationsAsync: () => mockGetPresented(),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  getAllScheduledNotificationsAsync: () => mockGetScheduled(),
  cancelScheduledNotificationAsync: (id: string) => mockCancel(id),
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationVisibility: { SECRET: -1, PRIVATE: 0, PUBLIC: 1 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

beforeEach(async () => {
  mockScheduleNotificationAsync.mockClear();
  await AsyncStorage.clear();
  __resetForTests();
});

it('checks the history preference gate before recording a market notification', async () => {
  const owner = 'e'.repeat(64);
  const mayRecord = jest.fn(async () => false);
  const onHistoryRecorded = jest.fn();
  await fireNotification({
    kind: 'market',
    title: 'Comment',
    body: '',
    owner,
    mayRecord,
    onHistoryRecorded,
  });
  expect(onHistoryRecorded).not.toHaveBeenCalled();
  expect(mayRecord).toHaveBeenCalledTimes(1);
  expect(await listNotifications(owner)).toEqual([]);
  expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
});

it('records market history using the source event timestamp', async () => {
  const owner = 'seller-history-owner';
  const historyCreatedAt = Date.now() - 5 * 86400 * 1000;
  const onHistoryRecorded = jest.fn();
  await fireNotification({
    kind: 'market',
    title: 'Catch-up comment',
    body: '',
    owner,
    historyKey: 'market:old-comment',
    historyCreatedAt,
    onHistoryRecorded,
    shouldSuppress: async () => true,
  });
  expect(onHistoryRecorded).toHaveBeenCalledTimes(1);
  expect(await listNotifications(owner)).toEqual([
    expect.objectContaining({ key: 'market:old-comment', createdAt: historyCreatedAt }),
  ]);
});

it('does not confirm history when cancelled during an asynchronous preference check', async () => {
  const owner = 'cancelled-seller';
  const controller = new AbortController();
  let release!: () => void;
  const onHistoryRecorded = jest.fn();
  const pending = fireNotification({
    kind: 'market',
    title: 'Comment',
    body: '',
    owner,
    onHistoryRecorded,
    mayRecord: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return !controller.signal.aborted;
    },
  });
  while (!release) await Promise.resolve();
  controller.abort();
  release();
  expect(await pending).toBeNull();
  expect(onHistoryRecorded).not.toHaveBeenCalled();
  expect(await listNotifications(owner)).toEqual([]);
  expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
});
