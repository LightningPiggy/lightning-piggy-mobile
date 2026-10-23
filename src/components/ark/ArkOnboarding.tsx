import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import ArkButton, { showArkError } from './ArkButton';
import { useTranslation } from '../../contexts/LocaleContext';
import { ArkInvalidMnemonicError } from '../../services/arkService';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

interface Props {
  styles: ArkWalletStyles;
  busy: boolean;
  onCreate: () => Promise<void>;
  onRestore: (phrase: string) => Promise<void>;
}

/** No Ark wallet yet: create one, or restore from a recovery phrase. */
export default function ArkOnboarding({ styles, busy, onCreate, onRestore }: Props) {
  const t = useTranslation();
  const [restoring, setRestoring] = useState(false);
  const [phrase, setPhrase] = useState('');

  const create = async () => {
    try {
      await onCreate();
    } catch (err) {
      showArkError(t('arkWallet.createFailed'), err);
    }
  };

  const restore = async () => {
    try {
      await onRestore(phrase);
      setPhrase('');
    } catch (err) {
      if (err instanceof ArkInvalidMnemonicError) {
        showArkError(t('arkWallet.restoreFailed'), new Error(t('arkWallet.invalidPhrase')));
      } else {
        showArkError(t('arkWallet.restoreFailed'), err);
      }
    }
  };

  return (
    <View style={styles.card} testID="ark-onboarding">
      <Text style={styles.heading}>{t('arkWallet.onboardingTitle')}</Text>
      <Text style={styles.body}>{t('arkWallet.onboardingBody')}</Text>
      <ArkButton
        styles={styles}
        label={t('arkWallet.create')}
        onPress={create}
        busy={busy && !restoring}
        disabled={busy}
        testID="ark-create"
      />
      {restoring ? (
        <>
          <TextInput
            style={styles.input}
            value={phrase}
            onChangeText={setPhrase}
            placeholder={t('arkWallet.phrasePlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            secureTextEntry={false}
            importantForAutofill="no"
            testID="ark-restore-input"
            accessibilityLabel={t('arkWallet.phrasePlaceholder')}
          />
          <ArkButton
            styles={styles}
            label={t('arkWallet.restore')}
            onPress={restore}
            busy={busy}
            disabled={phrase.trim().split(/\s+/).length < 12}
            variant="secondary"
            testID="ark-restore-confirm"
          />
        </>
      ) : (
        <ArkButton
          styles={styles}
          label={t('arkWallet.restoreInstead')}
          onPress={() => setRestoring(true)}
          disabled={busy}
          variant="secondary"
          testID="ark-restore"
        />
      )}
    </View>
  );
}
