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
  expect(await fetchWrapsByIds([], ['wss://relay'])).toEqual({ wraps: [], complete: true });
  expect(await fetchWrapsByIds(['w1'], [])).toEqual({ wraps: [], complete: true });
  expect(querySyncAbortable).not.toHaveBeenCalled();
});

it('reports a lookup only some relays answered as incomplete', async () => {
  const answer = (relays: string[]) =>
    (querySyncAbortable as jest.Mock).mockImplementationOnce(
      async (_pool, _relays, _filter, params: { completedRelays: Set<string> }) => {
        relays.forEach((r) => params.completedRelays.add(r));
        return [{ id: 'w1' }];
      },
    );
  const relays = ['wss://a', 'wss://b'];
  answer(['wss://a']);
  expect(await fetchWrapsByIds(['w1', 'w2'], relays)).toEqual({
    wraps: [{ id: 'w1' }],
    complete: false,
  });
  answer(relays);
  expect((await fetchWrapsByIds(['w1', 'w2'], relays)).complete).toBe(true);
});
