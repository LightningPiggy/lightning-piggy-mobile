// Acknowledgements belong to an event AND a destination. A dead/parked relay
// must never be recorded as having a key just because another relay took it.
import type { NostrNetworkInterface } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent } from 'nostr-tools';
import { selectHealthyRelays } from './relayHealth';
import type { MarmotKvBackend } from './marmotStore';
import { MAX_KEY_PACKAGE_RELAYS } from './marmotKeyPackageRelays';

const canonical = (url: string) => new URL(url).href.replace(/\/+$/, '');

export async function publishWithReceipt(args: {
  network: Pick<NostrNetworkInterface, 'publish'>;
  backend: MarmotKvBackend;
  key: string;
  event: NostrEvent;
  targets: string[];
  initial?: string[];
  /** A fresh key already attempted publication through KeyPackageManager. */
  alreadyAttempted?: boolean;
  cancelled?: () => boolean;
}): Promise<boolean> {
  const { network, backend, key, event, cancelled } = args;
  const targets = [...new Set(args.targets.map(canonical))];
  const raw = await backend.get('keyPackageDiscovery', key);
  const stored = raw ? (JSON.parse(raw) as { id: string; relays: string[] }) : undefined;
  const accepted = new Set([
    ...(stored?.id === event.id ? stored.relays : []),
    ...(args.initial ?? []).map(canonical),
  ]);
  const pending = selectHealthyRelays(targets).filter((r) => !accepted.has(r));
  if (cancelled?.()) throw new Error('marmot: discovery cancelled');
  const save = () =>
    backend.set(
      'keyPackageDiscovery',
      key,
      JSON.stringify({ id: event.id, relays: [...accepted] }),
    );
  for (
    let offset = 0;
    !args.alreadyAttempted && offset < pending.length;
    offset += MAX_KEY_PACKAGE_RELAYS
  ) {
    const batch = pending.slice(offset, offset + MAX_KEY_PACKAGE_RELAYS);
    const result = await network.publish(batch, event);
    if (cancelled?.()) throw new Error('marmot: discovery cancelled');
    for (const [relay, response] of Object.entries(result)) {
      if (response.ok && batch.includes(canonical(relay))) accepted.add(canonical(relay));
    }
    await save();
    if (cancelled?.()) throw new Error('marmot: discovery cancelled');
  }
  await save();
  if (!accepted.size) throw new Error('marmot: discovery not accepted');
  return targets.every((r) => accepted.has(r));
}
