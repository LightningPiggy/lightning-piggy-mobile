/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ArkInvalidMnemonicError,
  ArkNoWalletError,
  ArkUnavailableError,
  __resetArkForTests,
  createArkWallet,
  ensureArkDatadir,
  getArkHandle,
  getArkReceiveAddress,
  hasArkWallet,
  isArkAvailable,
  loadBark,
  normaliseMnemonic,
  readArkMnemonicForBackup,
  removeArkWallet,
  restoreArkWallet,
} from './arkService';
import { ARK_SIGNET_SERVER } from './arkConfig';

const mockSecureStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/user/0/app/files/',
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  makeDirectoryAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
}));

const bark = require('@secondts/bark-react-native');
const fs = require('expo-file-system/legacy');
const MNEMONIC_KEY = 'ark_mnemonic_signet_v1';
const PHRASE = 'abandon '.repeat(11) + 'about';

describe('arkService', () => {
  const originalFlag = process.env.EXPO_PUBLIC_ENABLE_ARK;

  beforeEach(async () => {
    mockSecureStore.clear();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    bark.__resetBarkMock();
    __resetArkForTests();
    process.env.EXPO_PUBLIC_ENABLE_ARK = '1';
  });

  afterAll(() => {
    process.env.EXPO_PUBLIC_ENABLE_ARK = originalFlag;
  });

  describe('feature flag', () => {
    it('is unavailable when the build flag is off', () => {
      process.env.EXPO_PUBLIC_ENABLE_ARK = '';
      expect(isArkAvailable()).toBe(false);
    });

    it('is available when the flag is on and the module loads', () => {
      expect(loadBark()).not.toBeNull();
      expect(isArkAvailable()).toBe(true);
    });

    it('refuses to create a wallet when the flag is off, and stores nothing', async () => {
      process.env.EXPO_PUBLIC_ENABLE_ARK = '0';
      await expect(createArkWallet()).rejects.toBeInstanceOf(ArkUnavailableError);
      expect(mockSecureStore.size).toBe(0);
      expect(bark.Wallet.open).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('stores a fresh phrase and opens on signet against the Second signet server', async () => {
      await createArkWallet();
      expect(mockSecureStore.get(MNEMONIC_KEY)).toBe(PHRASE);
      expect(await hasArkWallet()).toBe(true);
      const [network, mnemonic, config, args] = bark.Wallet.open.mock.calls[0];
      expect(network).toBe(bark.Network.Signet);
      expect(mnemonic).toBe(PHRASE);
      expect(config).toEqual({
        serverAddress: ARK_SIGNET_SERVER.arkUrl,
        esploraAddress: ARK_SIGNET_SERVER.esploraUrl,
      });
      expect(args).toMatchObject({
        datadir: '/data/user/0/app/files/ark/signet/',
        onchain: bark.__onchain,
        runDaemon: true,
        createIfNotExists: true,
        skipRecovery: true, // nothing to recover on a brand-new seed
      });
    });

    it('creates the on-chain wallet from the same phrase and datadir', async () => {
      await createArkWallet();
      expect(bark.OnchainWallet.default_).toHaveBeenCalledWith(
        bark.Network.Signet,
        PHRASE,
        expect.any(Object),
        '/data/user/0/app/files/ark/signet/',
      );
    });

    it('wipes the phrase and data when the server cannot be reached', async () => {
      bark.Wallet.open.mockRejectedValueOnce(new Error('server unreachable'));
      await expect(createArkWallet()).rejects.toThrow('server unreachable');
      expect(await hasArkWallet()).toBe(false);
      expect(fs.deleteAsync).toHaveBeenCalledWith('file:///data/user/0/app/files/ark/signet/', {
        idempotent: true,
      });
    });

    it('will not overwrite an existing wallet', async () => {
      mockSecureStore.set(MNEMONIC_KEY, 'existing phrase');
      await expect(createArkWallet()).rejects.toThrow('already exists');
      expect(mockSecureStore.get(MNEMONIC_KEY)).toBe('existing phrase');
    });
  });

  describe('restore', () => {
    it('normalises the typed phrase and runs the recovery scan', async () => {
      await restoreArkWallet(`  ${PHRASE.toUpperCase().replace(/ /g, '   ')}\n`);
      expect(mockSecureStore.get(MNEMONIC_KEY)).toBe(PHRASE);
      expect(bark.Wallet.open.mock.calls[0][3]).toMatchObject({ skipRecovery: false });
    });

    it('rejects an invalid phrase without storing it', async () => {
      await expect(restoreArkWallet('not a phrase')).rejects.toBeInstanceOf(
        ArkInvalidMnemonicError,
      );
      expect(mockSecureStore.size).toBe(0);
    });

    it('normaliseMnemonic trims, lower-cases and single-spaces', () => {
      expect(normaliseMnemonic('  Foo   BAR\nbaz ')).toBe('foo bar baz');
    });
  });

  describe('open', () => {
    it('fails with ArkNoWalletError when there is no phrase yet', async () => {
      await expect(getArkHandle()).rejects.toBeInstanceOf(ArkNoWalletError);
    });

    it('opens once for concurrent callers', async () => {
      mockSecureStore.set(MNEMONIC_KEY, PHRASE);
      const [a, b] = await Promise.all([getArkHandle(), getArkHandle()]);
      expect(a).toBe(b);
      expect(bark.Wallet.open).toHaveBeenCalledTimes(1);
    });

    it('retries after a failed open', async () => {
      mockSecureStore.set(MNEMONIC_KEY, PHRASE);
      bark.Wallet.open.mockRejectedValueOnce(new Error('offline'));
      await expect(getArkHandle()).rejects.toThrow('offline');
      await expect(getArkHandle()).resolves.toMatchObject({ wallet: bark.__wallet });
    });

    it('returns a plain filesystem path for the datadir', async () => {
      await expect(ensureArkDatadir()).resolves.toBe('/data/user/0/app/files/ark/signet/');
      expect(fs.makeDirectoryAsync).toHaveBeenCalledWith(
        'file:///data/user/0/app/files/ark/signet/',
        { intermediates: true },
      );
    });
  });

  describe('backup and remove', () => {
    it('reads the phrase for the gated backup screen', async () => {
      await createArkWallet();
      await expect(readArkMnemonicForBackup()).resolves.toBe(PHRASE);
    });

    it('stops the daemon and deletes phrase, address index and data', async () => {
      await createArkWallet();
      await getArkReceiveAddress(bark.__wallet);
      await removeArkWallet();
      expect(bark.__wallet.stopDaemonWait).toHaveBeenCalled();
      expect(await hasArkWallet()).toBe(false);
      expect(await AsyncStorage.getItem('ark_receive_index_signet_v1')).toBeNull();
      expect(fs.deleteAsync).toHaveBeenCalled();
    });
  });

  describe('receive address', () => {
    it('derives one address and keeps showing it', async () => {
      await expect(getArkReceiveAddress(bark.__wallet)).resolves.toBe('tark1fresh');
      await expect(getArkReceiveAddress(bark.__wallet)).resolves.toBe('tark1peek0');
      expect(bark.__wallet.newAddressWithIndex).toHaveBeenCalledTimes(1);
    });
  });
});
