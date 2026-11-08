import { ownEventPublishTargets } from './ownEventPublishTargets';
import { relayAllowsKind } from './relayKindPolicy';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';

jest.mock('./relayKindPolicy', () => ({ relayAllowsKind: jest.fn() }));

const PK = 'a'.repeat(64);
const allows = relayAllowsKind as jest.Mock;
const relays = [
  { url: 'wss://my-write.example', read: false, write: true },
  { url: 'wss://my-read.example', read: true, write: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  // purplepag.es stores 0/3/10002/10050; user.kindpag.es only 0/3/10002.
  allows.mockImplementation(async (url: string, kind: number) =>
    url === 'wss://user.kindpag.es' ? [0, 3, 10002].includes(kind) : true,
  );
});

it.each([0, 3])('kind %i goes to the write relays plus the indexers', async (kind) => {
  expect(await ownEventPublishTargets(PK, relays, kind)).toEqual([
    'wss://my-write.example',
    'wss://purplepag.es',
    'wss://user.kindpag.es',
  ]);
});

it('falls back to the app defaults when the user has no write relays', async () => {
  const targets = await ownEventPublishTargets(PK, [relays[1]], 0);
  expect(targets).toEqual([...DEFAULT_RELAYS, 'wss://purplepag.es', 'wss://user.kindpag.es']);
});

it('leaves out an indexer that does not store the kind', async () => {
  allows.mockImplementation(async (url: string) => url !== 'wss://user.kindpag.es');
  expect(await ownEventPublishTargets(PK, relays, 3)).toEqual([
    'wss://my-write.example',
    'wss://purplepag.es',
  ]);
});

it('a test account in lockdown publishes to the LAN test relay only, asking no indexer', async () => {
  const testPk = [...TEST_ACCOUNT_PUBKEYS][0];
  expect(await ownEventPublishTargets(testPk, relays, 0)).toEqual([TEST_RELAY_URL]);
  expect(allows).not.toHaveBeenCalled();
});
