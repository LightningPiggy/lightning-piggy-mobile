/**
 * Unit tests for promoteSuccessorIdentity (#851 F4 — stale drawer).
 *
 * The bug: after the active identity signed out, the drawer header kept
 * showing the OLD display name because the logout-with-successor path
 * promoted the successor without first clearing the previous identity's
 * profile/contacts. These tests pin the teardown-before-set ordering and the
 * successor-profile cache hydrate that repaint the drawer to the successor.
 */

const mockPersistKeys = jest.fn(async (..._a: unknown[]) => {});
jest.mock('./persistActiveIdentityKeys', () => ({
  persistActiveIdentityKeys: (...a: unknown[]) => mockPersistKeys(...a),
}));

let deferred: (() => void) | null = null;
jest.mock('../utils/idleScheduler', () => ({
  idleScheduler: {
    runWhenIdle: (fn: () => void) => {
      deferred = fn;
    },
  },
}));

import { promoteSuccessorIdentity } from './promoteSuccessorIdentity';
import type { StoredIdentity } from '../services/identitiesStore';

const SUCCESSOR: StoredIdentity = {
  pubkey: 'b'.repeat(64),
  signerType: 'nsec',
  nsec: 'nsec1successor',
  lastUsedAt: 1,
};

function makeDeps() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      setProfile: jest.fn((p: unknown) => calls.push(`setProfile:${p === null ? 'null' : 'x'}`)),
      setContacts: jest.fn((c: unknown[]) => calls.push(`setContacts:${c.length}`)),
      setPubkey: jest.fn((pk: string) => calls.push(`setPubkey:${pk.slice(0, 4)}`)),
      setSignerType: jest.fn((s: string) => calls.push(`setSignerType:${s}`)),
      setIsLoggedIn: jest.fn((v: boolean) => calls.push(`setIsLoggedIn:${v}`)),
      setDmInbox: jest.fn((e: unknown[]) => calls.push(`setDmInbox:${e.length}`)),
      loadProfileFromCache: jest.fn(async (pk: string) => {
        calls.push(`loadProfileFromCache:${pk.slice(0, 4)}`);
        return true;
      }),
      loadContactsFromCache: jest.fn(async (pk: string) => {
        calls.push(`loadContactsFromCache:${pk.slice(0, 4)}`);
      }),
      hydrateDmInboxFromCache: jest.fn(async (pk: string) => {
        calls.push(`hydrateDmInboxFromCache:${pk.slice(0, 4)}`);
      }),
      loadRelays: jest.fn(async () => ['wss://relay.example']),
      loadProfile: jest.fn(async () => {}),
    },
  };
}

describe('promoteSuccessorIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deferred = null;
  });

  it('clears the stale profile + contacts BEFORE setting the successor (F4)', async () => {
    const { calls, deps } = makeDeps();
    await promoteSuccessorIdentity(SUCCESSOR, deps);

    const clearProfile = calls.indexOf('setProfile:null');
    const clearContacts = calls.indexOf('setContacts:0');
    const setPk = calls.indexOf('setPubkey:bbbb');
    expect(clearProfile).toBeGreaterThanOrEqual(0);
    expect(clearContacts).toBeGreaterThanOrEqual(0);
    // The drawer must never see the new pubkey alongside the old profile.
    expect(clearProfile).toBeLessThan(setPk);
    expect(clearContacts).toBeLessThan(setPk);
  });

  it('clears the stale DM inbox BEFORE hydrating, so an empty-cache successor shows no prior previews', async () => {
    const { calls, deps } = makeDeps();
    // hydrateDmInboxFromCache leaves the inbox untouched when the successor's
    // cache is empty (the real non-empty-only guard) — so the explicit
    // setDmInbox([]) is the only thing preventing the prior identity's
    // previews from leaking into the new session.
    await promoteSuccessorIdentity(SUCCESSOR, deps);

    expect(deps.setDmInbox).toHaveBeenCalledWith([]);
    const clearInbox = calls.indexOf('setDmInbox:0');
    const setPk = calls.indexOf('setPubkey:bbbb');
    const hydrate = calls.indexOf(`hydrateDmInboxFromCache:${SUCCESSOR.pubkey.slice(0, 4)}`);
    expect(clearInbox).toBeGreaterThanOrEqual(0);
    // Cleared before the successor becomes active AND before the (no-op for an
    // empty cache) hydrate, mirroring switchIdentity's teardown ordering.
    expect(clearInbox).toBeLessThan(setPk);
    expect(clearInbox).toBeLessThan(hydrate);
  });

  it('hydrates the successor profile from cache so the drawer repaints', async () => {
    const { deps } = makeDeps();
    await promoteSuccessorIdentity(SUCCESSOR, deps);
    expect(deps.loadProfileFromCache).toHaveBeenCalledWith(SUCCESSOR.pubkey);
    expect(deps.loadContactsFromCache).toHaveBeenCalledWith(SUCCESSOR.pubkey);
    expect(deps.hydrateDmInboxFromCache).toHaveBeenCalledWith(SUCCESSOR.pubkey);
  });

  it('persists the successor as the active identity', async () => {
    const { deps } = makeDeps();
    await promoteSuccessorIdentity(SUCCESSOR, deps);
    expect(mockPersistKeys).toHaveBeenCalledWith(SUCCESSOR);
    expect(deps.setIsLoggedIn).toHaveBeenCalledWith(true);
  });

  it('defers the relay refresh and converges to the real kind-0', async () => {
    const { deps } = makeDeps();
    await promoteSuccessorIdentity(SUCCESSOR, deps);
    // Not called synchronously — deferred behind interactions.
    expect(deps.loadProfile).not.toHaveBeenCalled();
    expect(deferred).toBeTruthy();
    await deferred!();
    expect(deps.loadRelays).toHaveBeenCalledWith(SUCCESSOR.pubkey);
    expect(deps.loadProfile).toHaveBeenCalledWith(SUCCESSOR.pubkey, ['wss://relay.example']);
  });
});
