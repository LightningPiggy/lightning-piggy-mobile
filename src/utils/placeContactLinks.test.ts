import { normaliseSocialUrl, placeContactLinks } from './placeContactLinks';
import type { BtcMapPlace } from '../services/btcMapService';

const place = (tags: Record<string, string>, phone?: string, email?: string): BtcMapPlace => ({
  id: 42,
  lat: 0,
  lon: 0,
  tags,
  verified_at: null,
  phone,
  email,
});

it.each(['phone', 'contact:phone'])('reads %s and provides a tel link', (key) => {
  expect(placeContactLinks(place({ [key]: ' +44 1234 ' })).phone).toEqual({
    value: '+44 1234',
    href: 'tel:+44 1234',
  });
});
it.each(['website', 'contact:website'])('reads %s and normalises bare domains', (key) => {
  expect(placeContactLinks(place({ [key]: ' example.com ' })).website).toEqual({
    value: 'example.com',
    href: 'https://example.com',
  });
});
it('prefers curated phone and contact website, preserving web schemes', () => {
  expect(
    placeContactLinks(
      place(
        { phone: '1', 'contact:phone': '2', website: 'a.com', 'contact:website': 'http://b.com' },
        '3',
      ),
    ),
  ).toEqual({
    phone: { value: '3', href: 'tel:3' },
    website: { value: 'http://b.com', href: 'http://b.com' },
    email: null,
  });
});
it('hides absent, blank and non-web website values', () => {
  expect(placeContactLinks(place({ phone: ' ', website: ' ' }))).toEqual({
    phone: null,
    website: null,
    email: null,
  });
  expect(placeContactLinks(place({ website: 'javascript:alert(1)' })).website).toBeNull();
});
it.each(['lightning:lnurl1abc', 'bitcoin:bc1qxyz', 'tel:+441234', 'intent://evil#Intent;end'])(
  'refuses non-web website scheme %s',
  (website) => {
    expect(placeContactLinks(place({ 'contact:website': website })).website).toBeNull();
  },
);
it('builds a mailto link only from a plain email address', () => {
  expect(placeContactLinks(place({}, undefined, ' shop@example.com ')).email).toEqual({
    value: 'shop@example.com',
    href: 'mailto:shop@example.com',
  });
  for (const bad of ['not-an-email', 'a@b.com?body=x', 'lightning:x@y.z', 'a b@c.com']) {
    expect(placeContactLinks(place({}, undefined, bad)).email).toBeNull();
  }
});
describe('normaliseSocialUrl', () => {
  it('keeps http(s) URLs and expands bare handles onto the network host', () => {
    expect(normaliseSocialUrl('facebook', 'https://www.facebook.com/shop').href).toBe(
      'https://www.facebook.com/shop',
    );
    expect(normaliseSocialUrl('instagram', '@shop')).toEqual({
      display: 'instagram.com/shop',
      href: 'https://instagram.com/shop',
    });
  });
  it.each(['lightning:lnurl1abc', 'bitcoin:bc1qxyz', 'tel:+441234', 'javascript:alert(1)'])(
    'never yields a non-web href for %s',
    (value) => {
      expect(normaliseSocialUrl('x', value).href).toMatch(/^https:\/\/x\.com\//);
    },
  );
});
