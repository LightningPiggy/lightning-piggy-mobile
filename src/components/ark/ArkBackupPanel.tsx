import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ScreenCapture from 'expo-screen-capture';
import ArkButton, { confirmArk, showArkError } from './ArkButton';
import { Toast } from '../BrandedToast';
import { useTranslation } from '../../contexts/LocaleContext';
import { authenticateForKeyReveal, keyRevealGate } from '../../services/accountKeyAccess';
import { readArkMnemonicForBackup } from '../../services/arkService';
import { canCopySensitiveText, copySensitiveText } from '../../services/sensitiveClipboard';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

const SCREEN_CAPTURE_KEY = 'ark-backup';

interface Props {
  styles: ArkWalletStyles;
  totalSats: number;
  onRemove: () => Promise<void>;
}

/**
 * Back up the Ark recovery phrase (same gate as Back up your key: device
 * authentication, no screenshots while shown, secret clipboard) and remove
 * the wallet from this phone. The phrase lives only in this component's
 * state and is dropped on blur.
 */
export default function ArkBackupPanel({ styles, totalSats, onRemove }: Props) {
  const t = useTranslation();
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(
      () => () => {
        setPhrase(null);
        ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => {});
      },
      [],
    ),
  );

  const reveal = async () => {
    if (phrase) {
      setPhrase(null);
      await ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => {});
      return;
    }
    setBusy(true);
    try {
      const gate = await keyRevealGate();
      const ok =
        gate === 'device-auth'
          ? await authenticateForKeyReveal({
              promptMessage: t('arkWallet.authPrompt'),
              cancelLabel: t('arkWallet.cancel'),
            })
          : await confirmArk(
              t('arkWallet.backupTitle'),
              t('arkWallet.backupWarning'),
              t('arkWallet.showPhrase'),
              t('arkWallet.cancel'),
            );
      if (!ok) return;
      await ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => {});
      setPhrase(await readArkMnemonicForBackup());
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!phrase) return;
    await copySensitiveText(phrase);
    Toast.show({ type: 'success', text1: t('arkWallet.copied') });
  };

  const remove = async () => {
    const ok = await confirmArk(
      t('arkWallet.removeTitle'),
      totalSats > 0 ? t('arkWallet.removeWithFunds') : t('arkWallet.removeBody'),
      t('arkWallet.remove'),
      t('arkWallet.cancel'),
      true,
    );
    if (!ok) return;
    try {
      await onRemove();
    } catch (err) {
      showArkError(t('arkWallet.actionFailed'), err);
    }
  };

  return (
    <View style={styles.card} testID="ark-backup-panel">
      <Text style={styles.heading}>{t('arkWallet.backupTitle')}</Text>
      <Text style={styles.body}>{t('arkWallet.backupWarning')}</Text>
      {phrase && (
        <Text style={styles.mono} selectable={false} testID="ark-backup-phrase">
          {phrase}
        </Text>
      )}
      <ArkButton
        styles={styles}
        label={phrase ? t('arkWallet.hidePhrase') : t('arkWallet.showPhrase')}
        onPress={reveal}
        busy={busy}
        testID="ark-backup-reveal"
      />
      {phrase && canCopySensitiveText() && (
        <ArkButton
          styles={styles}
          label={t('arkWallet.copy')}
          onPress={copy}
          variant="secondary"
          testID="ark-backup-copy"
        />
      )}
      <View style={styles.divider} />
      <ArkButton
        styles={styles}
        label={t('arkWallet.remove')}
        onPress={remove}
        variant="destructive"
        testID="ark-remove"
      />
    </View>
  );
}
