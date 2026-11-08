import React, { useCallback, useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Alert } from './BrandedAlert';
import BrandedSpinner from './BrandedSpinner';
import { createSharedAccountStyles } from '../screens/account/sharedStyles';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useDmInboxSuggestion } from '../hooks/useDmInboxSuggestion';
import type { DefaultDmInboxOutcome } from '../contexts/defaultDmInbox';
import { createDmInboxSuggestionCardStyles } from '../styles/DmInboxSuggestionCard.styles';

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * "Let other Nostr apps message you": offers a default DM inbox list to any
 * existing account (imported nsec, Amber, NIP-46) — the app never publishes
 * one for an existing account unasked; only a key created in the app gets one
 * at onboarding. Renders nothing unless the background check proved there is
 * no list; Publish re-checks everything before signing.
 */
const DmInboxSuggestionCard: React.FC = () => {
  const t = useTranslation();
  const colors = useThemeColors();
  const shared = useMemo(() => createSharedAccountStyles(colors), [colors]);
  const styles = useMemo(() => createDmInboxSuggestionCardStyles(colors), [colors]);
  const { visible, relays, busy, signerPrompts, publish, dismiss } = useDmInboxSuggestion();

  const report = useCallback(
    (outcome: DefaultDmInboxOutcome | null) => {
      const failed = t('publishedRelays.notPublishedTitle');
      switch (outcome) {
        case 'published':
        // Live on some relays; re-sent to the rest a few times this session.
        case 'partial':
          return Alert.alert(
            t('dmInboxSuggestion.publishedTitle'),
            t('dmInboxSuggestion.publishedBody'),
          );
        case 'exists':
          return Alert.alert(t('dmInboxSuggestion.existsTitle'), t('dmInboxSuggestion.existsBody'));
        case 'unknown':
        case 'unreadable':
          return Alert.alert(failed, t('dmInboxSuggestion.checkFailed'));
        case 'no-relays':
          return Alert.alert(failed, t('dmInboxSuggestion.noRelays'));
        case 'not-signed':
          return Alert.alert(failed, t('publishedRelays.error.not-signed'));
        case 'none-accepted':
          return Alert.alert(failed, t('publishedRelays.error.none-accepted'));
        default:
          return undefined;
      }
    },
    [t],
  );

  // The fresh check picked other relays than the ones shown: ask before signing.
  const confirmChanged = useCallback(
    (next: string[]) =>
      new Promise<boolean>((resolve) => {
        Alert.alert(
          t('dmInboxSuggestion.confirmChangedTitle'),
          t('dmInboxSuggestion.confirmChangedBody', { relays: next.map(hostOf).join(', ') }),
          [
            {
              text: t('publishedRelays.cancel'),
              style: 'cancel',
              onPress: () => resolve(false),
              testID: 'dm-inbox-suggestion-confirm-cancel',
            },
            {
              text: t('publishedRelays.publish'),
              onPress: () => resolve(true),
              testID: 'dm-inbox-suggestion-confirm-publish',
            },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      }),
    [t],
  );

  const handlePublish = useCallback(async () => {
    report(await publish(confirmChanged).catch(() => 'unknown' as const));
  }, [publish, confirmChanged, report]);

  if (!visible) return null;

  return (
    <View style={styles.container} testID="dm-inbox-suggestion">
      <Text style={shared.sectionLabel}>{t('dmInboxSuggestion.title')}</Text>
      <Text style={shared.fieldHint}>{t('dmInboxSuggestion.body')}</Text>
      {signerPrompts && (
        <Text style={shared.fieldHint} testID="dm-inbox-suggestion-signer-hint">
          {t('dmInboxSuggestion.signerHint')}
        </Text>
      )}
      <Text style={shared.fieldHint} testID="dm-inbox-suggestion-other-app-hint">
        {t('dmInboxSuggestion.otherAppHint')}
      </Text>
      {relays.length > 0 && (
        <Text style={[shared.fieldHint, styles.relays]} testID="dm-inbox-suggestion-relays">
          {t('dmInboxSuggestion.relays', { relays: relays.map(hostOf).join(', ') })}
        </Text>
      )}
      <TouchableOpacity
        style={[shared.saveButton, styles.publishButton]}
        onPress={handlePublish}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
        accessibilityLabel={t('dmInboxSuggestion.publish')}
        testID="dm-inbox-suggestion-publish"
      >
        {busy ? (
          <BrandedSpinner />
        ) : (
          <Text style={shared.saveButtonText}>{t('dmInboxSuggestion.publish')}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.dismissButton}
        onPress={() => void dismiss()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('dmInboxSuggestion.notNow')}
        testID="dm-inbox-suggestion-dismiss"
      >
        <Text style={styles.dismissText}>{t('dmInboxSuggestion.notNow')}</Text>
      </TouchableOpacity>
    </View>
  );
};

export default DmInboxSuggestionCard;
