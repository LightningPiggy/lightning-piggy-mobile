import { Toast } from '../components/BrandedToast';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { RemoteSignerMismatchError } from './remoteSignedEvent';
import {
  __resetMismatchNoticeForTests,
  MISMATCH_NOTICE_COOLDOWN_MS,
  noticeRemoteSignerMismatch,
} from './remoteSignerMismatchNotice';

jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const wrongAccount = () => new RemoteSignerMismatchError('wrong-account');

beforeEach(() => {
  jest.clearAllMocks();
  __resetMismatchNoticeForTests();
  setCurrentUserPubkey(A);
});
afterAll(() => setCurrentUserPubkey(null));

it('shows the translated reason as a branded error toast', () => {
  const error = wrongAccount();
  expect(noticeRemoteSignerMismatch(error, A, 1_000)).toBe(true);
  expect(Toast.show).toHaveBeenCalledWith({ type: 'error', text1: error.message });
});

it('shows one toast for a burst of refusals, and again after the cool-down', () => {
  noticeRemoteSignerMismatch(wrongAccount(), A, 1_000);
  noticeRemoteSignerMismatch(new RemoteSignerMismatchError('modified'), A, 1_500);
  noticeRemoteSignerMismatch(wrongAccount(), A, 1_000 + MISMATCH_NOTICE_COOLDOWN_MS - 1);
  expect(Toast.show).toHaveBeenCalledTimes(1);
  expect(noticeRemoteSignerMismatch(wrongAccount(), A, 1_000 + MISMATCH_NOTICE_COOLDOWN_MS)).toBe(
    true,
  );
  expect(Toast.show).toHaveBeenCalledTimes(2);
});

it("A's burst does not hide B's first refusal after a switch", () => {
  expect(noticeRemoteSignerMismatch(wrongAccount(), A, 1_000)).toBe(true);
  setCurrentUserPubkey(B);
  expect(noticeRemoteSignerMismatch(wrongAccount(), B, 1_500)).toBe(true);
  expect(Toast.show).toHaveBeenCalledTimes(2);
});

it("a late refusal of A's request after switching to B shows nothing", () => {
  setCurrentUserPubkey(B);
  expect(noticeRemoteSignerMismatch(wrongAccount(), A, 1_000)).toBe(false);
  expect(Toast.show).not.toHaveBeenCalled();
  // ...and does not use up A's notice for when A is active again.
  setCurrentUserPubkey(A);
  expect(noticeRemoteSignerMismatch(wrongAccount(), A, 1_500)).toBe(true);
});

it('ignores every other failure (declined, offline, ...)', () => {
  expect(noticeRemoteSignerMismatch(new Error('declined'), A)).toBe(false);
  expect(noticeRemoteSignerMismatch(null, A)).toBe(false);
  expect(Toast.show).not.toHaveBeenCalled();
});
