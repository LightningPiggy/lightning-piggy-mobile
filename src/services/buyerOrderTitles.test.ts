import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buyerOrderTitleGeneration,
  loadBuyerOrderTitles,
  recordBuyerOrderTitles,
  retireBuyerOrderTitles,
  reviveBuyerOrderTitles,
  waitForBuyerOrderTitleWrites,
} from './buyerOrderTitles';

const account = 'buyer';
const titles = { item: 'Private purchase' };

beforeEach(async () => {
  await waitForBuyerOrderTitleWrites();
  await AsyncStorage.clear();
  reviveBuyerOrderTitles(account);
});

it('keeps pre-wipe checkout invalid after re-login while allowing new orders', async () => {
  const generation = buyerOrderTitleGeneration(account);
  retireBuyerOrderTitles(account);
  await recordBuyerOrderTitles(account, 'retired', titles);
  expect(await loadBuyerOrderTitles(account)).toEqual({});
  reviveBuyerOrderTitles(account);
  await recordBuyerOrderTitles(account, 'stale', titles, generation);
  await recordBuyerOrderTitles(account, 'new', titles);
  expect(await loadBuyerOrderTitles(account)).toEqual({ new: titles });
});

it('rechecks retirement after an in-flight storage read before committing', async () => {
  let release!: (value: string | null) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  );
  jest.mocked(AsyncStorage.setItem).mockClear();
  const write = recordBuyerOrderTitles(account, 'pending', titles);
  await reading;
  retireBuyerOrderTitles(account);
  release(null);
  await write;
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(await loadBuyerOrderTitles(account)).toEqual({});
});
