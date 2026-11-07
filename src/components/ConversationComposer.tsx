import BrandedSpinner from './BrandedSpinner';
import type { MessageQuote } from '../utils/messageQuote';
import React, { useMemo } from 'react';
import { Text, TextInput, TouchableOpacity, View, type TextInputProps } from 'react-native';
import { Plus, Send, Mic, Pencil, X } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import {
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createConversationComposerStyles } from '../styles/ConversationComposer.styles';
import SharedImageTray from './SharedImageTray';
import type { StagedShare } from '../hooks/useStagedShare';

/**
 * Shared composer for 1:1 (ConversationScreen) and group
 * (GroupConversationScreen) chats. See issue #251 — both screens used to
 * own their own composer + keyboard-handling code; PR #250 already
 * converged the keyboard wrapper. This component finishes the dedupe so
 * the composer's IME behaviour, padding, and attach-panel placement
 * can't drift again.
 *
 * The keyboard wrapping is the deliberate single source of truth: every
 * call site gets `KeyboardStickyView` + `useReanimatedKeyboardAnimation`
 * via this component. The animated paddingBottom transitions between
 * `8 + insets.bottom` (closed → composer sits above the gesture bar) and
 * `8` (open → composer hugs the keyboard's top edge with no whitespace
 * gap). This matches RNKC's canonical chat pattern documented in
 * ConversationScreen.tsx.
 *
 * Style overrides (sendButtonVariant, attachButtonHasBackground,
 * composerPaddingHorizontal) preserve the small visual differences the
 * two screens shipped with — the group chat uses a larger paper-plane
 * send button and a transparent attach button, while 1:1 uses the
 * compact lucide Send icon and a light-grey attach background. Picking
 * one would have been a UX regression in the other; the divergence is
 * documented at each prop site.
 */
export interface ConversationComposerProps {
  /** Current draft text. Controlled by the parent so it can persist or pre-fill. */
  value: string;
  onChangeText: (text: string) => void;
  /** Called when the user taps Send. Send button is disabled when value is empty. */
  onSend: () => void;
  /**
   * When provided, the trailing button is a microphone (tap → start a voice
   * note) WHILE the input is empty, and swaps to the Send button as soon as
   * the user types — the WhatsApp/Signal pattern (#235). Omit to always show
   * Send (e.g. surfaces without voice support).
   */
  onStartVoiceNote?: () => void;
  /** Whether a send is in flight. Disables the input + swaps the send icon for a spinner. */
  sending: boolean;
  /** Toggles the inline attach panel open/closed. Parent owns the panel-open state. */
  onAttachToggle: () => void;
  attachOpen: boolean;
  /** Disables the Attach button (e.g. while a location share or image upload is mid-flight). */
  attachDisabled?: boolean;
  /** NIP-04 threads only support text; disables attachments and hides voice. */
  attachmentsEnabled?: boolean;
  /** Called when the input gains focus — typical use is to close the attach panel. */
  onInputFocus?: () => void;
  /** Renders a spinner on the Attach button instead of the Plus icon. */
  attachLoading?: boolean;
  /** AttachPanel content. Rendered above the composer row when `attachOpen` is true. */
  attachPanel?: React.ReactNode;
  /** Placeholder text shown when the input is empty. */
  placeholder?: string;
  /** When true the input + send are gated even with non-empty text (e.g. logged out). */
  disabled?: boolean;
  /**
   * Visual variant for the send button. 1:1 uses the compact lucide Send
   * icon (40×40, no disabled-opacity); group uses an inline paper-plane
   * SVG (44×44, opacity 0.4 when disabled). Default: 'icon'.
   */
  sendButtonVariant?: 'icon' | 'paper-plane';
  /**
   * 1:1 has a light-grey circular background on the Attach button; group
   * uses a transparent button. Default: false (transparent).
   */
  attachButtonHasBackground?: boolean;
  /** Composer container horizontal padding. 1:1 ships 10, group ships 12. Default 10. */
  composerPaddingHorizontal?: number;
  /**
   * Set while the input holds an edit of one of your messages (#1237): shows
   * an "Editing message" bar with a cancel button, and Send saves the edit.
   * Attachments and voice notes are off meanwhile.
   */
  editing?: { onCancel: () => void };
  replying?: { quote: MessageQuote; onCancel: () => void };
  /**
   * Rendered directly above the input row, inside the keyboard-sticky area —
   * the group chat's @mention picker (#1295).
   */
  accessory?: React.ReactNode;
  /** Images shared in from another app, waiting for the user's Send (#1692). */
  stagedShare?: StagedShare | null;
  /** Cursor tracking for the @mention picker. */
  onSelectionChange?: TextInputProps['onSelectionChange'];
  /** Set briefly to place the cursor (after inserting a mention). */
  selection?: TextInputProps['selection'];
  testIDs?: {
    input?: string;
    attach?: string;
    send?: string;
    voice?: string;
  };
  accessibilityLabels?: {
    input?: string;
    attach?: string;
    send?: string;
    voice?: string;
  };
}

const ConversationComposer: React.FC<ConversationComposerProps> = ({
  value,
  onChangeText,
  onSend,
  onStartVoiceNote,
  sending,
  onAttachToggle,
  attachOpen,
  attachDisabled = false,
  attachmentsEnabled = true,
  onInputFocus,
  attachLoading = false,
  attachPanel,
  placeholder,
  disabled = false,
  sendButtonVariant = 'icon',
  attachButtonHasBackground = false,
  composerPaddingHorizontal = 10,
  editing,
  replying,
  accessory,
  stagedShare,
  onSelectionChange,
  selection,
  testIDs,
  accessibilityLabels,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () =>
      createConversationComposerStyles(colors, {
        paddingHorizontal: composerPaddingHorizontal,
        attachButtonHasBackground,
      }),
    [colors, composerPaddingHorizontal, attachButtonHasBackground],
  );

  // Drives the composer's animated paddingBottom: when the keyboard is
  // closed we leave insets.bottom of dead space so the input row sits
  // above the gesture bar; as the keyboard opens we shrink that to 0
  // so the input hugs the keyboard's top edge with no whitespace gap.
  // Identical to ConversationScreen.tsx's prior in-screen wiring.
  const keyboard = useReanimatedKeyboardAnimation();
  const composerSafeAreaStyle = useAnimatedStyle(() => ({
    paddingBottom: 8 + Math.max(insets.bottom * (1 + keyboard.progress.value * -1), 0),
  }));

  const sendDisabled = disabled || !value.trim() || sending;
  const inputDisabled = disabled || sending;
  // WhatsApp/Signal pattern (#235): show the mic while the input is empty (and
  // voice is supported here), swap to Send the moment the user types.
  const showMic =
    attachmentsEnabled && !!onStartVoiceNote && !value.trim() && !sending && !disabled && !editing;
  const attachBlocked = !attachmentsEnabled || disabled || sending || attachDisabled || !!editing;
  const sendLabel = editing
    ? t('conversationComposer.saveEdit')
    : (accessibilityLabels?.send ?? t('conversationComposer.sendMessage'));

  return (
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
      {attachmentsEnabled && attachOpen && !editing ? attachPanel : null}
      {stagedShare ? <SharedImageTray {...stagedShare} /> : null}
      {editing ? (
        <View style={styles.editBanner} testID="composer-edit-banner">
          <Pencil size={14} color={colors.brandPink} />
          <Text style={styles.editBannerText}>{t('conversationComposer.editingMessage')}</Text>
          <TouchableOpacity
            onPress={editing.onCancel}
            accessibilityLabel={t('conversationComposer.cancelEdit')}
            testID="composer-edit-cancel"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={18} color={colors.textSupplementary} />
          </TouchableOpacity>
        </View>
      ) : null}
      {replying && !editing ? (
        <View style={styles.editBanner} testID="composer-reply-banner">
          <Text style={styles.editBannerText} numberOfLines={2}>
            {replying.quote.fromMe
              ? t('messageBubble.quoteYou')
              : (replying.quote.authorName ?? t('messageBubble.quoteSomeone'))}
            {'\n'}
            {replying.quote.text ?? t('messageBubble.quoteUnavailable')}
          </Text>
          <TouchableOpacity
            onPress={replying.onCancel}
            accessibilityLabel={t('conversationComposer.cancelReply')}
            testID="composer-reply-cancel"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={18} color={colors.textSupplementary} />
          </TouchableOpacity>
        </View>
      ) : null}
      {accessory}
      <Animated.View style={[styles.composer, composerSafeAreaStyle]}>
        <TouchableOpacity
          style={[
            styles.attachButton,
            (!attachmentsEnabled || editing) && styles.sendButtonDisabled,
          ]}
          onPress={onAttachToggle}
          disabled={attachBlocked}
          accessibilityState={{ disabled: attachBlocked }}
          accessibilityHint={
            attachmentsEnabled ? undefined : t('conversationComposer.attachmentsNip17Only')
          }
          accessibilityLabel={accessibilityLabels?.attach ?? t('conversationComposer.attach')}
          testID={testIDs?.attach}
        >
          {attachLoading ? <BrandedSpinner /> : <Plus size={22} color={colors.brandPink} />}
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          placeholder={placeholder ?? t('conversationComposer.messagePlaceholder')}
          placeholderTextColor={colors.textSupplementary}
          value={value}
          onChangeText={onChangeText}
          onSelectionChange={onSelectionChange}
          selection={selection}
          onFocus={onInputFocus}
          multiline
          editable={!inputDisabled}
          accessibilityLabel={accessibilityLabels?.input ?? t('conversationComposer.messageInput')}
          testID={testIDs?.input}
        />
        {showMic ? (
          <TouchableOpacity
            style={sendButtonVariant === 'paper-plane' ? styles.sendButtonLarge : styles.sendButton}
            onPress={onStartVoiceNote}
            accessibilityLabel={
              accessibilityLabels?.voice ?? t('conversationComposer.recordVoiceNote')
            }
            testID={testIDs?.voice ?? 'composer-voice'}
          >
            <Mic size={20} color={colors.white} />
          </TouchableOpacity>
        ) : sendButtonVariant === 'paper-plane' ? (
          <TouchableOpacity
            style={[styles.sendButtonLarge, sendDisabled && styles.sendButtonDisabled]}
            onPress={onSend}
            disabled={sendDisabled}
            accessibilityLabel={sendLabel}
            testID={testIDs?.send}
          >
            {sending ? (
              <BrandedSpinner onGradient />
            ) : (
              <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"
                  stroke={colors.white}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.sendButton}
            onPress={onSend}
            disabled={sendDisabled}
            accessibilityLabel={sendLabel}
            testID={testIDs?.send}
          >
            {sending ? <BrandedSpinner onGradient /> : <Send size={20} color={colors.white} />}
          </TouchableOpacity>
        )}
      </Animated.View>
    </KeyboardStickyView>
  );
};

export default ConversationComposer;
