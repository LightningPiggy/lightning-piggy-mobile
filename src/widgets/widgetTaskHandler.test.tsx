import type React from 'react';
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import type { WidgetSnapshot, WidgetWallet } from '../services/widgetSnapshot';
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings } from '../services/widgetSettings';
import { renderWalletWidget, resolveWidgetTree } from './renderWalletWidget';
import { WALLET_WIDGET_NAMES } from './WalletWidget';
import { WIDGET_CLICK_NEXT } from './widgetClickActions';
import { handleWidgetTask, type WidgetTaskDeps } from './widgetTaskHandler';

type El = React.JSX.Element & { type: { __name__?: string } };

const w = (id: string): WidgetWallet => ({
  id,
  name: `Piggy ${id}`,
  walletType: 'nwc',
  balanceSats: 1_000,
  fiatValue: 1,
  currency: 'USD',
  updatedAt: null,
  order: 0,
  connected: true,
});
const snapshot: WidgetSnapshot = { version: 1, locale: 'en', wallets: [w('a'), w('b')] };

/** Every text drawn, and whether the tree is fully made of library primitives. */
function inspect(element: El): { texts: string[]; primitivesOnly: boolean; rootClick?: string } {
  const texts: string[] = [];
  let primitivesOnly = true;
  const walk = (el: unknown) => {
    if (!el || typeof el !== 'object' || !('type' in (el as object))) return;
    const node = el as El;
    if (typeof node.type === 'function' && !node.type.__name__) primitivesOnly = false;
    const props = node.props as { text?: string; children?: unknown };
    if (typeof props.text === 'string') texts.push(props.text);
    const kids = props.children;
    (Array.isArray(kids) ? kids.flat(Infinity) : [kids]).forEach(walk);
  };
  walk(element);
  return {
    texts,
    primitivesOnly,
    rootClick: (element.props as { clickAction?: string }).clickAction,
  };
}

function props(
  widgetAction: WidgetTaskHandlerProps['widgetAction'],
  extra: Partial<WidgetTaskHandlerProps> = {},
) {
  const renderWidget = jest.fn();
  const p: WidgetTaskHandlerProps = {
    widgetInfo: {
      widgetName: WALLET_WIDGET_NAMES.large,
      widgetId: 7,
      width: 172,
      height: 172,
      screenInfo: {
        screenHeightDp: 800,
        screenWidthDp: 400,
        density: 3,
        densityDpi: 480,
        fontScale: 1,
      },
    },
    widgetAction,
    renderWidget,
    ...extra,
  };
  return { p, renderWidget };
}

function deps(overrides: Partial<WidgetTaskDeps> = {}) {
  let stored: WidgetSettings = { ...DEFAULT_WIDGET_SETTINGS, walletId: 'a' };
  return {
    readSnapshot: jest.fn(async () => snapshot),
    updateSettings: jest.fn(async (_id: number, update: (s: WidgetSettings) => WidgetSettings) => {
      stored = update(stored);
      return stored;
    }),
    deleteSettings: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('renderWalletWidget', () => {
  it('expands to library primitives only, so layout errors surface here', () => {
    const tree = renderWalletWidget('large', snapshot, DEFAULT_WIDGET_SETTINGS) as El;
    const { texts, primitivesOnly } = inspect(tree);
    expect(primitivesOnly).toBe(true);
    expect(texts).toContain('Piggy a');
    expect(resolveWidgetTree(tree)).toBeTruthy();
  });

  it('draws "Open Lightning Piggy" instead of throwing on a corrupt snapshot', () => {
    const bad = Object.defineProperty({ ...w('a') }, 'name', {
      get: () => {
        throw new Error('corrupt');
      },
    });
    const corrupt: WidgetSnapshot = { version: 1, locale: 'en', wallets: [bad] };
    const tree = renderWalletWidget('bar', corrupt, DEFAULT_WIDGET_SETTINGS) as El;
    const { texts, rootClick } = inspect(tree);
    expect(texts).toEqual(['Open Lightning Piggy']);
    expect(rootClick).toBe('OPEN_APP');
  });
});

describe('handleWidgetTask', () => {
  it('draws the stored wallet when the widget is added', async () => {
    const d = deps();
    const { p, renderWidget } = props('WIDGET_ADDED');
    await handleWidgetTask(p, d);
    expect(renderWidget).toHaveBeenCalledTimes(1);
    expect(inspect(renderWidget.mock.calls[0][0]).texts).toContain('Piggy a');
  });

  it('› steps to the next wallet in place and stores it', async () => {
    const d = deps();
    const { p, renderWidget } = props('WIDGET_CLICK', { clickAction: WIDGET_CLICK_NEXT });
    await handleWidgetTask(p, d);
    expect(inspect(renderWidget.mock.calls[0][0]).texts).toContain('Piggy b');
    expect(await (d.updateSettings as jest.Mock).mock.results[0].value).toMatchObject({
      walletId: 'b',
    });
  });

  it('forgets a deleted widget without drawing', async () => {
    const d = deps();
    const { p, renderWidget } = props('WIDGET_DELETED');
    await handleWidgetTask(p, d);
    expect(d.deleteSettings).toHaveBeenCalledWith(7);
    expect(renderWidget).not.toHaveBeenCalled();
  });

  it('draws the fallback when storage fails, never a blank widget', async () => {
    const d = deps({ readSnapshot: jest.fn(async () => Promise.reject(new Error('io'))) });
    const { p, renderWidget } = props('WIDGET_UPDATE');
    await handleWidgetTask(p, d);
    expect(inspect(renderWidget.mock.calls[0][0]).texts).toEqual(['Open Lightning Piggy']);
  });

  it('ignores widgets that aren’t ours', async () => {
    const d = deps();
    const { p, renderWidget } = props('WIDGET_ADDED');
    await handleWidgetTask({ ...p, widgetInfo: { ...p.widgetInfo, widgetName: 'Other' } }, d);
    expect(renderWidget).not.toHaveBeenCalled();
    expect(d.readSnapshot).not.toHaveBeenCalled();
  });
});
