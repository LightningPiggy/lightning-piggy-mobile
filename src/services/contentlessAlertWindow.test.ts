import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CONTENTLESS_QUIET_WINDOW_MS,
  claimAudibleContentlessAlert,
} from './contentlessAlertWindow';

const owner = 'a'.repeat(64);
beforeEach(async () => {
  await AsyncStorage.clear();
});

it('lets the first alert buzz and keeps the rest of the window quiet', async () => {
  expect(await claimAudibleContentlessAlert(owner, 1_000_000)).toBe(true);
  expect(await claimAudibleContentlessAlert(owner, 1_030_000)).toBe(false);
  expect(
    await claimAudibleContentlessAlert(owner, 1_000_000 + CONTENTLESS_QUIET_WINDOW_MS - 1),
  ).toBe(false);
  expect(await claimAudibleContentlessAlert(owner, 1_000_000 + CONTENTLESS_QUIET_WINDOW_MS)).toBe(
    true,
  );
});

it('buzzes once for a burst arriving together', async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, () => claimAudibleContentlessAlert(owner, 2_000_000)),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});

it('keeps each account to its own window', async () => {
  expect(await claimAudibleContentlessAlert(owner, 1_000)).toBe(true);
  expect(await claimAudibleContentlessAlert('b'.repeat(64), 2_000)).toBe(true);
});

it('treats a clock that went backwards, or a corrupt record, as a fresh window', async () => {
  await AsyncStorage.setItem(`contentless_alert_last_v1:${owner}`, 'garbage');
  expect(await claimAudibleContentlessAlert(owner, 5_000)).toBe(true);
  await AsyncStorage.setItem(`contentless_alert_last_v1:${owner}`, String(9_000_000));
  expect(await claimAudibleContentlessAlert(owner, 5_000)).toBe(true);
});
