/** Cold-start identity read: registry alongside the active signer's slot only. */
import * as SecureStore from 'expo-secure-store';
import { loadIdentities, upsertIdentity } from '../services/identitiesStore';
import * as walletStorage from '../services/walletStorageService';
import { restoreNip46Session } from './useNip46Login';
import { bumpSessionGeneration, captureSessionGeneration } from '../services/sessionGeneration';
import {
  publishRestoredSession,
  readStartupLogin,
  readStoredLogin,
  registerRestoredSession,
} from './readStoredLogin';

const store = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
}));
jest.mock('../services/identitiesStore', () => ({
  loadIdentities: jest.fn(),
  upsertIdentity: jest.fn(async () => ({ identities: [], activePubkey: null })),
}));
jest.mock('../services/nostrService', () => ({
  decodeNsec: jest.fn(() => ({ pubkey: 'pk-from-nsec' })),
}));
jest.mock('./useNip46Login', () => ({
  restoreNip46Session: jest.fn(async () => 'pk-from-bunker'),
}));

const getItem = jest.mocked(SecureStore.getItemAsync);
beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  getItem.mockImplementation(async (key: string) => store.get(key) ?? null);
  jest.mocked(loadIdentities).mockResolvedValue({ identities: [], activePubkey: null });
});

const readKeys = () => getItem.mock.calls.map(([key]) => key);

it('reads the registry alongside the signer chain, not after it', async () => {
  let releaseIdentities!: () => void;
  jest
    .mocked(loadIdentities)
    .mockReturnValue(
      new Promise((r) => (releaseIdentities = () => r({ identities: [], activePubkey: null }))),
    );
  store.set('nostr_signer_type', 'amber');
  store.set('nostr_pubkey', 'pk-amber');
  const reading = readStoredLogin();
  // The registry read is still pending, yet the signer's slot was reached.
  await new Promise((r) => setTimeout(r, 0));
  expect(readKeys()).toEqual(['nostr_signer_type', 'nostr_pubkey']);
  releaseIdentities();
  await expect(reading).resolves.toMatchObject({ session: { pubkey: 'pk-amber' } });
});

it('restores an nsec session from the nsec slot only', async () => {
  store.set('nostr_signer_type', 'nsec');
  store.set('nostr_nsec', 'nsec1fixture');
  store.set('nostr_nip46_connection', '{"stale":1}');
  await expect(readStoredLogin()).resolves.toMatchObject({
    session: { pubkey: 'pk-from-nsec', signerType: 'nsec', nsec: 'nsec1fixture' },
  });
  // Another signer's secret never enters JS memory.
  expect(readKeys()).toEqual(['nostr_signer_type', 'nostr_nsec']);
});

it('restores an Amber session without touching the secret slots', async () => {
  store.set('nostr_signer_type', 'amber');
  store.set('nostr_pubkey', 'pk-amber');
  store.set('nostr_nsec', 'nsec1stale');
  await expect(readStoredLogin()).resolves.toMatchObject({
    session: { pubkey: 'pk-amber', signerType: 'amber', nsec: null },
  });
  expect(readKeys()).toEqual(['nostr_signer_type', 'nostr_pubkey']);
});

it('fails when the slot the signer needs cannot be read', async () => {
  store.set('nostr_signer_type', 'nsec');
  getItem.mockImplementation(async (key: string) => {
    if (key === 'nostr_nsec') throw new Error('keystore entry unreadable');
    return store.get(key) ?? null;
  });
  await expect(readStoredLogin()).rejects.toThrow('keystore entry unreadable');
});

it('restores NIP-46 from the connection slot it read, never the nsec slot', async () => {
  store.set('nostr_signer_type', 'nip46');
  store.set('nostr_nip46_connection', '{"conn":1}');
  store.set('nostr_nsec', 'nsec1stale');
  await expect(readStoredLogin()).resolves.toMatchObject({
    session: { pubkey: 'pk-from-bunker', signerType: 'nip46' },
  });
  expect(restoreNip46Session).toHaveBeenCalledWith('{"conn":1}', expect.any(Function));
  expect(readKeys()).toEqual(['nostr_signer_type', 'nostr_nip46_connection']);
});

it('passes a missing NIP-46 connection on as null so the restore self-heals', async () => {
  jest.mocked(restoreNip46Session).mockResolvedValueOnce(null);
  store.set('nostr_signer_type', 'nip46');
  await expect(readStoredLogin()).resolves.toMatchObject({ session: null });
  expect(restoreNip46Session).toHaveBeenCalledWith(null, expect.any(Function));
});

it('reports logged out when the signer slot is empty or its value is missing', async () => {
  await expect(readStoredLogin()).resolves.toMatchObject({ session: null });
  store.set('nostr_signer_type', 'amber');
  await expect(readStoredLogin()).resolves.toMatchObject({ session: null });
  store.set('nostr_signer_type', 'something-else');
  await expect(readStoredLogin()).resolves.toMatchObject({ session: null });
});

describe('readStartupLogin and the wallet gate', () => {
  beforeEach(() => {
    walletStorage.setActivePubkeyForWalletStorage(null);
    walletStorage.__resetWalletOwnerGateForTests();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  /** True if the wallet gate released its waiter without the 2 s fallback. */
  async function gateReleasedWithoutTimeout(): Promise<boolean> {
    let released = false;
    void walletStorage.awaitActivePubkeyHydrated().then(() => (released = true));
    await jest.advanceTimersByTimeAsync(0); // flush promises only, no timeout
    return released;
  }

  it('opens the gate signed-out right away on a logged-out cold start', async () => {
    await readStartupLogin();
    expect(await gateReleasedWithoutTimeout()).toBe(true);
  });

  it('opens the gate signed-out right away when the read fails', async () => {
    jest.mocked(loadIdentities).mockRejectedValueOnce(new Error('keystore unavailable'));
    await expect(readStartupLogin()).rejects.toThrow('keystore unavailable');
    expect(await gateReleasedWithoutTimeout()).toBe(true);
  });

  it('leaves a found account for the caller to hand over after its migration', async () => {
    store.set('nostr_signer_type', 'amber');
    store.set('nostr_pubkey', 'pk-amber');
    await readStartupLogin();
    expect(await gateReleasedWithoutTimeout()).toBe(false);
    expect(walletStorage.isWalletOwnerGateOpen()).toBe(false);
  });

  it('reports nothing to the gate when a newer login superseded the read (#1746)', async () => {
    // Superseded NIP-46 restore: no session, because it skipped its bunker.
    store.set('nostr_signer_type', 'nip46');
    store.set('nostr_nip46_connection', '{"conn":1}');
    jest.mocked(restoreNip46Session).mockResolvedValueOnce(null);
    await readStartupLogin(() => false);
    expect(walletStorage.isWalletOwnerGateOpen()).toBe(false);
    // The newer session decides the owner. Its signed-in publish opens the gate.
    walletStorage.setActivePubkeyForWalletStorage('pk-manual');
    expect(walletStorage.isWalletOwnerGateOpen()).toBe(true);
  });

  it('reports nothing to the gate when a superseded read fails', async () => {
    jest.mocked(loadIdentities).mockRejectedValueOnce(new Error('keystore unavailable'));
    await expect(readStartupLogin(() => false)).rejects.toThrow('keystore unavailable');
    expect(await gateReleasedWithoutTimeout()).toBe(false);
  });
});

describe('registerRestoredSession', () => {
  const nsecSession = { pubkey: 'pk', signerType: 'nsec' as const, nsec: 'nsec1x' };

  it('backfills a restored nsec or Amber session missing from the registry', async () => {
    await registerRestoredSession({ identities: [], session: nsecSession });
    expect(upsertIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ pubkey: 'pk', signerType: 'nsec', nsec: 'nsec1x' }),
    );
    await registerRestoredSession({
      identities: [],
      session: { pubkey: 'pk2', signerType: 'amber', nsec: null },
    });
    expect(upsertIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ pubkey: 'pk2', signerType: 'amber' }),
    );
  });

  it('writes nothing for registered, NIP-46 or absent sessions', async () => {
    const registered = [{ pubkey: 'pk', signerType: 'nsec' as const, lastUsedAt: 1 }];
    await expect(
      registerRestoredSession({ identities: registered, session: nsecSession }),
    ).resolves.toBeNull();
    await expect(
      registerRestoredSession({
        identities: [],
        session: { pubkey: 'pk', signerType: 'nip46', nsec: null },
      }),
    ).resolves.toBeNull();
    await expect(registerRestoredSession({ identities: [], session: null })).resolves.toBeNull();
    expect(upsertIdentity).not.toHaveBeenCalled();
  });
});

describe('publishRestoredSession (#1746)', () => {
  beforeEach(() => {
    walletStorage.setActivePubkeyForWalletStorage(null);
    walletStorage.__resetWalletOwnerGateForTests();
  });
  afterEach(() => walletStorage.setActivePubkeyForWalletStorage(null));

  it('publishes the restored account and opens the wallet gate for it', async () => {
    const publish = jest.fn((pk: string) => walletStorage.setActivePubkeyForWalletStorage(pk));
    await expect(
      publishRestoredSession('pk-restored', captureSessionGeneration(), publish),
    ).resolves.toBe(true);
    expect(publish).toHaveBeenCalledWith('pk-restored');
    expect(walletStorage.isWalletOwnerGateOpen()).toBe(true);
  });

  it('drops a restore superseded by a newer login, logout or switch', async () => {
    const isCurrent = captureSessionGeneration();
    // The user picked an account by hand while auto-login was still reading.
    bumpSessionGeneration();
    const publish = jest.fn();
    await expect(publishRestoredSession('pk-restored', isCurrent, publish)).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
    // The stale owner never reached the wallet gate.
    expect(walletStorage.isWalletOwnerGateOpen()).toBe(false);
    expect(walletStorage.getActivePubkey()).toBeNull();
  });
});
