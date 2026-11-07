import { Alert } from '../components/BrandedAlert';
import {
  __resetLinkActionSheetForTests,
  registerLinkActionSheet,
  showLinkActionSheet,
  whenLinkActionSheetReady,
} from './linkActionSheet';

jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister = null;
  // Clears the host AND the module-level waiter queue, so a test that queues a
  // waiter without registering a host can't leak it into the next test.
  __resetLinkActionSheetForTests();
  jest.clearAllMocks();
});

it('the reset drops a queued waiter that no host ever released', () => {
  const leaked = jest.fn();
  whenLinkActionSheetReady(leaked);
  __resetLinkActionSheetForTests();
  unregister = registerLinkActionSheet(jest.fn());
  expect(leaked).not.toHaveBeenCalled();
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

it('runs every queued readiness callback once', () => {
  const first = jest.fn();
  const second = jest.fn();
  whenLinkActionSheetReady(first);
  whenLinkActionSheetReady(second);
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();

  unregister = registerLinkActionSheet(jest.fn());
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);

  unregister();
  unregister = registerLinkActionSheet(jest.fn());
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

it('runs immediately when the host is already mounted', () => {
  unregister = registerLinkActionSheet(jest.fn());
  const run = jest.fn();
  whenLinkActionSheetReady(run);
  expect(run).toHaveBeenCalledTimes(1);
});
