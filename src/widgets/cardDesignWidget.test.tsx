import type React from 'react';
import type { CardTheme } from '../types/wallet';
import type { WidgetSnapshot, WidgetWallet } from '../services/widgetSnapshot';
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings } from '../services/widgetSettings';
import { WALLET_WIDGET_PALETTES, cardDesignPalette } from '../styles/walletWidget.styles';
import { cardThemes } from '../themes/cardThemes';
import { renderWalletWidget } from './renderWalletWidget';
import { buildWalletWidgetModel } from './walletWidgetModel';
import { paletteFor } from './walletWidgetParts';
import { widgetTranslator } from './widgetI18n';

type El = React.JSX.Element & { type: { __name__?: string } };

const w = (id: string, cardTheme: CardTheme | null): WidgetWallet => ({
  id,
  name: `Piggy ${id}`,
  walletType: 'nwc',
  balanceSats: 92_369,
  fiatValue: 77.39,
  currency: 'USD',
  updatedAt: null,
  order: 0,
  connected: true,
  cardTheme,
});

const snapshotOf = (...wallets: WidgetWallet[]): WidgetSnapshot => ({
  version: 1,
  locale: 'en',
  wallets,
});

function nodes(element: El): El[] {
  const found: El[] = [];
  const walk = (el: unknown) => {
    if (!el || typeof el !== 'object' || !('type' in (el as object))) return;
    const node = el as El;
    found.push(node);
    const kids = (node.props as { children?: unknown }).children;
    (Array.isArray(kids) ? kids.flat(Infinity) : [kids]).forEach(walk);
  };
  walk(element);
  return found;
}

const named = (tree: El, name: string) => nodes(tree).filter((n) => n.type.__name__ === name);

function model(snapshot: WidgetSnapshot, settings: Partial<WidgetSettings> = {}) {
  const { t, intlLocale } = widgetTranslator('en');
  return buildWalletWidgetModel({
    snapshot,
    settings: { ...DEFAULT_WIDGET_SETTINGS, ...settings },
    now: 0,
    t,
    intlLocale,
  });
}

describe('"Same as in the app" style', () => {
  it("follows the shown wallet's card design", () => {
    const m = model(snapshotOf(w('a', 'wise-owl')));
    expect(paletteFor(m)).toEqual(cardDesignPalette(cardThemes['wise-owl']));
  });

  it('looks like Piggy pink when the wallet has no known design', () => {
    expect(paletteFor(model(snapshotOf(w('a', null))))).toEqual(WALLET_WIDGET_PALETTES.piggyPink);
  });

  it('keeps a fixed style fixed, whatever the wallet', () => {
    const m = model(snapshotOf(w('a', 'wise-owl')), { style: 'nightGlass' });
    expect(paletteFor(m)).toEqual(WALLET_WIDGET_PALETTES.nightGlass);
  });

  it("draws the card's artwork behind the content", () => {
    const tree = renderWalletWidget('large', snapshotOf(w('a', 'lightning-piggy')), {
      ...DEFAULT_WIDGET_SETTINGS,
    }) as El;
    expect(named(tree, 'ImageWidget')).toHaveLength(1);
    // OverlapWidget registers itself under the native name FrameLayoutWidget.
    expect(named(tree, 'FrameLayoutWidget').length).toBeGreaterThan(0);
  });

  it('draws no artwork for a fixed style', () => {
    const tree = renderWalletWidget('large', snapshotOf(w('a', 'lightning-piggy')), {
      ...DEFAULT_WIDGET_SETTINGS,
      style: 'piggyPink',
    }) as El;
    expect(named(tree, 'ImageWidget')).toHaveLength(0);
  });

  it('uses dark buttons on a card with dark text', () => {
    const palette = cardDesignPalette({
      gradientColors: ['#FFFFFF', '#EEEEEE'],
      textColor: '#000000',
    });
    expect(palette.primary.backgroundColor).toBe('#1D1B26');
    expect(palette.textMuted).toBe('rgba(0, 0, 0, 0.8)');
  });
});

describe('2×2 card at small sizes', () => {
  const two = snapshotOf(w('a', null), w('b', null));

  it('drops the page dots when short, so both buttons fit', () => {
    const roomy = renderWalletWidget('large', two, DEFAULT_WIDGET_SETTINGS, {
      width: 180,
      height: 190,
    }) as El;
    const short = renderWalletWidget('large', two, DEFAULT_WIDGET_SETTINGS, {
      width: 180,
      height: 140,
    }) as El;
    const texts = (tree: El) => nodes(tree).map((n) => (n.props as { text?: string }).text);
    expect(nodes(short).length).toBeLessThan(nodes(roomy).length);
    expect(texts(short)).toEqual(expect.arrayContaining(['↓ Receive', '↑ Send']));
  });

  it('shrinks the amount when narrow, so "sats" still fits', () => {
    const sizeOf = (frame: { width: number; height: number }) => {
      const tree = renderWalletWidget('large', two, DEFAULT_WIDGET_SETTINGS, frame) as El;
      const amount = nodes(tree).find(
        (n) => (n.props as { text?: string }).text === (92_369).toLocaleString('en'),
      );
      return (amount?.props as { style: { fontSize: number } }).style.fontSize;
    };
    expect(sizeOf({ width: 140, height: 190 })).toBeLessThan(sizeOf({ width: 190, height: 190 }));
  });
});
