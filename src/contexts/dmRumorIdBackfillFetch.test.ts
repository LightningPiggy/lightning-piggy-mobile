import { fetchWrapsByIds } from './dmRumorIdBackfill';
import { querySyncAbortable } from '../services/relayQuery';

jest.mock('../services/nostrService', () => ({ pool: {} }));
jest.mock('../services/relayQuery', () => ({ querySyncAbortable: jest.fn(async () => []) }));

it('asks for per-relay completion, so an unanswered lookup rejects (and is retried)', async () => {
  await fetchWrapsByIds(['w1'], ['wss://relay']);
  const params = (querySyncAbortable as jest.Mock).mock.calls[0][3];
  expect(params.completedRelays).toBeInstanceOf(Set);
});

it('skips the lookup with no ids or no relays', async () => {
  (querySyncAbortable as jest.Mock).mockClear();
  expect(await fetchWrapsByIds([], ['wss://relay'])).toEqual([]);
  expect(await fetchWrapsByIds(['w1'], [])).toEqual([]);
  expect(querySyncAbortable).not.toHaveBeenCalled();
});
