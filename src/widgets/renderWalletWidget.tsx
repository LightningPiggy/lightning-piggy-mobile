'use no memo';
// Draw one widget from the stored snapshot + that widget's settings (#1849).
// Shared by the headless widget task, the app's refresh after a snapshot
// write, and the configuration screen.
import React from 'react';
import type { WidgetSnapshot } from '../services/widgetSnapshot';
import type { WidgetSettings } from '../services/widgetSettings';
import { buildWalletWidgetModel } from './walletWidgetModel';
import { resolveWidgetLocale, widgetTranslator } from './widgetI18n';
import { WalletWidget, type WalletWidgetSize } from './WalletWidget';

export function renderWalletWidget(
  size: WalletWidgetSize,
  snapshot: WidgetSnapshot | null,
  settings: WidgetSettings,
  now: number = Date.now(),
): React.JSX.Element {
  const { t, intlLocale } = widgetTranslator(resolveWidgetLocale(snapshot?.locale));
  const model = buildWalletWidgetModel({ snapshot, settings, now, t, intlLocale });
  return <WalletWidget model={model} size={size} />;
}
