/** Cold-start wallet-owner gate in walletStorageService (#816). */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetWalletOwnerGateForTests,
  awaitActivePubkeyHydrated,
  isWalletOwnerGateOpen,
  resolveStartupWalletOwner,
  setActivePubkeyForWalletStorage,
  subscribeActivePubkey,
  type ActivePubkeyChange,
} from './walletStorageService';
import { __resetWalletOwnerHintForTests, readWalletOwnerHint } from './walletOwnerHint';

const HINT_KEY = 'wallet_owner_hint_v1';
let changes: [string | null, ActivePubkeyChange | undefined][] = [];
let unsubscribe: () => void = () => {};

beforeEach(async () => {
  setActivePubkeyForWalletStorage(null);
  __resetWalletOwnerGateForTests();
  __resetWalletOwnerHintForTests();
  await AsyncStorage.clear();
  changes = [];
  unsubscribe = subscribeActivePubkey((pk, change) => changes.push([pk, change]));
});
afterEach(() => unsubscribe());

it('stays shut for the bootstrap null publish', () => {
  setActivePubkeyForWalletStorage(null);
  expect(isWalletOwnerGateOpen()).toBe(false);
  expect(changes).toEqual([]);
});

it('opens for a logged-out outcome without notifying anyone', async () => {
  resolveStartupWalletOwner(null);
  expect(isWalletOwnerGateOpen()).toBe(true);
  await expect(awaitActivePubkeyHydrated(50)).resolves.toBeUndefined();
  expect(changes).toEqual([]);
});

it('opens on the owner publish, flagging only that change as the startup one', async () => {
  resolveStartupWalletOwner('A');
  expect(isWalletOwnerGateOpen()).toBe(false); // waits for NostrContext's publish
  const waiting = awaitActivePubkeyHydrated(10_000);
  setActivePubkeyForWalletStorage('A');
  await waiting;
  setActivePubkeyForWalletStorage('B');
  setActivePubkeyForWalletStorage(null);
  expect(changes).toEqual([
    ['A', { startup: true }],
    ['B', { startup: false }],
    [null, { startup: false }],
  ]);
});

it('keeps the first auto-login outcome', () => {
  resolveStartupWalletOwner('A');
  resolveStartupWalletOwner(null); // e.g. auto-login's `finally`
  expect(isWalletOwnerGateOpen()).toBe(false);
});

it('treats an owner landing after the timeout as an ordinary account change', async () => {
  await awaitActivePubkeyHydrated(1);
  expect(isWalletOwnerGateOpen()).toBe(false);
  setActivePubkeyForWalletStorage('A');
  expect(isWalletOwnerGateOpen()).toBe(true);
  // Startup already hydrated signed-out, so the identity hydration must run.
  expect(changes).toEqual([['A', { startup: false }]]);
});

it('remembers the real owner as the next cold start’s hint, and forgets it on logout', async () => {
  setActivePubkeyForWalletStorage('A');
  await new Promise((r) => setTimeout(r, 0));
  expect(await AsyncStorage.getItem(HINT_KEY)).toBe('A');
  setActivePubkeyForWalletStorage('B');
  await new Promise((r) => setTimeout(r, 0));
  expect(await readWalletOwnerHint()).toBe('B');
  setActivePubkeyForWalletStorage(null);
  await new Promise((r) => setTimeout(r, 0));
  expect(await AsyncStorage.getItem(HINT_KEY)).toBeNull();
});
