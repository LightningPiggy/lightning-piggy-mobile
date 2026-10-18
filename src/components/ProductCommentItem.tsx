import React from 'react';
import { View, Text, Pressable } from 'react-native';
import type { Event as NostrEvent } from 'nostr-tools';
import { useTranslation } from '../contexts/LocaleContext';
import { relativeTime } from '../utils/relativeTime';
import { isEditedComment } from '../utils/commentEdits';
import type { ProductCommentsStyles as Styles } from '../styles/ProductComments.styles';
import AuthorInline from './AuthorInline';
import { FeedbackActionsButton, FeedbackActionsRow } from './FeedbackActions';
import ProductCommentEditor from './ProductCommentEditor';

interface Props {
  canReply: boolean;
  onReply: (comment: NostrEvent) => void;
  comment: NostrEvent;
  styles: Styles;
  /** The signed-in user wrote it — only then are Edit / Delete offered. */
  isMine: boolean;
  menuOpen: boolean;
  /** The in-place edit draft when THIS card is the editor, else null. */
  editText: string | null;
  /** This card's edit is publishing. */
  editSaving: boolean;
  onToggleMenu: (id: string) => void;
  onEdit: (comment: NostrEvent) => void;
  onDelete: (comment: NostrEvent) => void;
  onEditChange: (text: string) => void;
  onEditCancel: () => void;
  onEditSave: (comment: NostrEvent, text: string) => void;
}

/**
 * One product comment row. Your own comments get a "⋯" button (and
 * long-press) that reveals Edit / Delete inline (#1272); Edit turns this card
 * into the editor in place (#1524). An edited comment shows an "Edited"
 * marker beside its time.
 */
const ProductCommentItem: React.FC<Props> = ({
  comment,
  canReply,
  onReply,
  styles,
  isMine,
  menuOpen,
  editText,
  editSaving,
  onToggleMenu,
  onEdit,
  onDelete,
  onEditChange,
  onEditCancel,
  onEditSave,
}) => {
  const t = useTranslation();
  const edited = isEditedComment(comment);
  const editing = isMine && editText !== null;
  return (
    <Pressable
      style={[styles.item, editing && styles.itemEditing]}
      testID={`product-comment-${comment.id}`}
      onLongPress={isMine && !editing ? () => onToggleMenu(comment.id) : undefined}
    >
      <View style={styles.itemHeader}>
        <AuthorInline pubkey={comment.pubkey} size={26} />
        <View style={styles.itemMeta}>
          <Text style={styles.when}>
            {relativeTime(comment.created_at ?? 0)}
            {edited ? ` · ${t('market.comments.editedMarker')}` : ''}
          </Text>
          {isMine && !editing ? (
            <FeedbackActionsButton
              kind="comment"
              id={comment.id}
              open={menuOpen}
              onToggle={() => onToggleMenu(comment.id)}
            />
          ) : null}
        </View>
      </View>
      {editing ? (
        <ProductCommentEditor
          comment={comment}
          text={editText}
          saving={editSaving}
          styles={styles}
          onChangeText={onEditChange}
          onCancel={onEditCancel}
          onSave={onEditSave}
        />
      ) : (
        <Text style={styles.itemText}>{comment.content}</Text>
      )}
      {canReply && !editing ? (
        <Pressable
          onPress={() => onReply(comment)}
          accessibilityRole="button"
          testID={`comment-reply-${comment.id}`}
        >
          <Text style={styles.showMoreText}>{t('sellerActivity.replyAction')}</Text>
        </Pressable>
      ) : null}
      {isMine && menuOpen && !editing ? (
        <FeedbackActionsRow
          kind="comment"
          onEdit={() => onEdit(comment)}
          onDelete={() => onDelete(comment)}
        />
      ) : null}
    </Pressable>
  );
};

export default React.memo(ProductCommentItem);
