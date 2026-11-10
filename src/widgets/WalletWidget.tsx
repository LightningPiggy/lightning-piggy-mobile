'use no memo';
// The Android home-screen widget (#1849) in its three sizes, laid out from the
// agreed mock-ups: 2×2 balance card, 4×1 bar and 2×1 buttons. Everything shown
// comes from a `WalletWidgetModel`; see walletWidgetParts.tsx for why these
// are plain functions (no hooks).
import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { WIDGET_TYPE } from '../styles/walletWidget.styles';
import type { WalletWidgetModel } from './walletWidgetModel';
import {
  Balance,
  Chevron,
  EmptyWidget,
  PageDots,
  PillButton,
  RoundButton,
  StatusDot,
  WidgetCard,
  paletteFor,
} from './walletWidgetParts';
import { WIDGET_CLICK_NEXT } from './widgetClickActions';

export type WalletWidgetSize = 'large' | 'bar' | 'compact';

/** Widget names as registered with Android (app.config.ts → plugin). */
export const WALLET_WIDGET_NAMES: Record<WalletWidgetSize, string> = {
  large: 'WalletCardWidget',
  bar: 'WalletBarWidget',
  compact: 'WalletButtonsWidget',
};

export function walletWidgetSizeFor(widgetName: string): WalletWidgetSize | null {
  const entry = Object.entries(WALLET_WIDGET_NAMES).find(([, name]) => name === widgetName);
  return entry ? (entry[0] as WalletWidgetSize) : null;
}

/** Wallet name with its connection dot; on the bar and buttons a tap (with
 *  the › hint) steps to the next wallet. */
function NameRow({
  model,
  fontSize,
  showNextHint,
  showDot,
}: {
  model: WalletWidgetModel;
  fontSize: number;
  showNextHint: boolean;
  showDot: boolean;
}) {
  const palette = paletteFor(model);
  const tappable = showNextHint && model.canCycle;
  return (
    <FlexWidget
      {...(tappable
        ? { clickAction: WIDGET_CLICK_NEXT, accessibilityLabel: model.labels.next }
        : {})}
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      {showDot ? <StatusDot connected={model.connected} /> : null}
      <TextWidget
        text={tappable ? `${model.name} ›` : model.name}
        maxLines={1}
        truncate="END"
        style={{ fontSize, fontWeight: '700', color: palette.text }}
      />
    </FlexWidget>
  );
}

// The 2×2 card's padding; the ‹ › tap targets reach into it.
const LARGE_PADDING = { x: 13, y: 12 };

function LargeWidget({ model }: { model: WalletWidgetModel }) {
  const type = WIDGET_TYPE.large;
  const palette = paletteFor(model);
  return (
    <WidgetCard
      model={model}
      style={{
        flexDirection: 'column',
        justifyContent: 'space-between',
        paddingHorizontal: LARGE_PADDING.x,
        paddingVertical: LARGE_PADDING.y,
      }}
    >
      <FlexWidget
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          width: 'match_parent',
        }}
      >
        {model.canCycle ? (
          <Chevron
            model={model}
            direction="previous"
            fontSize={type.chevron}
            inset={LARGE_PADDING}
          />
        ) : null}
        <FlexWidget style={{ flex: 1, flexDirection: 'row', justifyContent: 'center' }}>
          <NameRow model={model} fontSize={type.name} showNextHint={false} showDot />
        </FlexWidget>
        {model.canCycle ? (
          <Chevron model={model} direction="next" fontSize={type.chevron} inset={LARGE_PADDING} />
        ) : null}
      </FlexWidget>
      <FlexWidget style={{ alignItems: 'center', width: 'match_parent' }}>
        <Balance model={model} amountSize={type.amount} unitSize={type.unit} />
        <TextWidget
          text={model.detailText ?? ''}
          maxLines={1}
          style={{ fontSize: type.detail, fontWeight: '600', color: palette.textMuted }}
        />
      </FlexWidget>
      <FlexWidget style={{ alignItems: 'center', width: 'match_parent' }}>
        <FlexWidget style={{ flexDirection: 'row', width: 'match_parent', flexGap: 6 }}>
          <PillButton
            model={model}
            action="receive"
            kind="primary"
            text={`↓ ${model.labels.receive}`}
            fontSize={type.button}
            flex={1}
          />
          <PillButton
            model={model}
            action="send"
            kind="secondary"
            text={`↑ ${model.labels.send}`}
            fontSize={type.button}
            flex={1}
          />
        </FlexWidget>
        {model.canCycle ? (
          <FlexWidget style={{ marginTop: 7 }}>
            <PageDots model={model} />
          </FlexWidget>
        ) : null}
      </FlexWidget>
    </WidgetCard>
  );
}

function BarWidget({ model }: { model: WalletWidgetModel }) {
  const type = WIDGET_TYPE.bar;
  return (
    <WidgetCard
      model={model}
      style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 10 }}
    >
      <FlexWidget style={{ flex: 1, flexDirection: 'column' }}>
        <NameRow model={model} fontSize={type.name} showNextHint showDot />
        <Balance model={model} amountSize={type.amount} unitSize={type.unit} />
        {model.canCycle ? (
          <FlexWidget style={{ marginTop: 3 }}>
            <PageDots model={model} />
          </FlexWidget>
        ) : null}
      </FlexWidget>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', flexGap: 8 }}>
        <PillButton
          model={model}
          action="receive"
          kind="primary"
          text={`↓ ${model.labels.receive}`}
          fontSize={type.button}
        />
        <RoundButton model={model} action="scan" kind="secondary" fontSize={type.button} />
        <PillButton
          model={model}
          action="send"
          kind="secondary"
          text={`↑ ${model.labels.send}`}
          fontSize={type.button}
        />
      </FlexWidget>
    </WidgetCard>
  );
}

function CompactWidget({ model }: { model: WalletWidgetModel }) {
  const type = WIDGET_TYPE.compact;
  return (
    <WidgetCard
      model={model}
      style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 9 }}
    >
      <FlexWidget style={{ flex: 1, flexDirection: 'column' }}>
        <NameRow model={model} fontSize={type.name} showNextHint showDot={false} />
        <Balance model={model} amountSize={type.amount} unitSize={type.unit} />
      </FlexWidget>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', flexGap: 6 }}>
        <RoundButton model={model} action="receive" kind="primary" fontSize={type.button} />
        <RoundButton model={model} action="send" kind="secondary" fontSize={type.button} />
      </FlexWidget>
    </WidgetCard>
  );
}

export function WalletWidget({
  model,
  size,
}: {
  model: WalletWidgetModel;
  size: WalletWidgetSize;
}) {
  if (model.empty) {
    return <EmptyWidget model={model} fontSize={size === 'large' ? 13 : 11.5} />;
  }
  if (size === 'bar') return <BarWidget model={model} />;
  if (size === 'compact') return <CompactWidget model={model} />;
  return <LargeWidget model={model} />;
}
