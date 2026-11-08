import type { NostrContact, NostrProfile } from '../types/nostr';
import { mergeContactProfiles, newerProfile } from './profileFreshness';

const profile = (name: string, createdAt?: number): NostrProfile => ({
  pubkey: 'a'.repeat(64),
  npub: 'npub',
  name,
  displayName: null,
  picture: null,
  banner: null,
  about: null,
  lud16: null,
  nip05: null,
  ...(createdAt !== undefined ? { createdAt } : {}),
});

describe('newerProfile (#1390)', () => {
  it('keeps a newer copy over a late older one', () => {
    const shown = profile('new', 200);
    expect(newerProfile(shown, profile('old', 100))).toBe(shown);
  });

  it('takes a newer or equally dated copy', () => {
    const late = profile('late', 300);
    expect(newerProfile(profile('cached', 200), late)).toBe(late);
    const same = profile('same', 200);
    expect(newerProfile(profile('cached', 200), same)).toBe(same);
  });

  it('an undated copy on either side keeps the latest-fetch-wins behaviour', () => {
    const undated = profile('undated');
    expect(newerProfile(profile('cached', 200), undated)).toBe(undated);
    const dated = profile('dated', 1);
    expect(newerProfile(profile('legacy'), dated)).toBe(dated);
  });

  it('no incoming copy keeps the existing one', () => {
    const shown = profile('shown', 1);
    expect(newerProfile(shown, undefined)).toBe(shown);
    expect(newerProfile(undefined, null)).toBeNull();
  });
});

describe('mergeContactProfiles', () => {
  const contact = (pubkey: string, p: NostrProfile | null): NostrContact => ({
    pubkey,
    relay: null,
    petname: null,
    profile: p,
  });

  it('merges newest-wins and keeps untouched contacts identical', () => {
    const fresh = contact('a', profile('fresh', 500));
    const missing = contact('b', null);
    const other = contact('c', profile('c', 1));
    const merged = mergeContactProfiles(
      [fresh, missing, other],
      new Map([
        ['a', profile('stale replay', 100)],
        ['b', profile('found late', 400)],
      ]),
    );
    expect(merged[0]).toBe(fresh);
    expect(merged[1].profile?.name).toBe('found late');
    expect(merged[2]).toBe(other);
  });
});
