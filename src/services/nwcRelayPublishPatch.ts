import type { NostrWebLNProvider } from '@getalby/sdk';
import { guardPool } from './relaySocketGuard';

/**
 * Patch an NWC provider's relay pool so `publish` resolves as soon as the
 * event has been sent, instead of waiting for a NIP-20 `OK`.
 *
 * The LNbits Nostrclient relay proxy never sends `OK`
 * (https://github.com/lnbits/nostrclient/issues/52), so without this every
 * NIP-47 request would sit on the publish until the SDK's timeout — the
 * foreground connection would never pay, and the background payment poll
 * would hit its 25 s deadline on every pass and silently notify nothing.
 * Shared by `nwcService.connect` / `reconnect` and the read-only
 * `backgroundPaymentTransport`, so every provider we build gets it. Can be
 * removed once lnbits/nostrclient#68 is merged upstream.
 *
 * `onPublishError` receives the fire-and-forget rejection (relay unreachable,
 * temp-ban, rate-limit …). The foreground path feeds it into the per-wallet
 * relay-health state; the background path stays side-effect free.
 */
export function patchRelayPublish(
  provider: NostrWebLNProvider,
  onPublishError: (err: unknown) => void,
): void {
  try {
    const pool = (provider as any).client?.pool;
    if (!pool) return;
    // The SDK bundles its own nostr-tools: close the sockets it abandons too.
    guardPool(pool);
    const origEnsureRelay = pool.ensureRelay.bind(pool);
    pool.ensureRelay = async (url: string, opts?: any) => {
      const relay = await origEnsureRelay(url, opts);
      if (relay && !relay._publishPatched) {
        relay._publishPatched = true;
        const origPublish = relay.publish.bind(relay);
        relay.publish = (event: any) => {
          origPublish(event).catch(onPublishError);
          return Promise.resolve(); // resolve immediately
        };
      }
      return relay;
    };
  } catch {
    // If patching fails, continue with default behavior
  }
}
