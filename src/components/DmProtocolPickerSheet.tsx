import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { BackHandler, Text, View, TouchableOpacity } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { Check } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { Alert } from './BrandedAlert';
import MarmotAvailabilityNote from './MarmotAvailabilityNote';
import { useMarmotAvailability } from '../hooks/useMarmotAvailability';
import { DM_PROTOCOL_LABEL, isDmProtocolAvailable, type DmProtocol } from '../utils/dmProtocol';
import { createDmProtocolPickerSheetStyles } from '../styles/DmProtocolPickerSheet.styles';

interface Props {
  visible: boolean;
  selected?: DmProtocol;
  onSelect: (protocol: DmProtocol) => void;
  onClose: () => void;
  /** The contact being messaged: checks whether they can receive Marmot. */
  peer?: { pubkey: string; name?: string | null } | null;
}
const PROTOCOLS: DmProtocol[] = ['nip17', 'marmot', 'nip04'];

export default function DmProtocolPickerSheet({
  visible,
  selected,
  onSelect,
  onClose,
  peer,
}: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createDmProtocolPickerSheetStyles(colors), [colors]);
  const { availability, retry } = useMarmotAvailability(peer?.pubkey, visible);
  const peerName = peer?.name?.trim() || t('dmProtocol.availability.someone');
  // Greyed out but tappable: say why, and offer the protocol that works.
  const explainUnavailable = useCallback(() => {
    Alert.alert(
      t('dmProtocol.availability.unavailableTitle'),
      t('dmProtocol.availability.unavailable', { name: peerName }),
      [
        { text: t('dmProtocol.availability.cancel'), style: 'cancel' },
        { text: t('dmProtocol.availability.useNip17'), onPress: () => onSelect('nip17') },
      ],
    );
  }, [onSelect, peerName, t]);
  const sheetRef = useRef<BottomSheetModal>(null);
  useEffect(() => {
    if (visible) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );
  return (
    <BottomSheetModal
      ref={sheetRef}
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
      handleIndicatorStyle={styles.handle}
    >
      <BottomSheetView style={styles.content} testID="dm-protocol-picker-sheet">
        <Text style={styles.title}>{t('dmProtocol.title')}</Text>
        {PROTOCOLS.map((protocol) => {
          const disabled = !isDmProtocolAvailable(protocol);
          const marmot = protocol === 'marmot';
          const unavailable = marmot && availability === 'unavailable';
          const status =
            marmot && availability && availability !== 'available'
              ? ` ${t(`dmProtocol.availability.${availability}`, { name: peerName })}`
              : '';
          const label = `${DM_PROTOCOL_LABEL[protocol]}. ${t(`dmProtocol.${protocol}.badge`)}. ${t(`dmProtocol.${protocol}.description`)}${status}`;
          const content = (
            <>
              <View style={styles.heading}>
                <Text style={styles.name}>{DM_PROTOCOL_LABEL[protocol]}</Text>
                <Text style={styles.badge}>{t(`dmProtocol.${protocol}.badge`)}</Text>
                {selected === protocol && (
                  <View testID={`dm-protocol-selected-${protocol}`}>
                    <Check size={18} color={colors.courseTeal} />
                  </View>
                )}
              </View>
              {protocol === 'nip17' && (
                <Text style={styles.name}>{t('dmProtocol.privateMessages')}</Text>
              )}
              <Text style={styles.description}>{t(`dmProtocol.${protocol}.description`)}</Text>
              {marmot && (
                <MarmotAvailabilityNote
                  availability={availability}
                  name={peerName}
                  onRetry={retry}
                  styles={styles}
                  colors={colors}
                />
              )}
            </>
          );
          return disabled ? (
            <View
              key={protocol}
              style={[styles.option, styles.disabled]}
              accessible
              testID={`dm-protocol-option-${protocol}`}
              accessibilityLabel={label}
              accessibilityRole="button"
              accessibilityState={{ disabled: true, selected: selected === protocol }}
            >
              {content}
            </View>
          ) : (
            <TouchableOpacity
              key={protocol}
              style={unavailable ? [styles.option, styles.disabled] : styles.option}
              onPress={unavailable ? explainUnavailable : () => onSelect(protocol)}
              testID={`dm-protocol-option-${protocol}`}
              accessibilityLabel={label}
              accessibilityRole="button"
              accessibilityState={{ selected: selected === protocol }}
            >
              {content}
            </TouchableOpacity>
          );
        })}
      </BottomSheetView>
    </BottomSheetModal>
  );
}
