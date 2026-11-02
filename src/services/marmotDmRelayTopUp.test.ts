import { MarmotDmRelayTopUp } from './marmotDmRelayTopUp';

it('waits for the top-up commit, including concurrent sends, then tops up only once', async () => {
  let finish!: () => void;
  const commit = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  const changed = jest.fn();
  const topUp = new MarmotDmRelayTopUp(commit, changed);
  const sent = jest.fn();
  const first = topUp.sync('g', ['wss://one'], ['wss://two', 'wss://three']).then(sent);
  const second = topUp.sync('g', ['wss://one'], ['wss://two', 'wss://three']).then(sent);
  await Promise.resolve();
  expect(commit).toHaveBeenCalledTimes(1);
  expect(sent).not.toHaveBeenCalled();
  finish();
  await Promise.all([first, second]);
  expect(sent).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledTimes(1);
  await topUp.sync('g', ['wss://one'], ['wss://two']);
  expect(commit).toHaveBeenCalledTimes(1);
});

it('logs a failed top-up, allows the send, and does not retry this session', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const commit = jest
      .fn()
      .mockRejectedValueOnce(new Error('signer failed'))
      .mockResolvedValue(undefined);
    const topUp = new MarmotDmRelayTopUp(commit, jest.fn());
    await expect(topUp.sync('g', ['wss://one'], ['wss://two'])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[Marmot] relay top-up failed');
    await topUp.sync('g', ['wss://one'], ['wss://two']);
    expect(commit).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});
