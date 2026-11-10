import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { idleScheduler } from '../utils/idleScheduler';
import {
  reconcileKeyBackupReminders,
  shouldShowKeyBackupBanner,
} from '../services/keyBackupReminder';
import { useKeyBackupReminder } from './useKeyBackupReminder';

const account = {
  isLoggedIn: true,
  pubkey: 'a'.repeat(64),
  signerType: 'nsec',
  identities: [{ pubkey: 'a'.repeat(64), signerType: 'nsec' }],
};
let mockAccount = { ...account };

jest.mock('../contexts/NostrContext', () => ({ useNostr: () => mockAccount }));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    // Model a focused Wallets tab, including cleanup as account state changes.
    const { useEffect: effect } = jest.requireActual<typeof import('react')>('react');
    effect(callback, [callback]);
  },
}));
jest.mock('../services/keyBackupReminder', () => ({
  reconcileKeyBackupReminders: jest.fn(async () => undefined),
  shouldShowKeyBackupBanner: jest.fn(async () => false),
  snoozeKeyBackupBanner: jest.fn(async () => undefined),
}));

const reconcile = jest.mocked(reconcileKeyBackupReminders);
const checkBanner = jest.mocked(shouldShowKeyBackupBanner);
let resume: (state: 'active' | 'background') => void;
const originalState = AppState.currentState;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockAccount = { ...account };
  checkBanner.mockResolvedValue(false);
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    resume = handler;
    return { remove: jest.fn() };
  });
  jest.spyOn(idleScheduler, 'runWhenIdle').mockImplementation(() => ({
    cancel: jest.fn(),
    then: jest.fn(),
    done: jest.fn(),
  }));
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  AppState.currentState = originalState;
});

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
}

it('reconciles the same account after the last account signs out and is re-added within an hour', async () => {
  const { rerender } = renderHook(useKeyBackupReminder);
  await settle();
  expect(reconcile).toHaveBeenCalledTimes(1);
  mockAccount = { ...account, isLoggedIn: false, identities: [] };
  rerender({});
  await settle();
  expect(reconcile).toHaveBeenCalledTimes(1);
  mockAccount = { ...account };
  rerender({});
  await settle();
  expect(reconcile).toHaveBeenCalledTimes(2);
});

it('reconciles on resume when permission has changed and updates the banner', async () => {
  checkBanner.mockResolvedValue(true);
  const { result } = renderHook(useKeyBackupReminder);
  await settle();
  expect(result.current.visible).toBe(true);
  checkBanner.mockResolvedValue(false);
  act(() => resume('background'));
  act(() => resume('active'));
  expect(reconcile).toHaveBeenCalledTimes(1);
  await settle();
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(result.current.visible).toBe(false);
});

it('reconciles again on refocus within an hour with the same account', async () => {
  const first = renderHook(useKeyBackupReminder);
  await settle();
  first.unmount();
  renderHook(useKeyBackupReminder);
  await settle();
  expect(reconcile).toHaveBeenCalledTimes(2);
});

it('reconciles registry changes even when the active account stays the same', async () => {
  const { rerender } = renderHook(useKeyBackupReminder);
  await settle();
  mockAccount = {
    ...account,
    identities: [...account.identities, { pubkey: 'b'.repeat(64), signerType: 'nsec' }],
  };
  rerender({});
  await settle();
  expect(reconcile).toHaveBeenCalledTimes(2);
});
