'use no memo';
// Building blocks shared by the three widget sizes (#1849). These are
// react-native-android-widget primitives, called as plain functions to build
// the native widget: no hooks, and each returns exactly one element. The
// directive above keeps the React Compiler (if it's ever enabled) away from
// them — its memo-cache hooks would break the widget build.
import React from 'react';
import {
  FlexWidget,
  SvgWidget,
  TextWidget,
  type ColorProp,
  type FlexWidgetStyle,
} from 'react-native-android-widget';
import {
  WALLET_WIDGET_PALETTES,
  WIDGET_BUTTON_HEIGHT,
  WIDGET_RADIUS,
  WIDGET_ROUND_BUTTON,
  WIDGET_STATUS_COLORS,
  type WalletWidgetPalette,
} from '../styles/walletWidget.styles';
import type { WalletWidgetModel } from './walletWidgetModel';
import { WIDGET_CLICK_NEXT, WIDGET_CLICK_PREVIOUS } from './widgetClickActions';

export function paletteFor(model: WalletWidgetModel): WalletWidgetPalette {
  return WALLET_WIDGET_PALETTES[model.style];
}

/** The widget's background card; children are laid out by `style`. */
export function WidgetCard({
  model,
  style,
  children,
}: {
  model: WalletWidgetModel;
  style: FlexWidgetStyle;
  children: React.ReactNode;
}) {
  const palette = paletteFor(model);
  return (
    <FlexWidget
      style={{
        height: 'match_parent',
        width: 'match_parent',
        borderRadius: WIDGET_RADIUS,
        ...palette.background,
        ...(palette.border ? { borderWidth: 1, borderColor: palette.border } : {}),
        ...style,
      }}
    >
      {children}
    </FlexWidget>
  );
}

/** Shown when there's no wallet to show; a tap opens the app. */
export function EmptyWidget({ model, fontSize }: { model: WalletWidgetModel; fontSize: number }) {
  const palette = paletteFor(model);
  return (
    <WidgetCard
      model={model}
      style={{ justifyContent: 'center', alignItems: 'center', padding: 12 }}
    >
      <FlexWidget
        clickAction="OPEN_APP"
        accessibilityLabel={model.emptyText}
        style={{
          height: 'match_parent',
          width: 'match_parent',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <TextWidget
          text={model.emptyText}
          maxLines={3}
          style={{ fontSize, fontWeight: '700', color: palette.text, textAlign: 'center' }}
        />
      </FlexWidget>
    </WidgetCard>
  );
}

export function StatusDot({ connected }: { connected: boolean }) {
  return (
    <FlexWidget
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        marginRight: 5,
        backgroundColor: connected ? WIDGET_STATUS_COLORS.connected : WIDGET_STATUS_COLORS.offline,
      }}
    />
  );
}

/** ‹ or › — steps to the previous / next wallet in place. */
export function Chevron({
  model,
  direction,
  fontSize,
}: {
  model: WalletWidgetModel;
  direction: 'next' | 'previous';
  fontSize: number;
}) {
  return (
    <FlexWidget
      clickAction={direction === 'next' ? WIDGET_CLICK_NEXT : WIDGET_CLICK_PREVIOUS}
      accessibilityLabel={model.labels[direction]}
      style={{ paddingHorizontal: 6, paddingVertical: 2 }}
    >
      <TextWidget
        text={direction === 'next' ? '›' : '‹'}
        allowFontScaling={false}
        style={{ fontSize, fontWeight: '700', color: paletteFor(model).chevron }}
      />
    </FlexWidget>
  );
}

/** Amount with a smaller "sats" beside it (or dots when hidden). */
export function Balance({
  model,
  amountSize,
  unitSize,
}: {
  model: WalletWidgetModel;
  amountSize: number;
  unitSize: number;
}) {
  const palette = paletteFor(model);
  return (
    <FlexWidget
      accessibilityLabel={model.balanceLabel}
      style={{ flexDirection: 'row', alignItems: 'flex-end' }}
    >
      <TextWidget
        text={model.balanceText}
        maxLines={1}
        style={{ fontSize: amountSize, fontWeight: '800', color: palette.amount }}
      />
      <TextWidget
        text={model.unitText ? ` ${model.unitText}` : ''}
        maxLines={1}
        style={{
          fontSize: unitSize,
          fontWeight: '700',
          color: palette.textMuted,
          marginBottom: 2,
        }}
      />
    </FlexWidget>
  );
}

/** One dot per wallet; the current one is a wider pill. */
export function PageDots({ model }: { model: WalletWidgetModel }) {
  const palette = paletteFor(model);
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
      {Array.from({ length: model.pageCount }, (_, i) => (
        <FlexWidget
          key={`dot-${i}`}
          style={{
            width: i === model.pageIndex ? 12 : 5,
            height: 5,
            borderRadius: 3,
            marginHorizontal: 2,
            backgroundColor: i === model.pageIndex ? palette.dotActive : palette.dotInactive,
          }}
        />
      ))}
    </FlexWidget>
  );
}

function scanIconSvg(color: ColorProp): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    'stroke-width="2.3" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 ' +
    '2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/></svg>'
  );
}

type ButtonKind = 'primary' | 'secondary';

function buttonColors(palette: WalletWidgetPalette, kind: ButtonKind) {
  if (kind === 'primary') {
    const { text, ...background } = palette.primary;
    return { background, text };
  }
  return {
    background: { backgroundColor: palette.secondary.background },
    text: palette.secondary.text,
  };
}

/** A pill button that opens the app via a widget deep link. */
export function PillButton({
  model,
  action,
  kind,
  text,
  fontSize,
  flex,
}: {
  model: WalletWidgetModel;
  action: 'receive' | 'send';
  kind: ButtonKind;
  text: string;
  fontSize: number;
  flex?: number;
}) {
  const colors = buttonColors(paletteFor(model), kind);
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: model.links[action] }}
      accessibilityLabel={model.labels[action]}
      style={{
        height: WIDGET_BUTTON_HEIGHT,
        borderRadius: WIDGET_BUTTON_HEIGHT / 2,
        paddingHorizontal: 10,
        justifyContent: 'center',
        alignItems: 'center',
        ...(flex ? { flex } : {}),
        ...colors.background,
      }}
    >
      <TextWidget
        text={text}
        maxLines={1}
        style={{ fontSize, fontWeight: '700', color: colors.text }}
      />
    </FlexWidget>
  );
}

/** A round icon button: ↓ Receive, ↑ Send, or the Scan frame. */
export function RoundButton({
  model,
  action,
  kind,
  fontSize,
}: {
  model: WalletWidgetModel;
  action: 'receive' | 'send' | 'scan';
  kind: ButtonKind;
  fontSize: number;
}) {
  const colors = buttonColors(paletteFor(model), kind);
  const glyph = action === 'receive' ? '↓' : '↑';
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: model.links[action] }}
      accessibilityLabel={model.labels[action]}
      style={{
        width: WIDGET_ROUND_BUTTON,
        height: WIDGET_ROUND_BUTTON,
        borderRadius: WIDGET_ROUND_BUTTON / 2,
        justifyContent: 'center',
        alignItems: 'center',
        ...colors.background,
      }}
    >
      {action === 'scan' ? (
        <SvgWidget svg={scanIconSvg(colors.text)} style={{ width: 15, height: 15 }} />
      ) : (
        <TextWidget
          text={glyph}
          allowFontScaling={false}
          style={{ fontSize, fontWeight: '700', color: colors.text }}
        />
      )}
    </FlexWidget>
  );
}
