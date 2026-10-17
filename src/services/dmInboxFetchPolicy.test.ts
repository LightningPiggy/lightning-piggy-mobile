import { DM_INBOX_LIMIT, kind4FetchCapacity } from './dmInboxFetchPolicy';
import { enabledAppRelays } from './appRelayPrefs';
import { Kind4RetryStore } from '../contexts/kind4RetryStore';

jest.mock('./appRelayPrefs', () => ({ enabledAppRelays: jest.fn() }));
const enabled = enabledAppRelays as jest.Mock;

describe('kind4FetchCapacity', () => {
  it('covers two filters on every distinct relay', () => {
    enabled.mockReturnValue(['wss://a', 'wss://b']);
    expect(kind4FetchCapacity(['wss://b', 'wss://c'], 10)).toBe(2 * 10 * 3);
  });

  it('stays positive before the App Relays prefs load (no relays yet)', () => {
    // Cold start: enabledAppRelays keeps defaults closed until prefs load.
    enabled.mockReturnValue([]);
    expect(kind4FetchCapacity()).toBe(2 * DM_INBOX_LIMIT);
    expect(() => new Kind4RetryStore('owner')).not.toThrow();
  });

  it('still rejects an invalid limit', () => {
    enabled.mockReturnValue([]);
    expect(() => kind4FetchCapacity([], 0)).toThrow('Invalid DM fetch limit');
  });
});
