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
    phone: phone ? { value: phone, href: `tel:${phone}` } : null,
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

/** Always yields an http(s) href: anything that isn't one becomes a handle on the network's host. */
export const normaliseSocialUrl = (
  network: SocialNetwork,
  value: string,
): { display: string; href: string } => {
  const trimmed = value.trim().replace(/^@/, '');
  const isUrl = /^https?:\/\//i.test(trimmed);
  const host = SOCIAL_HOSTS[network];
  const display = isUrl ? trimmed.replace(/^https?:\/\/(www\.)?/i, '') : `${host}/${trimmed}`;
  const href = isUrl ? trimmed : `https://${host}/${trimmed}`;
  return { display, href };
};
