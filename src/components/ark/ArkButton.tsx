import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import BrandedSpinner from '../BrandedSpinner';
import { Alert } from '../BrandedAlert';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

interface Props {
  styles: ArkWalletStyles;
  label: string;
  onPress: () => void;
  testID: string;
  variant?: 'primary' | 'secondary' | 'destructive';
  disabled?: boolean;
  busy?: boolean;
}

/** The one button shape the Ark panels use. */
export default function ArkButton({
  styles,
  label,
  onPress,
  testID,
  variant = 'primary',
  disabled = false,
  busy = false,
}: Props) {
  const inactive = disabled || busy;
  const container = variant === 'primary' ? styles.button : styles.secondaryButton;
  const text =
    variant === 'primary'
      ? styles.buttonText
      : variant === 'destructive'
        ? styles.destructiveText
        : styles.secondaryButtonText;
  return (
    <TouchableOpacity
      style={[container, inactive && styles.buttonDisabled]}
      onPress={onPress}
      disabled={inactive}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
    >
      {busy ? <BrandedSpinner /> : <Text style={text}>{label}</Text>}
    </TouchableOpacity>
  );
}

/** Branded yes/no prompt as a promise. */
export function confirmArk(
  title: string,
  message: string,
  confirmLabel: string,
  cancelLabel: string,
  destructive = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}

/** Show a failed action's message in the branded alert. */
export function showArkError(title: string, err: unknown): void {
  Alert.alert(title, err instanceof Error ? err.message : String(err));
}
