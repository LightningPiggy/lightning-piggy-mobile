import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { Text, TouchableOpacity } from 'react-native';
import { Zap } from 'lucide-react-native';
import { useNostr } from '../contexts/NostrContext';
import { useWallet } from '../contexts/WalletContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { fetchProfile } from '../services/nostrService';
import { createRelayDetailsScreenStyles } from '../styles/RelayDetailsScreen.styles';
import { Alert } from './BrandedAlert';
import BrandedSpinner from './BrandedSpinner';
import SendSheet from './SendSheet';

interface Props {
  /** The relay operator's pubkey (NIP-11 `pubkey`). */
  pubkey: string;
  name: string;
  picture: string | null;
}

/**
 * "Tip the operator": a zap (NIP-57) to the relay operator through the usual
 * send sheet. The Lightning address comes from the operator's
 * signature-verified profile at tap time, so neither a relay nor a cached
 * profile can redirect the payment.
 */
export default function RelayOperatorTip({ pubkey, name, picture }: Props) {
  const t = useTranslation();
  const colors = useThemeColors();
  const styles = useMemo(() => createRelayDetailsScreenStyles(colors), [colors]);
  const { relays } = useNostr();
  const { hasWallets } = useWallet();
  const [address, setAddress] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  // The screen can stay mounted behind another one: a lookup that finishes
  // after the user left mustn't open the sheet over whatever they're on.
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  const attempt = useRef(0);
  useEffect(() => {
    focusedRef.current = focused;
    if (!focused) {
      attempt.current++;
      setAddress(null);
      setResolving(false);
    }
  }, [focused]);

  const tip = useCallback(async () => {
    if (!hasWallets) {
      Alert.alert(
        t('contactProfileScreen.noWalletTitle'),
        t('contactProfileScreen.noWalletMessage'),
      );
      return;
    }
    const mine = ++attempt.current;
    setResolving(true);
    try {
      const read = relays.filter((r) => r.read).map((r) => r.url);
      const profile = await fetchProfile(pubkey, read);
      if (mine !== attempt.current || !focusedRef.current) return;
      if (!profile?.lud16) {
        Alert.alert(
          t('contactProfileScreen.noLightningAddressTitle'),
          t('contactProfileScreen.noLightningAddressMessage', { name }),
        );
        return;
      }
      setAddress(profile.lud16);
    } finally {
      if (mine === attempt.current) setResolving(false);
    }
  }, [hasWallets, relays, pubkey, name, t]);

  return (
    <>
      <TouchableOpacity
        style={[styles.tip, resolving && styles.disabled]}
        onPress={() => void tip()}
        disabled={resolving}
        testID="relay-operator-tip"
        accessibilityRole="button"
        accessibilityLabel={t('relayDetails.tipOperatorLabel', { name })}
      >
        {resolving ? <BrandedSpinner size="small" /> : <Zap size={18} color={colors.brandPink} />}
        <Text style={styles.tipText}>{t('relayDetails.tipOperator')}</Text>
      </TouchableOpacity>
      {address && (
        <SendSheet
          visible
          onClose={() => setAddress(null)}
          initialAddress={address}
          initialPicture={picture ?? undefined}
          recipientPubkey={pubkey}
          recipientName={name}
        />
      )}
    </>
  );
}
