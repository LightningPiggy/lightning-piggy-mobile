import type { Event } from 'nostr-tools';
import { listingRelayCoverage, newestListing, relayHasListing } from './listingRelayCoverage';
const event = (id: string, created_at = 10, d = 'item'): Event => ({
  id,
  created_at,
  kind: 30402,
  pubkey: 'me',
  tags: [['d', d]],
  content: '',
  sig: '',
});
test('latest revision wins, with deterministic NIP-01 ties', () => {
  expect(newestListing([event('z'), event('b', 20), event('a', 20)])?.id).toBe('a');
  expect(newestListing([])).toBeNull();
});
test('coverage counts same/newer revision at the same address only', () => {
  const latest = event('latest', 20);
  expect(relayHasListing([event('old')], latest)).toBe(false);
  expect(relayHasListing([event('other', 30, 'elsewhere')], latest)).toBe(false);
  expect(relayHasListing([{ ...latest, pubkey: 'other' }], latest)).toBe(false);
  const coverage = listingRelayCoverage(
    latest,
    new Map([
      ['a', [latest]],
      ['b', [event('equal', 20)]],
      ['c', [event('new', 30)]],
      ['d', []],
      ['e', [event('old')]],
    ]),
  );
  expect(coverage).toEqual({ count: 3, total: 5, warning: false, missing: false });
});
test('one or two targets require every relay; larger sets require two', () => {
  const latest = event('a');
  expect(listingRelayCoverage(latest, new Map([['a', []]])).warning).toBe(true);
  expect(listingRelayCoverage(latest, new Map([['a', [latest]]])).warning).toBe(false);
  expect(
    listingRelayCoverage(
      latest,
      new Map([
        ['a', [latest]],
        ['b', []],
      ]),
    ).warning,
  ).toBe(true);
  expect(listingRelayCoverage(null, new Map([['a', []]])).missing).toBe(true);
});
test('equal-time losing revisions do not suppress the low-coverage warning', () => {
  const winner = event('a', 20);
  const loser = event('b', 20);
  expect(newestListing([loser, winner])).toEqual(winner);
  expect(relayHasListing([loser], winner)).toBe(false);
  expect(relayHasListing([winner], loser)).toBe(true);
  expect(
    listingRelayCoverage(
      winner,
      new Map([
        ['present', [winner]],
        ['outdated', [loser]],
      ]),
    ),
  ).toEqual({ count: 1, total: 2, warning: true, missing: false });
});
