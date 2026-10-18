import { loadAppRelayPrefs } from './appRelayPrefs';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import {
  buildKeyPackageRelayList,
  cleanKeyPackageRelays,
  keyPackagePublishRelays,
  MARMOT_KEY_PACKAGE_RELAYS,
  MAX_KEY_PACKAGE_RELAYS,
  parseKeyPackageRelayList,
} from './marmotKeyPackageRelays';

const owner = 'a'.repeat(64);
beforeEach(async () => {
  await loadAppRelayPrefs(owner);
});
it('keeps own relays and every well-known relay, normalised and deduplicated', () => {
  expect(keyPackagePublishRelays(owner, ['wss://OWN.example/', 'wss://relay.primal.net/'])).toEqual(
    ['wss://own.example', 'wss://relay.primal.net', ...MARMOT_KEY_PACKAGE_RELAYS.slice(0, 2)],
  );
  const many = Array.from({ length: 100 }, (_, i) => `wss://relay${i}.example`);
  const selected = keyPackagePublishRelays(owner, many);
  expect(selected).toHaveLength(MAX_KEY_PACKAGE_RELAYS);
  expect(selected).toEqual(expect.arrayContaining(MARMOT_KEY_PACKAGE_RELAYS));
  expect(keyPackagePublishRelays(owner, [])).toEqual(MARMOT_KEY_PACKAGE_RELAYS);
});
it('builds and parses MIP-00 relay tags, rejecting unsafe or malformed destinations', () => {
  const event = buildKeyPackageRelayList(
    owner,
    [
      'wss://relay.example/',
      'wss://relay.example',
      'ws://localhost',
      'wss://user:pass@relay.example',
      'wss://192.168.1.1',
      'junk',
    ],
    123,
  );
  expect(event).toEqual({
    kind: 10051,
    created_at: 123,
    tags: [['relay', 'wss://relay.example']],
    content: '',
  });
  expect(
    parseKeyPackageRelayList([
      ...event.tags,
      ['r', 'wss://wrong.example'],
      ['relay'],
      ['relay', 'junk'],
    ]),
  ).toEqual(['wss://relay.example']);
  expect(
    cleanKeyPackageRelays(Array.from({ length: 30 }, (_, i) => `wss://r${i}.example`)),
  ).toHaveLength(MAX_KEY_PACKAGE_RELAYS);
});
it('selects and advertises LAN only for locked test owners', () => {
  const testOwner = [...TEST_ACCOUNT_PUBKEYS][0];
  expect(keyPackagePublishRelays(testOwner, MARMOT_KEY_PACKAGE_RELAYS)).toEqual([TEST_RELAY_URL]);
  expect(buildKeyPackageRelayList(testOwner, MARMOT_KEY_PACKAGE_RELAYS).tags).toEqual([
    ['relay', TEST_RELAY_URL],
  ]);
});
