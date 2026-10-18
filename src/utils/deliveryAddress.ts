import { countryName, isKnownCountry, localizedCountryName } from '../data/countries';
import { MAX_ORDER_ADDRESS_LENGTH } from './marketOrder';

export interface DeliveryAddress {
  name: string;
  line1: string;
  line2: string;
  town: string;
  postcode: string;
}
export const emptyDeliveryAddress = (name = ''): DeliveryAddress => ({
  name,
  line1: '',
  line2: '',
  town: '',
  postcode: '',
});
const singleLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
export function validPostcode(value: string, country: string): boolean {
  const code = singleLine(value);
  if (!code) return false;
  switch (country) {
    case 'GB':
      return /^(GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i.test(code);
    case 'US':
      return /^\d{5}(-\d{4})?$/.test(code);
    case 'DE':
      return /^\d{5}$/.test(code);
    default:
      return true;
  }
}
/** Never truncate a structured address: block submit rather than lose delivery information. */
export function composeDeliveryAddress(fields: DeliveryAddress, country: string): string | null {
  if (
    !country ||
    !fields.name.trim() ||
    !fields.line1.trim() ||
    !fields.town.trim() ||
    !validPostcode(fields.postcode, country)
  )
    return null;
  const address = [
    ...[fields.name, fields.line1, fields.line2, fields.town, fields.postcode]
      .map(singleLine)
      .filter(Boolean),
    countryName(country),
  ].join('\n');
  return address.length <= MAX_ORDER_ADDRESS_LENGTH ? address : null;
}
/** Merchant detail can render both legacy free text and new structured tags. */
export function parseDeliveryAddress(address: string): string[] {
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Display legacy ISO country endings without changing the stored address or other lines. */
export function localizeDeliveryAddress(address: string, locale: string): string {
  const lines = address.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (last < 0) return address;
  const code = lines[last].trim();
  if (!/^[a-z]{2}$/i.test(code) || !isKnownCountry(code)) return address;
  lines[last] = lines[last].replace(code, localizedCountryName(code, locale));
  return lines.join('\n');
}
