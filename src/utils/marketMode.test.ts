import {
  DEFAULT_MARKET_MODE,
  MARKET_MODE_OPTIONS,
  effectiveMarketMode,
  isMarketModeEnabled,
  marketModeOption,
  marketModeRows,
  productsForMode,
  hasKnownSeller,
  type MarketMode,
} from './marketMode';
import { MARKET_PRODUCTS, type MarketProduct } from '../data/marketProducts';

const product = (over: Partial<MarketProduct>): MarketProduct => ({
  id: 'p',
  title: 'Thing',
  description: 'desc',
  priceSats: 1000,
  priceFiatLabel: '£1',
  image: 'https://example.com/p.png',
  sellerName: 'Robotechy',
  url: 'https://example.com',
  featured: false,
  ...over,
});

describe('market mode options', () => {
  it('exposes the four modes in order, two enabled + two disabled', () => {
    expect(MARKET_MODE_OPTIONS.map((o) => o.mode)).toEqual([
      'preferred',
      'wotFriends',
      'wotFof',
      'wotAll',
    ]);
    expect(MARKET_MODE_OPTIONS.map((o) => o.enabled)).toEqual([true, true, false, false]);
  });

  it('labels match the product spec exactly', () => {
    expect(marketModeOption('preferred').labelKey).toBe('market.modes.preferred');
    expect(marketModeOption('wotFriends').labelKey).toBe('market.modes.friends');
    expect(marketModeOption('wotFof').labelKey).toBe('market.modes.friendsOfFriends');
    expect(marketModeOption('wotAll').labelKey).toBe('market.modes.all');
  });

  it('defaults to the preferred-sellers mode (active)', () => {
    expect(DEFAULT_MARKET_MODE).toBe('preferred');
    expect(isMarketModeEnabled(DEFAULT_MARKET_MODE)).toBe(true);
  });

  it('disables both friends-of-friends and all tiers', () => {
    expect(isMarketModeEnabled('wotFof')).toBe(false);
    expect(isMarketModeEnabled('wotAll')).toBe(false);
  });
});

describe('experimental gating', () => {
  it('unlocks friends-of-friends and all only with experimental features on', () => {
    expect(isMarketModeEnabled('wotFof', true)).toBe(true);
    expect(isMarketModeEnabled('wotAll', true)).toBe(true);
    expect(isMarketModeEnabled('wotFof', false)).toBe(false);
    expect(isMarketModeEnabled('wotAll', false)).toBe(false);
    expect(isMarketModeEnabled('preferred', false)).toBe(true);
    expect(isMarketModeEnabled('wotFriends', false)).toBe(true);
  });

  it('off: friends-of-friends shows as a locked row and all is hidden', () => {
    expect(marketModeRows(false).map((r) => [r.option.mode, r.enabled])).toEqual([
      ['preferred', true],
      ['wotFriends', true],
      ['wotFof', false],
    ]);
  });

  it('on: all four rows, all selectable', () => {
    expect(marketModeRows(true).map((r) => [r.option.mode, r.enabled])).toEqual([
      ['preferred', true],
      ['wotFriends', true],
      ['wotFof', true],
      ['wotAll', true],
    ]);
  });

  it('falls back to Preferred when experimental is turned off on an experimental scope', () => {
    expect(effectiveMarketMode('wotFof', false)).toBe('preferred');
    expect(effectiveMarketMode('wotAll', false)).toBe('preferred');
    expect(effectiveMarketMode('wotFof', true)).toBe('wotFof');
    expect(effectiveMarketMode('wotAll', true)).toBe('wotAll');
    expect(effectiveMarketMode('wotFriends', false)).toBe('wotFriends');
  });
});

describe('productsForMode', () => {
  const seller = (p: MarketProduct): string | null =>
    p.sellerName === 'Robotechy' ? 'aaaa' : p.sellerName === 'Friendly' ? 'bbbb' : null;

  const items = [
    product({ id: '1', sellerName: 'Robotechy' }),
    product({ id: '2', sellerName: 'Friendly' }),
    product({ id: '3', sellerName: 'Stranger' }),
  ];

  it('preferred mode returns the whole curated catalogue', () => {
    const out = productsForMode('preferred', items, new Set(), seller);
    expect(out.map((p) => p.id)).toEqual(['1', '2', '3']);
  });

  it('wotFriends keeps only products whose seller pubkey is in the follow set', () => {
    const out = productsForMode('wotFriends', items, new Set(['bbbb']), seller);
    expect(out.map((p) => p.id)).toEqual(['2']);
  });

  it('wotFriends drops sellers with no Nostr identity', () => {
    const out = productsForMode('wotFriends', items, new Set(['aaaa', 'bbbb']), seller);
    expect(out.map((p) => p.id)).toEqual(['1', '2']);
  });

  it('relay-sourced tiers pass the input through unchanged', () => {
    const fof = productsForMode('wotFof' as MarketMode, items, new Set(), seller);
    const all = productsForMode('wotAll' as MarketMode, items, new Set(), seller);
    expect(fof.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(all.map((p) => p.id)).toEqual(['1', '2', '3']);
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    productsForMode('wotFriends', items, new Set(['bbbb']), seller);
    expect(items).toEqual(copy);
  });
});

describe('MARKET_PRODUCTS catalogue', () => {
  it('every product references a seller that exists in the vendor directory', () => {
    for (const p of MARKET_PRODUCTS) expect(hasKnownSeller(p)).toBe(true);
  });

  it('every product has a positive sats price and an absolute https url + image', () => {
    for (const p of MARKET_PRODUCTS) {
      expect(p.priceSats).toBeGreaterThan(0);
      expect(p.url).toMatch(/^https:\/\/.+/);
      expect(p.image).toMatch(/^https:\/\/.+/);
    }
  });

  it('has unique product ids', () => {
    const ids = MARKET_PRODUCTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
