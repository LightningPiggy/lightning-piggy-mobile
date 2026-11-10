'use no memo';
// Draw one widget from the stored snapshot + that widget's settings (#1849).
// Shared by the headless widget task, the app's refresh after a snapshot
// write, and the configuration screen. Never throws: anything that goes wrong
// draws the "Open Lightning Piggy" fallback instead of leaving a blank tile.
import React from 'react';
import type { WidgetSnapshot } from '../services/widgetSnapshot';
import type { WidgetSettings } from '../services/widgetSettings';
import { buildWalletWidgetModel } from './walletWidgetModel';
import { resolveWidgetLocale, widgetTranslator } from './widgetI18n';
import { WalletWidget, type WalletWidgetSize } from './WalletWidget';
import { FallbackWidget } from './walletWidgetParts';

type Element = React.JSX.Element;
type WidgetComponent = ((props: unknown) => Element) & { __name__?: string };

/**
 * Expand our own layout components into the library's primitives now, the way
 * react-native-android-widget does later when it builds the native tree, so a
 * layout error throws here — where it can be caught — rather than inside the
 * library after the render callback has returned.
 */
export function resolveWidgetTree(element: Element): Element {
  let el = element;
  while (typeof el.type === 'function' && !(el.type as WidgetComponent).__name__) {
    el = (el.type as WidgetComponent)(el.props);
  }
  const { children } = (el.props ?? {}) as { children?: unknown };
  if (children === undefined || children === null) return el;
  const list = (Array.isArray(children) ? children : [children]).flat(Infinity);
  const resolved = list.map((child) =>
    child && typeof child === 'object' && 'type' in (child as object)
      ? resolveWidgetTree(child as Element)
      : child,
  );
  return React.cloneElement(el, undefined, ...resolved);
}

export function renderFallbackWidget(locale?: string | null): Element {
  let text = 'Open Lightning Piggy';
  try {
    text = widgetTranslator(resolveWidgetLocale(locale)).t('widget.openApp');
  } catch {
    // Keep the English text.
  }
  return resolveWidgetTree(<FallbackWidget text={text} />);
}

export function renderWalletWidget(
  size: WalletWidgetSize,
  snapshot: WidgetSnapshot | null,
  settings: WidgetSettings,
  now: number = Date.now(),
): Element {
  try {
    const { t, intlLocale } = widgetTranslator(resolveWidgetLocale(snapshot?.locale));
    const model = buildWalletWidgetModel({ snapshot, settings, now, t, intlLocale });
    return resolveWidgetTree(<WalletWidget model={model} size={size} />);
  } catch (e) {
    if (__DEV__) console.warn('[widget] render failed, drawing the fallback:', e);
    return renderFallbackWidget(snapshot?.locale);
  }
}
