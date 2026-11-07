import { getFollowGateStore } from '../services/followSetEvents';
import {
  cacheConversationReactions,
  readConversationReactions,
  reactionCacheGeneration,
} from '../utils/conversationReactionCache';
import { renderHook } from '@testing-library/react-native';
import { clearDecryptedMediaMemory, setDecryptedMediaOwner } from '../services/decryptedMediaCache';
import { stopNativeDmEngineGlobal } from './nativeDmEngine';
import { clearMemoisedSecretKey, nip04PlaintextCache } from './nostrSecretKeyCache';
import { hasFailedMedia, rememberFailedMedia } from '../utils/failedMediaMemory';
import {
  dropIdentityKeyMaterial,
  useIdentityMemoryReset,
  type IdentityMemoryState,
} from './resetIdentityMemoryState';

jest.mock('../services/decryptedMediaCache', () => ({
  clearDecryptedMediaMemory: jest.fn(),
  setDecryptedMediaOwner: jest.fn(),
}));
jest.mock('./nativeDmEngine', () => ({ stopNativeDmEngineGlobal: jest.fn(async () => {}) }));
jest.mock('./nostrSecretKeyCache', () => ({
  clearMemoisedSecretKey: jest.fn(),
  nip04PlaintextCache: { clear: jest.fn() },
}));

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function setup(active: string | null) {
  const state: jest.Mocked<IdentityMemoryState> = {
    setProfile: jest.fn(),
    setContacts: jest.fn(),
    setDmInbox: jest.fn(),
    setAmberNip44Permission: jest.fn(),
    resetRelayLists: jest.fn(),
  };
  const setPubkey = jest.fn();
  const { result } = renderHook(() => useIdentityMemoryReset(active, setPubkey, state));
  return { state, setPubkey, result };
}

const expectReset = (state: jest.Mocked<IdentityMemoryState>, times: number) => {
  expect(state.setProfile).toHaveBeenCalledTimes(times);
  expect(state.setContacts).toHaveBeenCalledTimes(times);
  expect(state.setDmInbox).toHaveBeenCalledTimes(times);
  expect(state.resetRelayLists).toHaveBeenCalledTimes(times);
  expect(state.setAmberNip44Permission).toHaveBeenCalledTimes(times);
};

beforeEach(() => jest.clearAllMocks());

describe('useIdentityMemoryReset', () => {
  it("adding a second account drops the active account's in-memory state before activating", () => {
    const { state, setPubkey, result } = setup(A);
    result.current.activateLoginPubkey(B);
    expectReset(state, 1);
    expect(state.setProfile).toHaveBeenCalledWith(null);
    expect(state.setContacts).toHaveBeenCalledWith([]);
    expect(state.setDmInbox).toHaveBeenCalledWith([]);
    expect(clearMemoisedSecretKey).toHaveBeenCalled();
    expect(stopNativeDmEngineGlobal).toHaveBeenCalled();
    expect(nip04PlaintextCache.clear).toHaveBeenCalled();
    expect(clearDecryptedMediaMemory).toHaveBeenCalled();
    expect(setPubkey).toHaveBeenCalledWith(B);
    // Teardown happens before the new pubkey is set.
    expect(state.setProfile.mock.invocationCallOrder[0]).toBeLessThan(
      setPubkey.mock.invocationCallOrder[0],
    );
  });

  it('does not tear anything down for a first login or a re-login of the active account', () => {
    const loggedOut = setup(null);
    loggedOut.result.current.activateLoginPubkey(A);
    expectReset(loggedOut.state, 0);
    expect(loggedOut.setPubkey).toHaveBeenCalledWith(A);

    const same = setup(A);
    same.result.current.activateLoginPubkey(A);
    expectReset(same.state, 0);
  });

  it('resetIdentityMemory clears every per-account slice', () => {
    const { state, result } = setup(A);
    result.current.resetIdentityMemory();
    expectReset(state, 1);
    expect(state.setAmberNip44Permission).toHaveBeenCalledWith('unknown');
  });
});

describe('decrypted-media owner (#1241)', () => {
  it('points the decrypted-media cache at the active account', () => {
    setup(A);
    expect(setDecryptedMediaOwner).toHaveBeenCalledWith(A);
  });
});

it.each(['switch', 'logout'])(
  'clears reaction snapshots and invalidates old writers on %s',
  (action) => {
    const { result } = setup(A);
    const token = reactionCacheGeneration();
    const key = `${A}:nip17:peer`;
    const snapshot = {
      records: [
        { id: 'reaction', reactorPubkey: B, targetEventId: 'message', emoji: '👍', createdAt: 1 },
      ],
      retractions: new Map(),
    };
    cacheConversationReactions(key, snapshot, token);
    if (action === 'switch') result.current.activateLoginPubkey(B);
    else {
      // The provider logout calls this same key-material teardown.
      dropIdentityKeyMaterial();
    }
    expect(readConversationReactions(key).records).toEqual([]);
    cacheConversationReactions(key, snapshot, token);
    expect(readConversationReactions(key).records).toEqual([]);
  },
);

it.each(['switch', 'logout'])('forgets which media URLs failed on %s', (action) => {
  const url = 'https://example.com/gone.jpg';
  rememberFailedMedia(url);
  if (action === 'switch') setup(A).result.current.activateLoginPubkey(B);
  else dropIdentityKeyMaterial();
  expect(hasFailedMedia(url)).toBe(false);
});

it.each(['switch', 'logout'])('clears canonical follows and deferred plaintext on %s', (action) => {
  const store = getFollowGateStore(A);
  store.followHydratedRef.current = true;
  store.followPubkeysRef.current = new Set([B]);
  store.followGateBufferRef.current.defer({
    partnerPubkey: B,
    entry: {
      id: 'pending',
      partnerPubkey: B,
      fromMe: false,
      createdAt: 100,
      text: 'secret',
      wireKind: 4,
    },
  });
  const replay = jest.fn();
  store.deferredReplayRef.current = replay;
  if (action === 'switch') setup(A).result.current.resetIdentityMemory();
  else dropIdentityKeyMaterial();
  expect(store.followGateBufferRef.current.size).toBe(0);
  expect(store.followPubkeysRef.current.size).toBe(0);
  expect(store.followHydratedRef.current).toBe(false);
  expect(store.deferredReplayRef.current).toBeNull();
  expect(getFollowGateStore(A)).not.toBe(store);
  expect(replay).not.toHaveBeenCalled();
});
