import * as mod from './dmWrapNotificationDedupe';
import { claimWrapNotification, __resetForTests } from './dmWrapNotificationDedupe';

beforeEach(() => __resetForTests());

describe('claimWrapNotification', () => {
  it('grants the first claim and refuses the second for the same wrap id', () => {
    expect(claimWrapNotification('wrap-1')).toBe(true);
    expect(claimWrapNotification('wrap-1')).toBe(false);
  });

  it('treats distinct wrap ids independently', () => {
    expect(claimWrapNotification('wrap-a')).toBe(true);
    expect(claimWrapNotification('wrap-b')).toBe(true);
  });

  it('always grants for a missing id (never blocks a notification on bad data)', () => {
    expect(claimWrapNotification(undefined)).toBe(true);
    expect(claimWrapNotification(null)).toBe(true);
    expect(claimWrapNotification('')).toBe(true);
  });

  it('evicts oldest entries once the table is full, keeping recent claims intact', () => {
    for (let i = 0; i < 600; i++) claimWrapNotification(`wrap-${i}`);
    // The most recent claim is still held...
    expect(claimWrapNotification('wrap-599')).toBe(false);
    // ...while the oldest was evicted and can be re-claimed.
    expect(claimWrapNotification('wrap-0')).toBe(true);
  });
});

describe('live sub hand-off (contentless phantoms)', () => {
  beforeEach(() => mod.__resetForTests());

  it('tracks whether a decrypting live sub is armed, per open / teardown', () => {
    expect(mod.isLiveDmSubArmed()).toBe(false);
    mod.noteLiveDmSubArmed(true);
    mod.noteLiveDmSubArmed(true);
    mod.noteLiveDmSubArmed(false);
    expect(mod.isLiveDmSubArmed()).toBe(true);
    mod.noteLiveDmSubArmed(false);
    mod.noteLiveDmSubArmed(false); // never negative
    expect(mod.isLiveDmSubArmed()).toBe(false);
    mod.noteLiveDmSubArmed(true);
    expect(mod.isLiveDmSubArmed()).toBe(true);
  });

  it('remembers handled wraps and hands a contentless alert over exactly once', () => {
    mod.markWrapHandled('w1');
    expect(mod.wasWrapHandled('w1')).toBe(true);
    expect(mod.wasWrapHandled('w2')).toBe(false);
    mod.noteContentlessWrapAlert('w2');
    expect(mod.takeContentlessWrapAlert('w2')).toBe(true);
    expect(mod.takeContentlessWrapAlert('w2')).toBe(false);
  });
});

describe('live sub wrap index (no second decrypt in the background watch)', () => {
  it('answers from every registered index until it is unregistered', () => {
    const a = new Set(['w1']);
    const b = new Set(['w2']);
    const unregisterA = mod.registerLiveDmWrapIndex((id) => a.has(id));
    const unregisterB = mod.registerLiveDmWrapIndex((id) => b.has(id));
    expect(mod.liveDmSubHasWrap('w1')).toBe(true);
    expect(mod.liveDmSubHasWrap('w2')).toBe(true);
    expect(mod.liveDmSubHasWrap('w3')).toBe(false);
    unregisterA();
    expect(mod.liveDmSubHasWrap('w1')).toBe(false);
    expect(mod.liveDmSubHasWrap('w2')).toBe(true);
    unregisterB();
    expect(mod.liveDmSubHasWrap('w2')).toBe(false);
  });

  it('keeps two registrations of the same lookup apart', () => {
    const has = (id: string) => id === 'w1';
    const first = mod.registerLiveDmWrapIndex(has);
    const second = mod.registerLiveDmWrapIndex(has);
    first();
    expect(mod.liveDmSubHasWrap('w1')).toBe(true);
    second();
    expect(mod.liveDmSubHasWrap('w1')).toBe(false);
  });

  it('never matches an empty id', () => {
    mod.registerLiveDmWrapIndex(() => true);
    expect(mod.liveDmSubHasWrap('')).toBe(false);
  });
});
