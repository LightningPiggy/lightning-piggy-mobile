import type { Event as NostrEvent } from 'nostr-tools';
import { useAccountState } from '../contexts/useAccountState';
import { commentRootRef } from '../utils/productComments';
import ProductReplyComposer from './ProductReplyComposer';
import BrandedSpinner from './BrandedSpinner';
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { useProductComments } from '../hooks/useProductComments';
import { useProductCommentActions } from '../hooks/useProductCommentActions';
import { useRegisterRefresher, type RegisterRefresher } from '../hooks/usePullToRefresh';
import type { CommentRoot } from '../utils/productComments';
import { FEEDBACK_PAGE_SIZE } from '../utils/marketFeedback';
import { createProductCommentsStyles } from '../styles/ProductComments.styles';
import ProductCommentItem from './ProductCommentItem';

interface Props {
  /** The kind-30402 product event the thread is rooted on. */
  root: CommentRoot;
  /** Called when a signed-out user tries to comment — opens the login sheet. */
  onRequestSignIn: () => void;
  /** Reports the current top-level comment count up to the tab bar. */
  onCount?: (count: number) => void;
  /** Joins the product page's pull-to-refresh (#1301). */
  registerRefresh?: RegisterRefresher;
}

/**
 * Comments tab body: a new-comment compose box (or sign-in prompt) and the
 * list of top-level comments (NIP-22 kind 1111), with Edit / Delete on your
 * own (#1272). Edit happens in place inside the comment's card (#1524) — the
 * top composer is only ever for new comments. Pure logic lives in
 * `utils/productComments`, `utils/commentEdits` and `utils/commentEditDraft`;
 * the compose + edit/delete orchestration in `useProductCommentActions`.
 */
const ProductComments: React.FC<Props> = ({ root, onRequestSignIn, onCount, registerRefresh }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createProductCommentsStyles(colors), [colors]);
  const { thread, topLevel, loading, error, refetch, refresh, addLocally, hideLocally } =
    useProductComments(root);
  useRegisterRefresher(registerRefresh, refresh);
  const { pubkey } = useNostr();
  const [replyTo, setReplyTo] = useAccountState<NostrEvent | null>(
    `${pubkey}:${commentRootRef(root)}`,
    null,
  );
  const cancelReply = React.useCallback(() => setReplyTo(null), [setReplyTo]);
  const isSeller = !(root instanceof URL) && root.pubkey === pubkey;
  const {
    content,
    setContent,
    submit,
    posting,
    canPublish,
    editDraft,
    savingEditIds,
    startEdit,
    setEditText,
    cancelEdit,
    saveEdit,
    menuFor,
    toggleMenu,
    requestDelete,
  } = useProductCommentActions({ root, pubkey, addLocally, hideLocally, refetch });

  useEffect(() => {
    onCount?.(topLevel.length);
  }, [topLevel.length, onCount]);

  // Page the rows: the list sits in the product page's outer ScrollView, so a
  // large thread must not mount every row + profile lookup at once.
  const [visibleCount, setVisibleCount] = useState(FEEDBACK_PAGE_SIZE);
  const hiddenCount = Math.max(0, thread.length - visibleCount);

  return (
    <View testID="product-comments">
      {canPublish ? (
        <View style={styles.form} testID="product-comment-form">
          <TextInput
            style={styles.input}
            value={content}
            onChangeText={setContent}
            placeholder={t('market.comments.placeholder')}
            placeholderTextColor={colors.textSupplementary}
            multiline
            testID="product-comment-text"
          />
          <TouchableOpacity
            style={[styles.submit, posting && styles.submitDisabled]}
            onPress={submit}
            disabled={posting}
            testID="product-comment-submit"
            activeOpacity={0.8}
          >
            {posting ? (
              <BrandedSpinner size="small" onGradient />
            ) : (
              <Text style={styles.submitText}>{t('market.comments.post')}</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.signInCard}
          onPress={onRequestSignIn}
          testID="product-comment-signin"
          activeOpacity={0.8}
        >
          <Text style={styles.signInText}>{t('market.comments.signIn')}</Text>
        </TouchableOpacity>
      )}

      {error ? (
        <View>
          <Text style={styles.state}>{t('market.comments.loadError')}</Text>
          <TouchableOpacity
            style={styles.showMore}
            onPress={refetch}
            accessibilityRole="button"
            testID="product-comments-retry"
          >
            <Text style={styles.showMoreText}>{t('market.feedbackTabs.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : loading && topLevel.length === 0 ? (
        <BrandedSpinner style={styles.loading} />
      ) : topLevel.length === 0 ? (
        <Text style={styles.state}>{t('market.comments.empty')}</Text>
      ) : (
        <>
          {thread.slice(0, visibleCount).map(({ comment: c, depth }) => (
            <View key={c.id} style={depth > 0 ? styles.reply : undefined}>
              <ProductCommentItem
                canReply={isSeller && canPublish}
                onReply={setReplyTo}
                comment={c}
                styles={styles}
                isMine={!!pubkey && c.pubkey === pubkey}
                menuOpen={menuFor === c.id}
                // Only the card being edited gets the draft, so typing
                // re-renders that one memoised row, not the whole list.
                editText={editDraft?.comment.id === c.id ? editDraft.text : null}
                editSaving={savingEditIds.has(c.id)}
                onToggleMenu={toggleMenu}
                onEdit={startEdit}
                onDelete={requestDelete}
                onEditChange={setEditText}
                onEditCancel={cancelEdit}
                onEditSave={saveEdit}
              />
              {replyTo?.id === c.id && isSeller ? (
                <ProductReplyComposer
                  key={`${pubkey}:${c.id}`}
                  root={root}
                  parent={c}
                  styles={styles}
                  onPosted={addLocally}
                  onCancel={cancelReply}
                />
              ) : null}
            </View>
          ))}
          {hiddenCount > 0 ? (
            <TouchableOpacity
              style={styles.showMore}
              onPress={() => setVisibleCount((c) => c + FEEDBACK_PAGE_SIZE)}
              accessibilityRole="button"
              testID="product-comments-show-more"
            >
              <Text style={styles.showMoreText}>
                {t('market.feedbackTabs.showMore', { count: hiddenCount })}
              </Text>
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </View>
  );
};

export default ProductComments;
