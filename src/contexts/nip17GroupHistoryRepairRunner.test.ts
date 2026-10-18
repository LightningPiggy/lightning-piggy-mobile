import AsyncStorage from '@react-native-async-storage/async-storage';
import { querySyncAbortable } from '../services/relayQuery';
import { requestNip44DecryptSilent } from '../services/amberService';
import { requestNip44Decrypt } from '../services/nostrConnectService';
import { unwrapWrapNsec, unwrapWrapViaNip44 } from '../utils/nip17Unwrap';
import { getMemoisedSecretKey } from './nostrSecretKeyCache';
import { repairNip17GroupHistory } from './nip17GroupHistoryRepair';
import {
  ensureNip17GroupHistoryRepaired,
  forgetNip17GroupHistoryRepair,
} from './nip17GroupHistoryRepairRunner';

jest.mock('../services/nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('../services/relayQuery', () => ({ querySyncAbortable: jest.fn() }));
jest.mock('../services/amberService', () => ({ requestNip44DecryptSilent: jest.fn() }));
jest.mock('../services/nostrConnectService', () => ({ requestNip44Decrypt: jest.fn() }));
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: jest.fn(),
  unwrapWrapViaNip44: jest.fn(),
}));
jest.mock('./nostrSecretKeyCache', () => ({ getMemoisedSecretKey: jest.fn() }));
jest.mock('./nip17GroupHistoryRepair', () => ({
  nip17GroupHistoryRepairKey: (owner: string) => `repair_${owner}`,
  repairNip17GroupHistory: jest.fn(),
}));
const mockYield = jest.fn(async () => {});
const mockDispose = jest.fn();
jest.mock('./nostrDecryptPacing', () => ({
  NIP17_LOOP_YIELD_EVERY: 2,
  createYieldScheduler: jest.fn(() => ({ maybeYield: mockYield, dispose: mockDispose })),
}));

const OWNER = 'a'.repeat(64);
const WRAP = 'b'.repeat(64);
const RELAYS = ['wss://relay.example'];
const rumor = { pubkey: OWNER, created_at: 10, kind: 14, content: 'hello', tags: [] };
let controller: AbortController;
beforeEach(async () => {
  await forgetNip17GroupHistoryRepair(OWNER);
  jest.clearAllMocks();
  controller = new AbortController();
  jest.mocked(querySyncAbortable).mockResolvedValue([{ id: WRAP } as never]);
  jest.mocked(getMemoisedSecretKey).mockResolvedValue(new Uint8Array(32));
  jest.mocked(unwrapWrapNsec).mockReturnValue(rumor);
  jest.mocked(unwrapWrapViaNip44).mockResolvedValue(rumor);
  jest.mocked(repairNip17GroupHistory).mockImplementation(async (_owner, resolve) => {
    expect(await resolve([WRAP])).toEqual(new Map([[WRAP, rumor]]));
    return true;
  });
});

it('fetches only the requested account wraps with a limit and no randomized-time cursor, and paces decrypts', async () => {
  expect(await ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal)).toBe(
    true,
  );
  expect(querySyncAbortable).toHaveBeenCalledWith(
    {},
    RELAYS,
    { ids: [WRAP], kinds: [1059], '#p': [OWNER], limit: 1 },
    { maxWait: 8000, signal: controller.signal },
  );
  expect(unwrapWrapNsec).toHaveBeenCalledTimes(1);
  expect(mockYield).toHaveBeenCalled();
  expect(mockDispose).toHaveBeenCalled();
});

it.each(['amber', 'nip46'] as const)('uses the owner-bound %s decryptor', async (signer) => {
  await ensureNip17GroupHistoryRepaired(OWNER, signer, RELAYS, controller.signal);
  const decrypt = jest.mocked(unwrapWrapViaNip44).mock.calls[0][1];
  await decrypt('ciphertext', 'counterparty');
  expect(signer === 'amber' ? requestNip44DecryptSilent : requestNip44Decrypt).toHaveBeenCalledWith(
    'ciphertext',
    'counterparty',
    OWNER,
  );
  expect(getMemoisedSecretKey).not.toHaveBeenCalled();
});

it('single-flights in-progress runs and memoizes success', async () => {
  let finish!: (ok: boolean) => void;
  jest.mocked(repairNip17GroupHistory).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal);
  expect(ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal)).toBe(first);
  finish(true);
  await first;
  expect(await ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal)).toBe(
    true,
  );
  expect(repairNip17GroupHistory).toHaveBeenCalledTimes(1);
});

it('backs off failed runs, then retries without rejecting the live startup', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  jest.mocked(repairNip17GroupHistory).mockRejectedValueOnce(new Error('offline'));
  expect(await ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal)).toBe(
    false,
  );
  expect(await ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal)).toBe(
    false,
  );
  expect(repairNip17GroupHistory).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(160_001);
  expect(await ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal)).toBe(
    true,
  );
  clock.mockRestore();
});

it('stops decrypting on account cancellation and disposes the pacing scheduler', async () => {
  jest.mocked(querySyncAbortable).mockImplementationOnce(async () => {
    controller.abort();
    return [{ id: WRAP } as never];
  });
  jest.mocked(repairNip17GroupHistory).mockImplementationOnce(async (_owner, resolve, aborted) => {
    expect(await resolve([WRAP])).toEqual(new Map());
    expect(aborted?.()).toBe(true);
    return false;
  });
  expect(await ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal)).toBe(
    false,
  );
  expect(unwrapWrapNsec).not.toHaveBeenCalled();
  expect(mockDispose).toHaveBeenCalled();
});

it('waits for in-flight writes before clearing the per-account flag on logout', async () => {
  let finish!: (ok: boolean) => void;
  jest.mocked(repairNip17GroupHistory).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const run = ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal);
  await AsyncStorage.setItem(`repair_${OWNER}`, '1');
  const wipe = forgetNip17GroupHistoryRepair(OWNER);
  expect(await AsyncStorage.getItem(`repair_${OWNER}`)).toBe('1');
  finish(true);
  await run;
  await wipe;
  expect(await AsyncStorage.getItem(`repair_${OWNER}`)).toBeNull();
  await ensureNip17GroupHistoryRepaired(OWNER, 'nsec', RELAYS, controller.signal);
  expect(repairNip17GroupHistory).toHaveBeenCalledTimes(2);
});
