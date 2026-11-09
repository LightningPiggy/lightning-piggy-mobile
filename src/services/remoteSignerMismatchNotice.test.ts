import { Toast } from '../components/BrandedToast';
import { RemoteSignerMismatchError } from './remoteSignedEvent';
import {
  __resetMismatchNoticeForTests,
  MISMATCH_NOTICE_COOLDOWN_MS,
  noticeRemoteSignerMismatch,
} from './remoteSignerMismatchNotice';

jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  __resetMismatchNoticeForTests();
});

it('shows the translated reason as a branded error toast', () => {
  const error = new RemoteSignerMismatchError('wrong-account');
  expect(noticeRemoteSignerMismatch(error, 1_000)).toBe(true);
  expect(Toast.show).toHaveBeenCalledWith({ type: 'error', text1: error.message });
});

it('shows one toast for a burst of refusals, and again after the cool-down', () => {
  const error = new RemoteSignerMismatchError('wrong-account');
  noticeRemoteSignerMismatch(error, 1_000);
  noticeRemoteSignerMismatch(new RemoteSignerMismatchError('modified'), 1_500);
  noticeRemoteSignerMismatch(error, 1_000 + MISMATCH_NOTICE_COOLDOWN_MS - 1);
  expect(Toast.show).toHaveBeenCalledTimes(1);
  expect(noticeRemoteSignerMismatch(error, 1_000 + MISMATCH_NOTICE_COOLDOWN_MS)).toBe(true);
  expect(Toast.show).toHaveBeenCalledTimes(2);
});

it('ignores every other failure (declined, offline, ...)', () => {
  expect(noticeRemoteSignerMismatch(new Error('declined'))).toBe(false);
  expect(noticeRemoteSignerMismatch(null)).toBe(false);
  expect(Toast.show).not.toHaveBeenCalled();
});
