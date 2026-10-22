import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Check, CheckCheck, Clock, AlertCircle, ShieldCheck } from 'lucide-react-native';
import { summariseDelivery, type DeliveryStatus } from '../utils/dmDeliveryStatus';
import { formatTime } from '../utils/messageContent';
import { useTranslation } from '../contexts/LocaleContext';
import type { MessageBubbleStyles } from '../styles/MessageBubble.styles';

type Styles = MessageBubbleStyles;

/**
 * Delivery indicator for a sent DM (#856, design approved 2026-06-12).
 * WhatsApp-style single/double coverage in the delivered-tick colour
 * (`styles.deliveryTickDelivered` — currently white for contrast on the sent
 * bubble; theme-driven, so don't assume a literal colour here):
 *   - pending (no relay acked yet) → faint Clock
 *   - delivered to ≥1 but not all target relays → single Check
 *   - delivered to ALL target relays → double CheckCheck
 *   - failed (every relay rejected) → red AlertCircle
 * Single→double is computed from the per-relay `relayResults`; the exact
 * "Sent to N of M relays" breakdown lives behind a long-press (recipient relay
 * lists run to 11, so one glyph per relay would be noise). Retry/outbox for the
 * failed state is #857 — this only renders the distinct visual.
 */
const DeliveryTick: React.FC<{
  styles: Styles;
  status: DeliveryStatus;
  testID: string;
  tint?: string;
}> = ({ styles, status, testID, tint }) => {
  const t = useTranslation();
  const { ok, total } = summariseDelivery(status);
  // Wrap the lucide SVG in a View so the testID + accessibilityLabel land on a
  // node Maestro can resolve — testIDs on lucide-react-native icons don't
  // reliably surface in the accessibility tree.

  // Still in flight — the optimistic bubble before any relay has settled (#857).
  // Keyed off the explicit `pending` flag, not `total === 0`, so a settled
  // all-failed send (zero relays accepted) renders the red glyph below instead.
  if (status.pending) {
    return (
      <View testID={testID} accessibilityLabel={t('messageBubbleFooter.messageSending')}>
        <Clock
          size={12}
          color={tint ?? (StyleSheet.flatten(styles.deliveryTickPending).color as string)}
        />
      </View>
    );
  }

  // No relay accepted (every relay rejected, or a hard pre-publish error) →
  // failed. The bubble's tap opens the info sheet with a Re-publish action.
  if (status.sendFailed || ok === 0) {
    return (
      <View testID={testID} accessibilityLabel={t('messageBubbleFooter.sendFailed')}>
        <AlertCircle
          size={13}
          color={StyleSheet.flatten(styles.deliveryTickFailed).color as string}
        />
      </View>
    );
  }

  // Theme-driven delivered-tick colour (white today, may change by theme) — not
  // necessarily green, so name it semantically rather than by hue.
  const deliveredColor = tint ?? (StyleSheet.flatten(styles.deliveryTickDelivered).color as string);
  // All target relays acked → double tick; otherwise ≥1 → single tick.
  if (ok === total) {
    return (
      <View testID={testID} accessibilityLabel={t('messageBubbleFooter.sentAllRelays')}>
        <CheckCheck size={14} strokeWidth={2.5} color={deliveredColor} />
      </View>
    );
  }
  return (
    <View
      testID={testID}
      accessibilityLabel={t('messageBubbleFooter.sentSomeRelays', { ok, total })}
    >
      <Check size={13} strokeWidth={2.5} color={deliveredColor} />
    </View>
  );
};

/**
 * Shared time-row footer for every bubble variant (#856). Renders the
 * timestamp and, on a sent (`fromMe`) bubble that carries a tracked
 * `deliveryStatus`, the delivery tick beside it — long-pressable to open the
 * per-relay breakdown. Received bubbles and untracked sends fall back to the
 * bare timestamp, so this is a drop-in for each variant's old `<Text>` time.
 *
 * `timeStyle` is the variant's existing time text style (e.g. `gifTime`,
 * `imageBubbleTime`, `bubbleTime`) so each card keeps its own ink/placement;
 * only the tick is appended.
 */
export const BubbleFooter: React.FC<{
  styles: Styles;
  // Per-message id so the footer/tick testIDs are unique within a thread that
  // has many bubbles (Copilot #858) — Maestro can still match the bare prefix.
  messageId: string;
  fromMe: boolean;
  createdAt: number;
  timeStyle: object | (object | undefined)[];
  deliveryStatus?: DeliveryStatus;
  // Opens the message-info sheet (tap or long-press) for sent AND received.
  onOpenInfo?: () => void;
  // Tint for the info-affordance shield (#856 discoverability). White on a
  // coloured (sent) bubble, supplementary grey on a surface (received) one — so
  // it reads on either background.
  infoTint: string;
  deliveryTint?: string;
  // Marmot edit: prefix the time with an "Edited" mark.
  edited?: boolean;
}> = ({
  styles,
  messageId,
  fromMe,
  createdAt,
  timeStyle,
  deliveryStatus,
  onOpenInfo,
  infoTint,
  deliveryTint,
  edited,
}) => {
  const t = useTranslation();
  const time = edited
    ? `${t('messageBubbleFooter.edited')} · ${formatTime(createdAt)}`
    : formatTime(createdAt);
  const showTick = fromMe && !!deliveryStatus;
  // No info handler and no tick → plain timestamp (e.g. a legacy row).
  if (!onOpenInfo && !showTick) {
    return <Text style={timeStyle}>{time}</Text>;
  }
  return (
    <TouchableOpacity
      style={styles.bubbleFooterRow}
      activeOpacity={onOpenInfo ? 0.6 : 1}
      // Tap AND long-press both open the info sheet — tap is discoverable and
      // reachable by screen readers (long-press alone isn't). (Copilot #858)
      onPress={onOpenInfo}
      onLongPress={onOpenInfo}
      // When there's no info handler (tick-only footer) the row is inert — mark
      // it disabled and drop the button semantics so screen readers don't
      // announce a focusable control that does nothing (Copilot).
      disabled={!onOpenInfo}
      accessibilityRole={onOpenInfo ? 'button' : undefined}
      accessibilityLabel={
        onOpenInfo
          ? fromMe
            ? t('messageBubbleFooter.deliveryStatus')
            : t('messageBubbleFooter.messageInfo')
          : undefined
      }
      accessibilityHint={onOpenInfo ? t('messageBubbleFooter.opensMessageDetails') : undefined}
      testID={`dm-bubble-delivery-footer-${messageId}`}
    >
      {/* A small shield next to the time signals the bubble is tappable for
          encryption + delivery details — previously only the bare time showed,
          so the affordance wasn't discoverable (#856 follow-up). Rendered for
          any bubble that has an info handler, on both sent + received. */}
      {onOpenInfo ? (
        <View
          testID={`dm-bubble-info-icon-${messageId}`}
          // Decorative — the parent touch target already carries the label/role.
          // Hide from BOTH accessibility trees: `accessibilityElementsHidden` is
          // iOS-only, so add `importantForAccessibility="no-hide-descendants"`
          // for Android so the shield isn't focused/announced separately (Copilot).
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <ShieldCheck size={12} color={infoTint} strokeWidth={2.25} />
        </View>
      ) : null}
      {/* Footer-row time zeroes the standalone bubbleTime top margin so the
          tick sits level with the timestamp (Copilot #858). */}
      <Text style={[timeStyle, styles.bubbleFooterTime]}>{time}</Text>
      {showTick ? (
        <DeliveryTick
          styles={styles}
          status={deliveryStatus as DeliveryStatus}
          tint={deliveryTint}
          testID={`dm-bubble-delivery-tick-${messageId}`}
        />
      ) : null}
    </TouchableOpacity>
  );
};
