import { parseBoltzPair } from './boltzPair';
import { t } from '../i18n';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { BOLTZ_API, fetchWithTimeout } from './boltzApi';

// New swaps require an explicit provider. Historical, unpinned swaps remain
// associated with Boltz so recovery never silently moves to a different server.
export const DEFAULT_SWAP_BACKEND = '';
export const LEGACY_SWAP_BACKEND = BOLTZ_API;

export class NoSwapServerError extends Error {
  constructor() {
    super(t('swapBackend.notConfigured'));
    this.name = 'NoSwapServerError';
  }
}
export const isNoSwapServerError = (error: unknown): error is NoSwapServerError =>
  error instanceof Error && error.name === 'NoSwapServerError';
/** i18n key for a failed fee quote — never the raw server/network text. */
export const swapQuoteErrorKey = (error: unknown): string =>
  isNoSwapServerError(error) ? 'swapBackend.notConfigured' : 'swapBackend.quoteFailed';

/** Why a swap server could not be checked or saved — drives the user-facing copy. */
export type SwapBackendErrorReason = 'invalidUrl' | 'unreachable' | 'noSwaps' | 'incompatible';
export class SwapBackendError extends Error {
  constructor(
    readonly reason: SwapBackendErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'SwapBackendError';
  }
}
const SAVE_ERROR_KEYS: Record<SwapBackendErrorReason, string> = {
  invalidUrl: 'swapBackend.errorInvalidUrl',
  unreachable: 'swapBackend.errorUnreachable',
  noSwaps: 'swapBackend.errorNoSwaps',
  incompatible: 'swapBackend.errorIncompatible',
};
/** i18n key for a failed check/save — never the raw server/network text. */
export const swapBackendSaveErrorKey = (error: unknown): string =>
  error instanceof SwapBackendError ? SAVE_ERROR_KEYS[error.reason] : 'swapBackend.saveError';
const SETTING_KEY = 'swap_backend_url_v1';

/** Accept an HTTPS origin or API base, including reverse-proxy path prefixes. */
export function normalizeSwapBackend(input: string): string {
  const value = input.trim();
  if (!/^https:\/\//i.test(value) || /[\\\s?#]/.test(value)) {
    throw new SwapBackendError(
      'invalidUrl',
      'Enter an HTTPS server URL without a query or fragment.',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SwapBackendError('invalidUrl', 'Enter a valid HTTPS server URL.');
  }
  if (!url.hostname || url.username || url.password) {
    throw new SwapBackendError('invalidUrl', 'The server URL must not contain credentials.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(v\d+|ws)$/.test(path) && !path.endsWith('/v2')) {
    throw new SwapBackendError('invalidUrl', 'Enter the server URL or its v2 API base.');
  }
  return `${url.origin}${path.endsWith('/v2') ? path : `${path}/v2`}`;
}

/** Storage failures must not silently switch a private user back to a public server. */
export async function getSwapBackend(): Promise<string> {
  const saved = await AsyncStorage.getItem(SETTING_KEY);
  return saved === null || saved.trim() === '' ? DEFAULT_SWAP_BACKEND : normalizeSwapBackend(saved);
}

/** Fail before any HTTP request or new swap when no provider was selected. */
export async function requireSwapBackend(): Promise<string> {
  const backend = await getSwapBackend();
  if (!backend) throw new NoSwapServerError();
  return backend;
}

/** Check both supported BTC swap directions without creating a swap. */
export async function checkSwapBackend(input: string, signal?: AbortSignal): Promise<string> {
  const backend = normalizeSwapBackend(input);
  await Promise.all(
    (['reverse', 'submarine'] as const).map(async (direction) => {
      try {
        await fetchWithTimeout(
          `${backend}/swap/${direction}`,
          signal ? { signal } : undefined,
          10000,
          async (response) => {
            if (!response.ok)
              throw new SwapBackendError(
                'unreachable',
                `Swap server check failed (HTTP ${response.status}).`,
              );
            let pairs: { BTC?: { BTC?: unknown } } | null;
            try {
              pairs = await response.json();
            } catch {
              throw new SwapBackendError('incompatible', 'Swap server returned invalid JSON.');
            }
            const pair = pairs?.BTC?.BTC;
            // A reachable server answering `{}` simply has no BTC pair on offer.
            if (!pair || typeof pair !== 'object' || Object.keys(pair).length === 0)
              throw new SwapBackendError('noSwaps', `Swap server offers no BTC ${direction} pair.`);
            try {
              parseBoltzPair(pair, direction);
            } catch (error) {
              throw new SwapBackendError(
                'incompatible',
                error instanceof Error ? error.message : 'Invalid swap quote.',
              );
            }
          },
        );
      } catch (error) {
        if (error instanceof SwapBackendError) throw error;
        // fetch rejections: offline, DNS, TLS, timeout abort.
        throw new SwapBackendError(
          'unreachable',
          error instanceof Error ? error.message : 'Swap server unreachable.',
        );
      }
    }),
  );
  if (signal?.aborted) throw new Error('Connection check cancelled.');
  return backend;
}

/** Checking a draft must not select it as the provider for new swaps. */
export async function checkAndSaveSwapBackend(input: string): Promise<string> {
  if (!input.trim()) {
    await AsyncStorage.removeItem(SETTING_KEY);
    return DEFAULT_SWAP_BACKEND;
  }
  const backend = await checkSwapBackend(input);
  await AsyncStorage.setItem(SETTING_KEY, backend);
  return backend;
}

function backendKey(swapId: string): string {
  if (typeof swapId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(swapId))
    throw new Error('Invalid swap ID.');
  return `boltz_backend_${swapId}`;
}

// Retain these small records after completion so transaction history can still
// query its original provider. Never consult the current setting for an old ID.
export async function getSwapBackendForId(swapId: string): Promise<string> {
  const saved = await SecureStore.getItemAsync(backendKey(swapId));
  return saved === null || saved === undefined ? LEGACY_SWAP_BACKEND : normalizeSwapBackend(saved);
}

let pinQueue: Promise<void> = Promise.resolve();
/** Persist before returning a newly created swap to any caller that can fund it. */
export function pinSwapBackend(swapId: string, backend: string): Promise<void> {
  const operation = pinQueue
    .catch(() => undefined)
    .then(async () => {
      const key = backendKey(swapId);
      const normalized = normalizeSwapBackend(backend);
      const [existing, reverse, submarine] = await Promise.all([
        SecureStore.getItemAsync(key),
        SecureStore.getItemAsync(`boltz_swap_${swapId}`),
        SecureStore.getItemAsync(`submarine_swap_${swapId}`),
      ]);
      // Refuse reused IDs before a caller can overwrite another swap's secrets.
      if (existing || reverse || submarine)
        throw new Error('Swap server returned a reused swap ID.');
      await SecureStore.setItemAsync(key, normalized, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    });
  pinQueue = operation;
  return operation;
}

export function swapWebSocketUrl(backend: string): string {
  return `${normalizeSwapBackend(backend).replace(/^https:/, 'wss:')}/ws`;
}
