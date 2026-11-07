/**
 * Ark (bark) wallet: build-time feature flag and server settings.
 *
 * Experimental and signet-only. The whole feature is OFF unless the bundle
 * is built with `EXPO_PUBLIC_ENABLE_ARK=1`, so no screen, service or native
 * call changes for anyone else. See BARK_PLAN.md for the phased plan.
 *
 * Kept free of native imports so Settings can ask "is Ark on?" without
 * loading the bark native module.
 */

/** Networks this draft is allowed to open an Ark wallet on. Mainnet is deliberately absent. */
export type ArkNetwork = 'signet';

export interface ArkServerConfig {
  network: ArkNetwork;
  /** Ark server (aspd) URL. */
  arkUrl: string;
  /** Esplora used by bark for chain data (exits, boards, round confirmations). */
  esploraUrl: string;
}

/** Second's public signet Ark server — test coins only. */
export const ARK_SIGNET_SERVER: ArkServerConfig = {
  network: 'signet',
  arkUrl: 'https://ark.signet.2nd.dev',
  esploraUrl: 'https://esplora.signet.2nd.dev',
};

export const ARK_DEFAULT_SERVER: ArkServerConfig = ARK_SIGNET_SERVER;

/**
 * True when this bundle was built with the Ark experiment switched on.
 * `process.env.EXPO_PUBLIC_*` must be read with a static member access so
 * Metro can inline it at bundle time.
 */
export function isArkEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ENABLE_ARK === '1';
}
