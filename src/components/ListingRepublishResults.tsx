import React, { useMemo } from 'react';
import { Modal, View, Text, FlatList, TouchableOpacity } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import type { RepublishSummary } from '../hooks/useListingRepublish';
import { createListingRepublishStyles } from '../styles/ListingRepublish.styles';

export default function ListingRepublishResults({
  summary,
  onClose,
}: {
  summary: RepublishSummary[] | null;
  onClose: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createListingRepublishStyles(colors), [colors]);
  const t = useTranslation();
  return (
    <Modal visible={summary !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View
          style={styles.card}
          testID="republish-result-sheet"
          accessibilityLabel={t('market.republish.results')}
        >
          <Text style={styles.title}>{t('market.republish.results')}</Text>
          <FlatList
            data={summary ?? []}
            keyExtractor={(_, index) => String(index)}
            renderItem={({ item }) => (
              <View style={styles.item}>
                <Text style={styles.title}>{item.title}</Text>
                {item.missing ? (
                  <Text style={styles.text}>{t('market.republish.missing')}</Text>
                ) : null}
                {item.results.map((result) => (
                  <View key={result.url} style={styles.item}>
                    <Text style={styles.text}>{result.url}</Text>
                    <Text style={styles.text}>
                      {t(`market.republish.${result.status}`)}
                      {result.reason ? `: ${result.reason}` : ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          />
          <TouchableOpacity
            onPress={onClose}
            accessibilityLabel={t('market.republish.close')}
            testID="republish-results-close"
            style={styles.button}
          >
            <Text style={styles.buttonText}>{t('market.republish.close')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
