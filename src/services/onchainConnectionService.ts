import { getBlockHeight, disconnectElectrum } from './onchainService';
import {
  getElectrumServer,
  setElectrumServer,
  DEFAULT_ELECTRUM_SERVER,
} from './walletStorageService';

export const DEFAULT_ELECTRUM_HOST_PORT = DEFAULT_ELECTRUM_SERVER.slice(0, -2);

/** Why an Electrum server could not be checked or saved — drives the user-facing copy. */
export type ElectrumSettingErrorReason = 'invalidServer' | 'unreachable';
export class ElectrumSettingError extends Error {
  constructor(
    readonly reason: ElectrumSettingErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'ElectrumSettingError';
  }
}
const SAVE_ERROR_KEYS: Record<ElectrumSettingErrorReason, string> = {
  invalidServer: 'onChainScreen.errorInvalidServer',
  unreachable: 'onChainScreen.errorUnreachable',
};
/** i18n key for a failed check/save — never the raw native/network text. */
export const electrumSaveErrorKey = (error: unknown): string =>
  error instanceof ElectrumSettingError
    ? SAVE_ERROR_KEYS[error.reason]
    : 'serverConnection.electrumSaveError';

export function electrumSetting(hostPort: string, ssl: boolean): string {
  const value = hostPort.trim() || DEFAULT_ELECTRUM_HOST_PORT;
  // Match the host:port format supported by the current BDK configuration.
  const match = /^([a-zA-Z0-9._-]+):(\d+)$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new ElectrumSettingError('invalidServer', 'Enter an Electrum hostname and port.');
  }
  return `${value}:${ssl ? 's' : 't'}`;
}

let writeQueue: Promise<unknown> = Promise.resolve();
/** Serialize every Electrum setting write/probe so an older one cannot win. */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.catch(() => undefined).then(operation);
  writeQueue = run;
  return run;
}
async function writeSetting(setting: string): Promise<void> {
  await setElectrumServer(setting);
  disconnectElectrum();
}

/** Read only the chain tip through the wallet's existing TLS-verified client.
 * That client reads the stored setting, so the draft is written for the probe
 * and the previous server is restored unless `keep` and the probe passed.
 * BDK has no abort API, so cancelled native calls may finish in the background
 * within their existing socket timeout. No wallet synchronization or new
 * detached native client is created for a check. */
async function probeElectrumDraft(
  hostPort: string,
  ssl: boolean,
  keep: boolean,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) throw new Error('Connection check cancelled.');
  const setting = electrumSetting(hostPort, ssl);
  return enqueue(async () => {
    const previous = await getElectrumServer();
    await writeSetting(setting);
    let passed = false;
    try {
      if (signal?.aborted) throw new Error('Connection check cancelled.');
      let height: number;
      try {
        height = await getBlockHeight();
      } catch (error) {
        throw new ElectrumSettingError(
          'unreachable',
          error instanceof Error ? error.message : 'Electrum server unreachable.',
        );
      }
      if (signal?.aborted) throw new Error('Connection check cancelled.');
      if (!Number.isSafeInteger(height) || height <= 0)
        throw new ElectrumSettingError('unreachable', 'Invalid Electrum chain tip.');
      passed = true;
      return height;
    } finally {
      if ((!keep || !passed) && previous !== setting) {
        try {
          await writeSetting(previous);
        } catch (error) {
          // Never leave the probe's draft client cached as if it were selected.
          disconnectElectrum();
          throw error;
        }
      }
    }
  });
}

/** "Test connection": probe the draft without selecting it. */
export function checkElectrumConnection(
  hostPort: string,
  ssl: boolean,
  signal: AbortSignal,
): Promise<number> {
  return probeElectrumDraft(hostPort, ssl, false, signal);
}

/** "Check and save": keep the draft only when its chain tip could be read. */
export async function checkAndSaveElectrumServer(hostPort: string, ssl: boolean): Promise<string> {
  await probeElectrumDraft(hostPort, ssl, true);
  return electrumSetting(hostPort, ssl);
}
