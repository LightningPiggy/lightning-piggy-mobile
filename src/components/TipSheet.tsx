import BrandedSpinner from './BrandedSpinner';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, BackHandler, ScrollView, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import ScannableQr from './ScannableQr';
import { Check } from 'lucide-react-native';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { satsToFiatString } from '../services/fiatService';
import { Course } from '../data/learnContent';
import { createTipSheetStyles } from '../styles/TipSheet.styles';

interface Props {
  visible: boolean;
  onClose: () => void;
  course: Course;
}

const TipSheet: React.FC<Props> = ({ visible, onClose, course }) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createTipSheetStyles(colors), [colors]);
  const { makeInvoice, refreshActiveBalance, balance, currency } = useWallet();
  const { btcPrice } = useWalletLive();
  const [invoice, setInvoice] = useState('');
  const [loading, setLoading] = useState(false);
  const [paymentReceived, setPaymentReceived] = useState(false);
  const [copied, setCopied] = useState(false);
  const intervalId = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevBalance = useRef<number | null>(null);
  const bottomSheetRef = useRef<BottomSheetModal>(null);

  const snapPoints = useMemo(() => ['90%'], []);

  const tipSats = course.satsReward;

  // Collect one key learning outcome per mission for the "quiz" section
  const quizTopics = course.missions.map((m) => m.learningOutcomes[0]?.text).filter(Boolean);

  // Open/close the sheet — intentionally depends only on `visible`.
  // Other values are read for initialisation, not as reactive triggers.
  useEffect(() => {
    if (visible) {
      prevBalance.current = balance;
      setInvoice('');
      setPaymentReceived(false);
      setCopied(false);
      setLoading(true);
      bottomSheetRef.current?.present();
      (async () => {
        try {
          const inv = await makeInvoice(
            tipSats,
            t('tipSheet.invoiceMemo', { title: course.title }),
          );
          setInvoice(inv);
          intervalId.current = setInterval(async () => {
            await refreshActiveBalance();
          }, 5000);
        } catch (error) {
          console.warn('Failed to create tip invoice:', error);
        } finally {
          setLoading(false);
        }
      })();
    } else {
      bottomSheetRef.current?.dismiss();
    }
    return () => {
      if (intervalId.current) {
        clearInterval(intervalId.current);
        intervalId.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Detect payment
  useEffect(() => {
    if (
      visible &&
      prevBalance.current !== null &&
      balance !== null &&
      balance > prevBalance.current
    ) {
      setPaymentReceived(true);
      if (intervalId.current) {
        clearInterval(intervalId.current);
        intervalId.current = null;
      }
    }
  }, [balance, visible]);

  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [visible, onClose]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleCopy = async () => {
    if (invoice) {
      await Clipboard.setStringAsync(invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async () => {
    if (invoice) {
      await Share.share({
        message: t('tipSheet.shareMessage', {
          amount: tipSats.toLocaleString(formatLocale),
          title: course.title,
          invoice,
        }),
      }).catch(() => {});
    }
  };

  if (!visible) return null;

  const fiatString = btcPrice ? satsToFiatString(tipSats, btcPrice, currency, formatLocale) : '';

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      onChange={handleSheetChange}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.sheetBackground}
    >
      <BottomSheetView style={styles.content}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* QR Code at top */}
          <View
            style={[
              styles.qrContainer,
              !loading && !paymentReceived && !!invoice && styles.qrContainerShowingQr,
            ]}
          >
            {loading ? (
              <BrandedSpinner size="large" />
            ) : paymentReceived ? (
              <View style={styles.successOverlay}>
                <Check size={48} color={colors.green} />
                <Text style={styles.successText}>{t('tipSheet.tipReceived')}</Text>
              </View>
            ) : invoice ? (
              <ScannableQr value={invoice} size={200} />
            ) : (
              <Text style={styles.errorText}>{t('tipSheet.couldNotGenerate')}</Text>
            )}
          </View>

          {/* Suggested tip amount */}
          <Text style={styles.amountLabel}>{t('tipSheet.suggestedTip')}</Text>
          <Text style={styles.amountSats}>
            {t('tipSheet.satsAmount', { amount: tipSats.toLocaleString(formatLocale) })}
          </Text>
          {fiatString ? <Text style={styles.amountFiat}>{fiatString}</Text> : null}

          {/* Copy / Share buttons */}
          {invoice && !paymentReceived && (
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.actionButton} onPress={handleCopy}>
                <Text style={styles.actionButtonText}>
                  {copied ? t('tipSheet.copied') : t('tipSheet.copyInvoice')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} onPress={handleShare}>
                <Text style={styles.actionButtonText}>{t('tipSheet.share')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Instructions */}
          <Text style={styles.instructionText}>{t('tipSheet.instructions')}</Text>

          {/* Quiz topics */}
          <View style={styles.quizSection}>
            <Text style={styles.quizTitle}>{t('tipSheet.quizTitle')}</Text>
            {quizTopics.map((topic, i) => (
              <View key={i} style={styles.quizRow}>
                <View style={styles.quizDot} />
                <Text style={styles.quizText}>{topic}</Text>
              </View>
            ))}
          </View>

          {/* Close button */}
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>
              {paymentReceived ? t('tipSheet.done') : t('tipSheet.close')}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </BottomSheetView>
    </BottomSheetModal>
  );
};

export default TipSheet;
