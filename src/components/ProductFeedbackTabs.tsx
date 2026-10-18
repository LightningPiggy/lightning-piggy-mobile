import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Star, MessageSquare } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import type { CommentRoot } from '../utils/productComments';
import { createProductFeedbackTabsStyles } from '../styles/ProductFeedbackTabs.styles';
import type { RegisterRefresher } from '../hooks/usePullToRefresh';
import ProductReviews from './ProductReviews';
import ProductComments from './ProductComments';

interface Props {
  /** Review coordinate `a:30402:<merchant>:<dTag>`. */
  initialTab?: 'comments' | 'reviews';
  coord: string;
  /** The kind-30402 product event the comment thread roots on. */
  commentRoot: CommentRoot;
  /** Opens the login sheet for signed-out compose attempts. */
  onRequestSignIn: () => void;
  /** The product page's pull-to-refresh; each mounted section joins it. */
  registerRefresh?: RegisterRefresher;
}

type Tab = 'reviews' | 'comments';

/**
 * Underlined Reviews / Comments tabs (mirroring the companion website's
 * product feedback tabs) with live counts + icons. Reviews (the default tab)
 * mounts immediately; Comments is lazy-mounted on first open so landing on the
 * product page fires one relay query, not two. Once a section has mounted it
 * stays mounted (hidden when inactive), so switching back never refetches or
 * loses an in-progress compose, and the counts stay live in the tab labels.
 */
const ProductFeedbackTabs: React.FC<Props> = ({
  coord,
  initialTab = 'reviews',
  commentRoot,
  onRequestSignIn,
  registerRefresh,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createProductFeedbackTabsStyles(colors), [colors]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [reviewCount, setReviewCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  // Lazy-mount: Reviews is the default tab so it mounts immediately; Comments
  // (and its relay fetch) is deferred until the user first opens that tab, so
  // landing on the product page fires ONE relay query, not two (Copilot review
  // on #948). Once visited a tab stays mounted (hidden) so switching back never
  // refetches or loses an in-progress compose.
  const [commentsMounted, setCommentsMounted] = useState(initialTab === 'comments');

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    if (next === 'comments') setCommentsMounted(true);
  }, []);

  const onReviewCount = useCallback((n: number) => setReviewCount(n), []);
  const onCommentCount = useCallback((n: number) => setCommentCount(n), []);

  const renderTab = (value: Tab, label: string, count: number, Icon: typeof Star) => {
    const active = tab === value;
    return (
      <Pressable
        style={[styles.tab, active && styles.tabActive]}
        onPress={() => selectTab(value)}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        testID={`product-feedback-tab-${value}`}
      >
        <Icon
          size={16}
          color={active ? colors.textHeader : colors.textSupplementary}
          strokeWidth={2}
        />
        <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
          {label}
          {count > 0 ? ` (${count})` : ''}
        </Text>
      </Pressable>
    );
  };

  return (
    <View testID="product-feedback-tabs">
      <View style={styles.tabBar} accessibilityRole="tablist">
        {renderTab('reviews', t('market.feedbackTabs.reviews'), reviewCount, Star)}
        {renderTab('comments', t('market.feedbackTabs.comments'), commentCount, MessageSquare)}
      </View>

      <View style={styles.body}>
        <View style={tab === 'reviews' ? styles.visible : styles.hidden}>
          <ProductReviews
            coord={coord}
            onRequestSignIn={onRequestSignIn}
            onCount={onReviewCount}
            registerRefresh={registerRefresh}
          />
        </View>
        <View style={tab === 'comments' ? styles.visible : styles.hidden}>
          {commentsMounted ? (
            <ProductComments
              root={commentRoot}
              onRequestSignIn={onRequestSignIn}
              onCount={onCommentCount}
              registerRefresh={registerRefresh}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
};

export default ProductFeedbackTabs;
