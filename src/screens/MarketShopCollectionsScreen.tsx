import BrandedRefreshControl from '../components/BrandedRefreshControl';
import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Plus } from 'lucide-react-native';
import type { Event } from 'nostr-tools';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useSellerShop } from '../hooks/useSellerShop';
import { StaleRevisionError, useSellerActions } from '../hooks/useSellerActions';
import { Alert } from '../components/BrandedAlert';
import { Toast } from '../components/BrandedToast';
import MarketSellerHeader from '../components/MarketSellerHeader';
import CollectionEditorCard from '../components/CollectionEditorCard';
import SellerCollectionRow from '../components/SellerCollectionRow';
import { createMarketSellerStyles } from '../styles/MarketSeller.styles';
import {
  isLegacyShopCollection,
  newCollectionDraft,
  parseCollection,
  type CollectionDraft,
} from '../utils/marketCollections';
import type { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

const collectionKey = (event: Event) => event.id;

/** The seller's kind-30405 collections (#1534): list, create, edit, delete,
 * plus removing the legacy "shop" collection older app versions wrote. */
const MarketShopCollectionsScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketSellerStyles(colors), [colors]);
  const { snapshot, status, refresh } = useSellerShop();
  const { saveCollection, deleteCollection, deleteLegacyCollection, busy } =
    useSellerActions(snapshot);
  const [draft, setDraft] = useState<CollectionDraft | null>(null);
  // The published revision being edited (null = creating).
  const [base, setBase] = useState<Event | null>(null);

  const execute = useCallback(
    async (action: (force: boolean) => Promise<unknown>): Promise<void> => {
      try {
        await action(false);
        setDraft(null);
      } catch (error) {
        if (error instanceof StaleRevisionError) {
          Alert.alert(t('market.sell.conflictTitle'), t('market.sell.editor.conflictBody'), [
            { text: t('market.sell.cancel'), style: 'cancel' },
            { text: t('market.sell.overwrite'), onPress: () => void execute(() => action(true)) },
          ]);
        } else Toast.show({ type: 'error', text1: t('market.sell.shop.saveFailed') });
      }
    },
    [t],
  );
  const onDelete = useCallback(
    (event: Event) =>
      Alert.alert(
        t('market.sell.deleteCollectionTitle'),
        t('market.sell.deleteBody', { title: parseCollection(event).title }),
        [
          { text: t('market.sell.cancel'), style: 'cancel' },
          {
            text: t('market.sell.delete'),
            style: 'destructive',
            onPress: () => void execute((force) => deleteCollection(event, { force })),
          },
        ],
      ),
    [t, execute, deleteCollection],
  );
  const onEdit = useCallback((event: Event) => {
    setBase(event);
    setDraft(parseCollection(event));
  }, []);
  const onCreate = useCallback(() => {
    setBase(null);
    setDraft(newCollectionDraft());
  }, []);
  const onSave = useCallback(() => {
    if (!draft) return;
    void execute((force) => saveCollection(draft, base, { force }));
  }, [draft, base, execute, saveCollection]);
  const onCancel = useCallback(() => setDraft(null), []);

  const legacy = isLegacyShopCollection(snapshot.shop) ? snapshot.shop : null;
  const onRemoveLegacy = useCallback(() => {
    if (!legacy) return;
    const remove = async (force = false) => {
      try {
        await deleteLegacyCollection(legacy, { force });
      } catch (error) {
        if (error instanceof StaleRevisionError)
          Alert.alert(t('market.sell.conflictTitle'), t('market.sell.shop.conflictBody'), [
            { text: t('market.sell.cancel'), style: 'cancel' },
            { text: t('market.sell.overwrite'), onPress: () => void remove(true) },
          ]);
        else Toast.show({ type: 'error', text1: t('market.sell.deleteFailed') });
      }
    };
    Alert.alert(t('market.sell.deleteCollectionTitle'), t('market.sell.legacyCollectionHint'), [
      { text: t('market.sell.cancel'), style: 'cancel' },
      { text: t('market.sell.delete'), style: 'destructive', onPress: () => void remove() },
    ]);
  }, [legacy, deleteLegacyCollection, t]);

  const rows = useMemo(
    () => (snapshot.collections ?? []).filter((e) => !isLegacyShopCollection(e)),
    [snapshot.collections],
  );
  const renderItem = useCallback(
    ({ item }: { item: Event }) => (
      <SellerCollectionRow
        event={item}
        busy={busy}
        styles={styles}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    ),
    [busy, styles, onEdit, onDelete],
  );
  const renderSeparator = useCallback(() => <View style={styles.separator} />, [styles]);

  const listHeader = (
    <View style={styles.listHeader}>
      <Text style={styles.hint}>{t('market.sell.collectionsHint')}</Text>
      {status === 'error' ? (
        <TouchableOpacity
          onPress={refresh}
          accessibilityLabel={t('market.sell.retry')}
          testID="shop-collections-retry"
        >
          <Text style={styles.errorText}>{t('market.sell.loadError')}</Text>
        </TouchableOpacity>
      ) : null}
      {legacy ? (
        <TouchableOpacity
          style={styles.secondaryButton}
          testID="shop-remove-legacy"
          accessibilityLabel={t('market.sell.removeLegacyCollection')}
          disabled={busy}
          onPress={onRemoveLegacy}
        >
          <Text style={styles.secondaryButtonText}>{t('market.sell.removeLegacyCollection')}</Text>
        </TouchableOpacity>
      ) : null}
      {draft ? (
        <CollectionEditorCard
          draft={draft}
          editing={!!base}
          busy={busy}
          snapshot={snapshot}
          styles={styles}
          onChange={setDraft}
          onSave={onSave}
          onCancel={onCancel}
        />
      ) : (
        <TouchableOpacity
          style={styles.secondaryButton}
          disabled={busy}
          testID="collection-create"
          accessibilityLabel={t('market.sell.createCollection')}
          onPress={onCreate}
        >
          <Plus size={18} color={colors.brandPink} strokeWidth={2.5} />
          <Text style={styles.secondaryButtonText}>{t('market.sell.createCollection')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="shop-collections-screen"
    >
      <MarketSellerHeader
        title={t('market.sell.hub.collections')}
        backLabel={t('market.sell.back')}
        onBack={() => navigation.goBack()}
        testID="shop-collections-back"
      />
      <FlatList
        data={rows}
        keyExtractor={collectionKey}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          status === 'ready' ? (
            <Text style={[styles.muted, styles.emptyText]} testID="shop-collections-empty">
              {t('market.sell.noCollections')}
            </Text>
          ) : null
        }
        ItemSeparatorComponent={renderSeparator}
        contentContainerStyle={styles.listContent}
        style={styles.flex1}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <BrandedRefreshControl refreshing={status === 'loading'} onRefresh={refresh} />
        }
        initialNumToRender={8}
        windowSize={7}
        testID="shop-collection-list"
      />
    </KeyboardAvoidingView>
  );
};

export default MarketShopCollectionsScreen;
