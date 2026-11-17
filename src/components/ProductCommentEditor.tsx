import type { TextInputInstance } from 'react-native';
import React, { useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import type { Event as NostrEvent } from 'nostr-tools';
import { useTranslation } from '../contexts/LocaleContext';
import { canSaveCommentEdit, commentIdTestSuffix } from '../utils/commentEditDraft';
import type { ProductCommentsStyles as Styles } from '../styles/ProductComments.styles';
import BrandedSpinner from './BrandedSpinner';

interface Props {
  /** The comment being edited (its card hosts this editor). */
  comment: NostrEvent;
  /** The draft text. */
  text: string;
  /** The edit is publishing — Save shows a spinner and the card is locked. */
  saving: boolean;
  styles: Styles;
  onChangeText: (text: string) => void;
  onCancel: () => void;
  onSave: (comment: NostrEvent, text: string) => void;
}

/**
 * The in-place editor inside your own comment's card (#1524): a multiline
 * input prefilled with the comment and focused with the cursor at the end,
 * plus Cancel / Save. Save is disabled while the text is unchanged or empty.
 * The screen's keyboard-aware ScrollView scrolls the focused input (and the
 * buttons below it) above the keyboard.
 */
const ProductCommentEditor: React.FC<Props> = ({
  comment,
  text,
  saving,
  styles,
  onChangeText,
  onCancel,
  onSave,
}) => {
  const t = useTranslation();
  const inputRef = useRef<TextInputInstance>(null);
  // The prefilled length at mount — where the cursor starts.
  const initialEnd = useRef(text.length);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelection(initialEnd.current, initialEnd.current);
  }, []);

  const suffix = commentIdTestSuffix(comment.id);
  const canSave = !saving && canSaveCommentEdit(comment.content, text);

  return (
    <View style={styles.editor}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={text}
        onChangeText={onChangeText}
        editable={!saving}
        multiline
        accessibilityLabel={t('market.comments.editing')}
        testID={`comment-edit-input-${suffix}`}
      />
      <View style={styles.editActions}>
        <TouchableOpacity
          style={[styles.editCancel, saving && styles.submitDisabled]}
          onPress={onCancel}
          disabled={saving}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving }}
          testID={`comment-edit-cancel-${suffix}`}
        >
          <Text style={styles.editCancelText}>{t('market.comments.cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.editSave, !canSave && !saving && styles.submitDisabled]}
          onPress={() => onSave(comment, text)}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave, busy: saving }}
          activeOpacity={0.8}
          testID={`comment-edit-save-${suffix}`}
        >
          {saving ? (
            <BrandedSpinner size="small" onGradient />
          ) : (
            <Text style={styles.editSaveText}>{t('market.comments.save')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default React.memo(ProductCommentEditor);
