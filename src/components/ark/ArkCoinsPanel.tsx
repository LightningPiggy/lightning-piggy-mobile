import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import ArkButton, { confirmArk, showArkError } from './ArkButton';
import { Toast } from '../BrandedToast';
import { useTranslation } from '../../contexts/LocaleContext';
import {
  boardOnchainFunds,
  claimExitsTo,
  getArkBoardingAddress,
  moveAllOnchain,
  quoteMoveAllOnchain,
  refreshArkCoins,
  startEmergencyExit,
  type ArkOverview,
} from '../../services/arkMaintenance';
import { parseArkDestination } from '../../utils/arkDestination';
import { formatSatsNumber } from '../../utils/marketPrice';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

interface Props {
  styles: ArkWalletStyles;
  overview: ArkOverview;
  onChanged: () => void;
}

type Action = 'refresh' | 'boardAddress' | 'board' | 'moveOut' | 'exit' | 'claim' | null;

/**
 * Keep coins fresh, move funds in from on-chain, move everything out
 * on-chain (with the server), and the emergency exit (without it).
 */
export default function ArkCoinsPanel({ styles, overview, onChanged }: Props) {
  const t = useTranslation();
  const [running, setRunning] = useState<Action>(null);
  const [boardingAddress, setBoardingAddress] = useState<string | null>(null);
  const [outAddress, setOutAddress] = useState('');
  const sats = (n: number) => t('arkWallet.satsAmount', { amount: formatSatsNumber(n) });
  const outDest = parseArkDestination(outAddress);
  const validOut = outDest?.kind === 'bitcoin' ? outDest.value : null;

  const run = async (action: Exclude<Action, null>, fn: () => Promise<string | null>) => {
    setRunning(action);
    try {
      const done = await fn();
      if (done) Toast.show({ type: 'success', text1: done });
      onChanged();
    } catch (err) {
      showArkError(t('arkWallet.actionFailed'), err);
    } finally {
      setRunning(null);
    }
  };

  const refresh = () =>
    run('refresh', async () =>
      (await refreshArkCoins()) ? t('arkWallet.refreshStarted') : t('arkWallet.nothingToRefresh'),
    );

  const showBoardingAddress = () =>
    run('boardAddress', async () => {
      setBoardingAddress(await getArkBoardingAddress());
      return null;
    });

  const board = () =>
    run('board', async () =>
      t('arkWallet.boardStarted', { amount: sats(await boardOnchainFunds()) }),
    );

  const moveOut = () =>
    run('moveOut', async () => {
      if (!validOut) return null;
      const quote = await quoteMoveAllOnchain(validOut);
      const ok = await confirmArk(
        t('arkWallet.moveOutTitle'),
        t('arkWallet.moveOutConfirm', { amount: sats(quote.netSats), fee: sats(quote.feeSats) }),
        t('arkWallet.moveOut'),
        t('arkWallet.cancel'),
      );
      if (!ok) return null;
      await moveAllOnchain(validOut);
      setOutAddress('');
      return t('arkWallet.moveOutStarted');
    });

  const exit = () =>
    run('exit', async () => {
      const ok = await confirmArk(
        t('arkWallet.exitTitle'),
        t('arkWallet.exitConfirm'),
        t('arkWallet.exitStart'),
        t('arkWallet.cancel'),
        true,
      );
      if (!ok) return null;
      await startEmergencyExit();
      return t('arkWallet.exitStarted');
    });

  const claim = () =>
    run('claim', async () => {
      if (!validOut) return null;
      await claimExitsTo(validOut);
      return t('arkWallet.claimStarted');
    });

  return (
    <View style={styles.card} testID="ark-coins-panel">
      <Text style={styles.heading}>{t('arkWallet.freshTitle')}</Text>
      <Text style={styles.body}>{t('arkWallet.freshBody')}</Text>
      <ArkButton
        styles={styles}
        label={t('arkWallet.refreshNow')}
        onPress={refresh}
        busy={running === 'refresh'}
        disabled={running !== null || overview.spendableSats === 0}
        testID="ark-refresh"
      />

      <View style={styles.divider} />
      <Text style={styles.heading}>{t('arkWallet.moveInTitle')}</Text>
      <Text style={styles.body}>{t('arkWallet.moveInBody')}</Text>
      {boardingAddress ? (
        <>
          <Text style={styles.mono} selectable testID="ark-boarding-address">
            {boardingAddress}
          </Text>
          <ArkButton
            styles={styles}
            label={t('arkWallet.copy')}
            onPress={() => void Clipboard.setStringAsync(boardingAddress)}
            variant="secondary"
            testID="ark-boarding-copy"
          />
        </>
      ) : (
        <ArkButton
          styles={styles}
          label={t('arkWallet.showBoardingAddress')}
          onPress={showBoardingAddress}
          busy={running === 'boardAddress'}
          disabled={running !== null}
          variant="secondary"
          testID="ark-show-boarding-address"
        />
      )}
      <ArkButton
        styles={styles}
        label={t('arkWallet.board')}
        onPress={board}
        busy={running === 'board'}
        disabled={running !== null || overview.onchainSats === 0}
        testID="ark-board"
      />

      <View style={styles.divider} />
      <Text style={styles.heading}>{t('arkWallet.moveOutTitle')}</Text>
      <Text style={styles.body}>{t('arkWallet.moveOutBody')}</Text>
      <TextInput
        style={styles.input}
        value={outAddress}
        onChangeText={setOutAddress}
        placeholder={t('arkWallet.onchainAddressPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        testID="ark-move-out-address"
        accessibilityLabel={t('arkWallet.onchainAddressPlaceholder')}
      />
      <ArkButton
        styles={styles}
        label={t('arkWallet.moveOut')}
        onPress={moveOut}
        busy={running === 'moveOut'}
        disabled={running !== null || !validOut || overview.spendableSats === 0}
        testID="ark-move-out"
      />
      {overview.claimableExits > 0 && (
        <ArkButton
          styles={styles}
          label={t('arkWallet.claimExits')}
          onPress={claim}
          busy={running === 'claim'}
          disabled={running !== null || !validOut}
          testID="ark-claim-exits"
        />
      )}

      <View style={styles.divider} />
      <Text style={styles.heading}>{t('arkWallet.exitTitle')}</Text>
      <Text style={styles.hint}>{t('arkWallet.exitBody')}</Text>
      <ArkButton
        styles={styles}
        label={t('arkWallet.exitStart')}
        onPress={exit}
        busy={running === 'exit'}
        disabled={running !== null || overview.spendableSats === 0}
        variant="destructive"
        testID="ark-emergency-exit"
      />
    </View>
  );
}
