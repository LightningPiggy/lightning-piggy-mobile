import { idleScheduler } from './idleScheduler';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('defers work until idle instead of running it on the current stack', () => {
  const work = jest.fn();
  idleScheduler.runWhenIdle(work);
  expect(work).not.toHaveBeenCalled();
  jest.runOnlyPendingTimers();
  expect(work).toHaveBeenCalledTimes(1);
});

it('cancels work when its owner unmounts before the idle callback', () => {
  const work = jest.fn();
  idleScheduler.runWhenIdle(work).cancel();
  jest.runOnlyPendingTimers();
  expect(work).not.toHaveBeenCalled();
});
