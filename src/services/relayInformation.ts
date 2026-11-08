import { activeAccountRelays } from './testRelayRouting';
import { relayKey } from './relayHealth';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { getCurrentUserPubkey } from './nostrActiveAccount';

export interface RelayFee {
  amount: number;
  unit: string;
  period?: number;
  kinds?: number[];
}

export interface RelayInformation {
  name?: string;
  description?: string;
  contact?: string;
  pubkey?: string;
  self?: string;
  terms_of_service?: string;
  privacy_policy?: string;
  posting_policy?: string;
  payments_url?: string;
  relay_countries?: string[];
  language_tags?: string[];
  fees?: Partial<Record<'admission' | 'subscription' | 'publication', RelayFee[]>>;
  software?: string;
  version?: string;
  icon?: string;
  supported_nips?: number[];
  limitation: {
    allowed_kinds?: number[];
    payment_required?: boolean;
    auth_required?: boolean;
    restricted_writes?: boolean;
    max_subscriptions?: number;
    max_message_length?: number;
    min_pow_difficulty?: number;
  };
}

function parseKinds(value: unknown[]): number[] {
  return [
    ...new Set(
      value.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0),
    ),
  ].slice(0, 1000);
}

/** Ignore unknown or malformed fields in this optional NIP-11 document. */
export function parseRelayInformation(value: unknown): RelayInformation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid relay information');
  const raw = value as Record<string, unknown>;
  const info: RelayInformation = { limitation: {} };
  for (const key of ['name', 'description', 'contact', 'software', 'version'] as const) {
    if (typeof raw[key] === 'string') info[key] = raw[key].slice(0, 8000);
  }
  for (const key of ['pubkey', 'self'] as const) {
    if (typeof raw[key] === 'string' && /^[0-9a-f]{64}$/i.test(raw[key]))
      info[key] = raw[key].toLowerCase();
  }
  for (const key of [
    'terms_of_service',
    'privacy_policy',
    'posting_policy',
    'payments_url',
  ] as const) {
    if (typeof raw[key] === 'string' && /^https:\/\//i.test(raw[key]))
      info[key] = raw[key].slice(0, 8000);
  }
  for (const key of ['relay_countries', 'language_tags'] as const) {
    if (Array.isArray(raw[key]))
      info[key] = [
        ...new Set(
          raw[key].filter(
            (v): v is string =>
              typeof v === 'string' &&
              (key === 'relay_countries'
                ? /^[A-Z]{2}$/.test(v)
                : /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(v)),
          ),
        ),
      ].slice(0, 100);
  }
  if (raw.fees && typeof raw.fees === 'object' && !Array.isArray(raw.fees)) {
    info.fees = {};
    const fees = raw.fees as Record<string, unknown>;
    for (const key of ['admission', 'subscription', 'publication'] as const) {
      if (!Array.isArray(fees[key])) continue;
      info.fees[key] = fees[key].slice(0, 100).flatMap((entry: unknown): RelayFee[] => {
        if (!entry || typeof entry !== 'object') return [];
        const fee = entry as Record<string, unknown>;
        if (
          typeof fee.amount !== 'number' ||
          !Number.isFinite(fee.amount) ||
          fee.amount < 0 ||
          typeof fee.unit !== 'string' ||
          !fee.unit.trim()
        )
          return [];
        return [
          {
            amount: fee.amount,
            unit: fee.unit.slice(0, 32),
            ...(typeof fee.period === 'number' && Number.isSafeInteger(fee.period) && fee.period > 0
              ? { period: fee.period }
              : {}),
            ...(Array.isArray(fee.kinds) ? { kinds: parseKinds(fee.kinds) } : {}),
          },
        ];
      });
    }
  }
  if (typeof raw.icon === 'string' && /^https?:\/\//i.test(raw.icon)) info.icon = raw.icon;
  if (Array.isArray(raw.supported_nips))
    info.supported_nips = [
      ...new Set(
        raw.supported_nips.filter(
          (n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
        ),
      ),
    ].slice(0, 200);
  const limits = raw.limitation;
  if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
    const fields = limits as Record<string, unknown>;
    if (Array.isArray(fields.allowed_kinds)) {
      const kinds = parseKinds(fields.allowed_kinds);
      // An explicit empty list means no kinds; wholly malformed data is unknown.
      if (kinds.length || fields.allowed_kinds.length === 0) info.limitation.allowed_kinds = kinds;
    }
    for (const key of ['payment_required', 'auth_required', 'restricted_writes'] as const) {
      if (typeof fields[key] === 'boolean') info.limitation[key] = fields[key];
    }
    for (const key of ['max_subscriptions', 'max_message_length', 'min_pow_difficulty'] as const) {
      const n = fields[key];
      if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) info.limitation[key] = n;
    }
  }
  return info;
}

export const RELAY_INFORMATION_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 60_000;
const cache = new Map<string, { until: number; request: Promise<RelayInformation | null> }>();

/** One bounded HTTP GET, shared across screens; never opens a Nostr subscription. */
export function fetchRelayInformation(url: string): Promise<RelayInformation | null> {
  const key = relayKey(activeAccountRelays([url])[0]);
  // Defence in depth: under lockdown only the LAN test relay may be contacted.
  if (isTestRelayLockdown(getCurrentUserPubkey()) && key !== relayKey(TEST_RELAY_URL))
    return Promise.resolve(null);
  const previous = cache.get(key);
  if (previous && previous.until > Date.now()) return previous.request;
  let http: URL;
  try {
    http = new URL(key);
  } catch {
    return Promise.resolve(null);
  }
  if (http.protocol !== 'wss:' && http.protocol !== 'ws:') return Promise.resolve(null);
  http.protocol = http.protocol === 'wss:' ? 'https:' : 'http:';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const entry = { until: Infinity, request: Promise.resolve<RelayInformation | null>(null) };
  entry.request = (async () => {
    try {
      const response = await fetch(http.toString(), {
        headers: { Accept: 'application/nostr+json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Relay information unavailable');
      const info = parseRelayInformation(await response.json());
      entry.until = Date.now() + RELAY_INFORMATION_TTL_MS;
      return info;
    } catch {
      entry.until = Date.now() + FAILURE_TTL_MS;
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return entry.request;
}

export function __resetRelayInformationForTests(): void {
  cache.clear();
}
