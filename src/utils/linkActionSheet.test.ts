import { Alert } from '../components/BrandedAlert';
import {
  registerLinkActionSheet,
  showLinkActionSheet,
  whenLinkActionSheetReady,
} from './linkActionSheet';

jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
  jest.clearAllMocks();
});

it('waits for the host before running a cold-start prompt, then runs it once', () => {
  const host = jest.fn();
  whenLinkActionSheetReady(() => showLinkActionSheet('Confirm', 'Pay', [], {}));
  expect(host).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();

  unregister = registerLinkActionSheet(host);
  expect(host).toHaveBeenCalledTimes(1);
  expect(host).toHaveBeenCalledWith(expect.objectContaining({ title: 'Confirm', message: 'Pay' }));

  // A later re-registration (host remount) must not replay the old prompt.
  unregister();
  unregister = registerLinkActionSheet(host);
  expect(host).toHaveBeenCalledTimes(1);
});

it('runs immediately when the host is already mounted', () => {
  unregister = registerLinkActionSheet(jest.fn());
  const run = jest.fn();
  whenLinkActionSheetReady(run);
  expect(run).toHaveBeenCalledTimes(1);
});
