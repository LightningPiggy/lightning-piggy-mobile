import { deriveGeocacheRailState } from './geocacheRailState';

describe('deriveGeocacheRailState', () => {
  it('loads only while a positioned query has not completed', () => {
    expect(deriveGeocacheRailState(0, true, null)).toBe('loading');
  });
  it('shows empty after EOSE or the bounded timeout', () => {
    expect(deriveGeocacheRailState(0, true, { allRelaysFailed: false })).toBe('empty');
  });
  it('shows retry after all relays fail', () => {
    expect(deriveGeocacheRailState(0, true, { allRelaysFailed: true })).toBe('error');
  });
  it('keeps cached or newly received visible content ready during loading/failure', () => {
    expect(deriveGeocacheRailState(1, true, null)).toBe('ready');
    expect(deriveGeocacheRailState(1, true, { allRelaysFailed: true })).toBe('ready');
    expect(deriveGeocacheRailState(1, true, { allRelaysFailed: false })).toBe('ready');
  });
  it('never shows endless skeletons without a position/query', () => {
    expect(deriveGeocacheRailState(0, false, null)).toBe('empty');
  });
  it('starts loading again on refresh when no visible content exists', () => {
    expect(deriveGeocacheRailState(0, true, { allRelaysFailed: true })).toBe('error');
    expect(deriveGeocacheRailState(0, true, null)).toBe('loading');
    expect(deriveGeocacheRailState(0, true, { allRelaysFailed: false })).toBe('empty');
  });
});
