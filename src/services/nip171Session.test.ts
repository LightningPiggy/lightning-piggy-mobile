import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

import { startNip171Session } from './nip171Session';

const mockSubscribeMap = jest.fn((_reqs: { url: string; filter: Record<string, unknown> }[]) => ({
  close: jest.fn(),
}));
const mockQuery = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
let mockPersisted: string[] = [];
jest.mock('./nostrService', () => ({
  pool: { subscribeMap: (reqs: never) => mockSubscribeMap(reqs) },
  trackRelays: jest.fn(),
}));
jest.mock('./relayQuery', () => ({ querySyncAbortable: (...a: unknown[]) => mockQuery(...a) }));
jest.mock('./groupMessagesStorageService', () => ({
  appendGroupMessage: jest.fn(),
  listPersistedGroupWrapIds: jest.fn(async () => mockPersisted),
}));
jest.mock('../contexts/nostrEventBus', () => ({ notifyGroupMessage: jest.fn() }));
const mockStates = new Map<string, unknown>();
let mockListener: ((owner: string) => void) | null = null;
const mockSetMeta = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('./nip171Groups', () => ({
  nip171GroupStates: () => mockStates,
  noteNip171Members: jest.fn(),
  removeNip171Members: jest.fn(),
  setNip171GroupMeta: (...a: unknown[]) => mockSetMeta(...a),
  subscribeNip171Groups: (l: (owner: string) => void) => {
    mockListener = l;
    return () => (mockListener = null);
  },
}));

const OWNER = 'a'.repeat(64);
const group = (relays?: string[]) => {
  const groupSk = generateSecretKey();
  const groupPubkey = getPublicKey(groupSk);
  const epochPubkey = getPublicKey(generateSecretKey());
  return {
    groupSk,
    state: { keys: { groupPubkey }, epochPubkey, meta: relays ? { relays } : {} },
  };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  mockStates.clear();
  mockPersisted = [];
});

it("asks a group's own relays only for that group's epoch key", async () => {
  const a = group(['wss://a-relay']);
  const b = group();
  mockStates.set(a.state.keys.groupPubkey, a.state);
  mockStates.set(b.state.keys.groupPubkey, b.state);
  const stop = startNip171Session(OWNER, ['wss://mine']);
  await flush();
  const reqs = mockSubscribeMap.mock.calls[0][0];
  const byUrl = Object.fromEntries(reqs.map((r) => [r.url, r.filter['#p']]));
  expect((byUrl['wss://mine'] as string[]).sort()).toEqual(
    [a.state.epochPubkey, b.state.epochPubkey].sort(),
  );
  expect(byUrl['wss://a-relay']).toEqual([a.state.epochPubkey]);
  // A group's profile is looked up on our relays plus its own only.
  const metaRelays = mockQuery.mock.calls.map((c) => c[1] as string[]);
  expect(metaRelays).toContainEqual(['wss://mine', 'wss://a-relay']);
  expect(metaRelays).toContainEqual(['wss://mine']);
  stop();
});

it('debounces re-subscribing when groups change in a burst', async () => {
  jest.useFakeTimers();
  try {
    const a = group();
    mockStates.set(a.state.keys.groupPubkey, a.state);
    const stop = startNip171Session(OWNER, ['wss://mine']);
    await jest.runOnlyPendingTimersAsync();
    expect(mockSubscribeMap).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      const g = group([`wss://r${i}`]);
      mockStates.set(g.state.keys.groupPubkey, g.state);
      mockListener?.(OWNER);
    }
    await jest.advanceTimersByTimeAsync(600);
    expect(mockSubscribeMap).toHaveBeenCalledTimes(2);
    stop();
  } finally {
    jest.useRealTimers();
  }
});

it('ignores a forged or oversized group profile', async () => {
  const a = group();
  mockStates.set(a.state.keys.groupPubkey, a.state);
  const forgerSk = generateSecretKey();
  const real = finalizeEvent(
    {
      kind: 0,
      created_at: 10,
      tags: [],
      content: JSON.stringify({ name: 'x'.repeat(200), picture: 'http://insecure/p.png' }),
    },
    a.groupSk,
  );
  const forged = {
    ...finalizeEvent({ kind: 0, created_at: 20, tags: [], content: '{"name":"Evil"}' }, forgerSk),
    pubkey: a.state.keys.groupPubkey,
  };
  mockQuery.mockResolvedValueOnce([real, forged]);
  const stop = startNip171Session(OWNER, ['wss://mine']);
  await flush();
  await flush();
  const meta = mockSetMeta.mock.calls[0][2] as { name?: string; picture?: string };
  expect(meta.name).toBe('x'.repeat(64));
  expect(meta.picture).toBeUndefined();
  stop();
  void bytesToHex;
});
