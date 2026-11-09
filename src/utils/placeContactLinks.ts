import type { BtcMapPlace } from '../services/btcMapService';
import type { SocialNetwork } from '../components/SocialIcon';

const firstValue = (...values: (string | null | undefined)[]): string | null =>
  values.map((value) => value?.trim()).find((value) => !!value) ?? null;

// A single plain address: no whitespace, no URL / mailto header characters.
const EMAIL_RE = /^[^\s@:/?#&]+@[^\s@:/?#&]+\.[^\s@:/?#&]+$/;

/** Both curated BTC Map fields and the two OSM contact conventions are valid. */
export function placeContactLinks(place: BtcMapPlace) {
  const phone = firstValue(place.phone, place.tags['contact:phone'], place.tags.phone);
  const website = firstValue(place.tags['contact:website'], place.tags.website);
  const email = firstValue(place.email);
  // OSM also permits bare domains. Restrict website actions to web schemes.
  const href = website
    ? /^[a-z][a-z\d+.-]*:/i.test(website)
      ? website
      : `https://${website}`
    : null;
  return {
    // iOS 15/16 can't build an NSURL from a tel: href with spaces, so the
    // tap would silently do nothing. Display keeps the original formatting.
    phone: phone ? { value: phone, href: `tel:${phone.replace(/\s+/g, '')}` } : null,
    website: website && href && /^https?:\/\//i.test(href) ? { value: website, href } : null,
    email: email && EMAIL_RE.test(email) ? { value: email, href: `mailto:${email}` } : null,
  };
}

// BTC Map / OSM stores some contact:* tags as bare handles
// ("tasteofcambridgefalafels") instead of full URLs. Map each network to its
// canonical web host so the row always renders a recognisable URL.
const SOCIAL_HOSTS: Record<SocialNetwork, string> = {
  facebook: 'facebook.com',
  x: 'x.com',
  instagram: 'instagram.com',
  telegram: 't.me',
  whatsapp: 'wa.me',
};

// Full URLs are only trusted on the network's own domains (or subdomains such
// as www. / m.), so a chip labelled "Facebook" can't open an arbitrary site.
const SOCIAL_DOMAINS: Record<SocialNetwork, readonly string[]> = {
  facebook: ['facebook.com', 'fb.com'],
  x: ['x.com', 'twitter.com'],
  instagram: ['instagram.com'],
  telegram: ['t.me', 'telegram.me'],
  whatsapp: ['wa.me', 'whatsapp.com'],
};

const isNetworkUrl = (network: SocialNetwork, url: string): boolean => {
  const authority = /^https?:\/\/([^/?#\\]*)/i.exec(url)?.[1];
  // Reject userinfo (`https://facebook.com@evil.example`) outright.
  if (!authority || authority.includes('@')) return false;
  const host = authority.replace(/:\d*$/, '').toLowerCase();
  return SOCIAL_DOMAINS[network].some((d) => host === d || host.endsWith(`.${d}`));
};

/**
 * Yields an http(s) href on the network's own domain: a bare handle becomes a
 * path on the network's host, and a full URL on any other host (or a non-web
 * scheme that looks like one) is refused with `null`.
 */
export const normaliseSocialUrl = (
  network: SocialNetwork,
  value: string,
): { display: string; href: string } | null => {
  const trimmed = value.trim().replace(/^@/, '');
  if (!trimmed) return null;
  const isUrl = /^https?:\/\//i.test(trimmed);
  if (isUrl && !isNetworkUrl(network, trimmed)) return null;
  const host = SOCIAL_HOSTS[network];
  const display = isUrl ? trimmed.replace(/^https?:\/\/(www\.)?/i, '') : `${host}/${trimmed}`;
  const href = isUrl ? trimmed : `https://${host}/${trimmed}`;
  return { display, href };
};

const SOCIAL_FIELDS = {
  facebook: 'facebookUrl',
  x: 'twitterUrl',
  instagram: 'instagramUrl',
  telegram: 'telegramUrl',
  whatsapp: 'whatsappUrl',
} as const satisfies Record<SocialNetwork, keyof BtcMapPlace>;

const ALL_NETWORKS = Object.keys(SOCIAL_FIELDS) as SocialNetwork[];

/** The place's social links in display order, keeping only the safe ones. */
export function placeSocialLinks<N extends SocialNetwork = SocialNetwork>(
  place: BtcMapPlace,
  networks: readonly N[] = ALL_NETWORKS as N[],
): { network: N; display: string; href: string }[] {
  return networks.flatMap((network) => {
    const value = place[SOCIAL_FIELDS[network]];
    const link = value ? normaliseSocialUrl(network, value) : null;
    return link ? [{ network, ...link }] : [];
  });
}
