import { renderHook } from '@testing-library/react-native';
import { idleScheduler } from '../utils/idleScheduler';
import {
  DEFAULT_DM_INBOX_DELAY_MS,
  useDefaultDmInbox,
  type UseDefaultDmInboxParams,
} from './useDefaultDmInbox';
import { checkDefaultDmInbox } from './defaultDmInbox';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';

jest.mock('./defaultDmInbox', () => ({
  checkDefaultDmInbox: jest.fn(async () => 'suggested'),
}));

const PK = 'a'.repeat(64);
const ensure = checkDefaultDmInbox as jest.Mock;
const base = (over: Partial<UseDefaultDmInboxParams> = {}): UseDefaultDmInboxParams => ({
  pubkey: PK,
  isLoggedIn: true,
  signerType: 'nsec',
  nip65Relays: [],
  dmInboxLive: { relays: () => [], createdAt: () => 0, session: () => 3 },
  getReadRelays: () => ['wss://read.example'],
  applyPublishedDmInbox: jest.fn(),
  applyPublishedRelayList: jest.fn(),
  ...over,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  setCurrentUserPubkey(PK);
  jest.spyOn(idleScheduler, 'runWhenIdle').mockImplementation((task?: unknown) => {
    (task as () => void)();
    return { cancel: jest.fn() } as unknown as ReturnType<typeof idleScheduler.runWhenIdle>;
  });
});
afterEach(() => {
  jest.useRealTimers();
  setCurrentUserPubkey(null);
});

it('waits well past cold start (>= 10 s, then idle) before checking', () => {
  expect(DEFAULT_DM_INBOX_DELAY_MS).toBeGreaterThanOrEqual(10_000);
  renderHook(() => useDefaultDmInbox(base()));
  jest.advanceTimersByTime(DEFAULT_DM_INBOX_DELAY_MS - 1);
  expect(ensure).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(ensure.mock.calls[0][0]).toMatchObject({ pubkey: PK, readRelays: ['wss://read.example'] });
  // A check only: it is never handed a signer, so it can't publish anything.
  expect(ensure.mock.calls[0][0].sign).toBeUndefined();
});

it('uses the newest relay lists when it fires, and runs once per account', () => {
  const { rerender } = renderHook((p: UseDefaultDmInboxParams) => useDefaultDmInbox(p), {
    initialProps: base(),
  });
  const live = (relays: string[], createdAt = 0) => ({
    dmInboxLive: { relays: () => relays, createdAt: () => createdAt, session: () => 3 },
  });
  rerender(base(live(['wss://loaded.example'])));
  jest.advanceTimersByTime(DEFAULT_DM_INBOX_DELAY_MS);
  expect(ensure).toHaveBeenCalledTimes(1);
  const args = ensure.mock.calls[0][0];
  // Read live at each step (not a snapshot), and bound to this session.
  expect(args.knownInbox()).toEqual(['wss://loaded.example']);
  rerender(base(live(['wss://adopted-later.example'], 99)));
  expect(args.knownInbox()).toEqual(['wss://adopted-later.example']);
  expect(args.knownInboxCreatedAt()).toBe(99);
  expect(args.session).toBe(3);
  // New relay lists don't re-schedule it.
  rerender(base({ nip65Relays: [{ url: 'wss://x.example', read: true, write: true }] }));
  jest.advanceTimersByTime(DEFAULT_DM_INBOX_DELAY_MS * 2);
  expect(ensure).toHaveBeenCalledTimes(1);
});

it('an account switch before it fires cancels it for the old account', () => {
  const other = 'b'.repeat(64);
  const { rerender } = renderHook((p: UseDefaultDmInboxParams) => useDefaultDmInbox(p), {
    initialProps: base(),
  });
  jest.advanceTimersByTime(DEFAULT_DM_INBOX_DELAY_MS / 2);
  setCurrentUserPubkey(other);
  rerender(base({ pubkey: other }));
  jest.advanceTimersByTime(DEFAULT_DM_INBOX_DELAY_MS);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(ensure.mock.calls[0][0].pubkey).toBe(other);
});

it('does nothing while signed out or without a signer', () => {
  renderHook(() => useDefaultDmInbox(base({ isLoggedIn: false })));
  renderHook(() => useDefaultDmInbox(base({ signerType: null })));
  jest.advanceTimersByTime(DEFAULT_DM_INBOX_DELAY_MS * 2);
  expect(ensure).not.toHaveBeenCalled();
});

it('stops counting as active once the account switches or signs out mid-check', () => {
  const { rerender } = renderHook((p: UseDefaultDmInboxParams) => useDefaultDmInbox(p), {
    initialProps: base(),
  });
  jest.advanceTimersByTime(DEFAULT_DM_INBOX_DELAY_MS);
  const { isActive } = ensure.mock.calls[0][0];
  expect(isActive()).toBe(true);
  setCurrentUserPubkey('b'.repeat(64));
  expect(isActive()).toBe(false);
  setCurrentUserPubkey(PK);
  rerender(base({ isLoggedIn: false }));
  expect(isActive()).toBe(false);
});
