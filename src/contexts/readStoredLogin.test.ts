/** Cold-start identity read: one concurrent SecureStore round, per signer. */
import * as SecureStore from 'expo-secure-store';
import { loadIdentities, upsertIdentity } from '../services/identitiesStore';
import { restoreNip46Session } from './useNip46Login';
import { readStoredLogin, registerRestoredSession } from './readStoredLogin';

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

it('issues every slot read before any of them resolves', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  getItem.mockImplementation(async (key: string) => {
    await gate;
    return store.get(key) ?? null;
  });
  const reading = readStoredLogin();
  await Promise.resolve();
  expect(getItem.mock.calls.map(([key]) => key).sort()).toEqual([
    'nostr_nip46_connection',
    'nostr_nsec',
    'nostr_pubkey',
    'nostr_signer_type',
  ]);
  expect(loadIdentities).toHaveBeenCalledTimes(1);
  release();
  await expect(reading).resolves.toEqual({ identities: [], session: null });
});

it('restores an nsec session from the nsec slot', async () => {
  store.set('nostr_signer_type', 'nsec');
  store.set('nostr_nsec', 'nsec1fixture');
  await expect(readStoredLogin()).resolves.toMatchObject({
    session: { pubkey: 'pk-from-nsec', signerType: 'nsec', nsec: 'nsec1fixture' },
  });
});

it('restores an Amber session, ignoring a failed read of an unused slot', async () => {
  store.set('nostr_signer_type', 'amber');
  store.set('nostr_pubkey', 'pk-amber');
  getItem.mockImplementation(async (key: string) => {
    if (key === 'nostr_nsec') throw new Error('keystore entry unreadable');
    return store.get(key) ?? null;
  });
  await expect(readStoredLogin()).resolves.toMatchObject({
    session: { pubkey: 'pk-amber', signerType: 'amber', nsec: null },
  });
});

it('fails when the slot the signer needs cannot be read', async () => {
  store.set('nostr_signer_type', 'nsec');
  getItem.mockImplementation(async (key: string) => {
    if (key === 'nostr_nsec') throw new Error('keystore entry unreadable');
    return store.get(key) ?? null;
  });
  await expect(readStoredLogin()).rejects.toThrow('keystore entry unreadable');
});

it('restores NIP-46 from the connection read in the same round', async () => {
  store.set('nostr_signer_type', 'nip46');
  store.set('nostr_nip46_connection', '{"conn":1}');
  await expect(readStoredLogin()).resolves.toMatchObject({
    session: { pubkey: 'pk-from-bunker', signerType: 'nip46' },
  });
  expect(restoreNip46Session).toHaveBeenCalledWith('{"conn":1}');
});

it('reports logged out when the signer slot is empty or its value is missing', async () => {
  await expect(readStoredLogin()).resolves.toMatchObject({ session: null });
  store.set('nostr_signer_type', 'amber');
  await expect(readStoredLogin()).resolves.toMatchObject({ session: null });
  jest.mocked(restoreNip46Session).mockResolvedValueOnce(null);
  store.set('nostr_signer_type', 'nip46');
  await expect(readStoredLogin()).resolves.toMatchObject({ session: null });
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
