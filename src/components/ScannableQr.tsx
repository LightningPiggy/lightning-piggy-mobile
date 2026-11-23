import React, { useMemo, useState } from 'react';
import { Modal, Pressable, Text, useWindowDimensions } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTranslation } from '../contexts/LocaleContext';
import { createScannableQrStyles } from '../styles/ScannableQr.styles';
import { qrPayload } from '../utils/qrPayload';

interface Props {
  value: string;
  size: number;
  testID?: string;
  /** Tap to show the code full screen, for phones that struggle with a small one (default on). */
  expandable?: boolean;
}

// White margin inside `size`, so scanners find the code's edges on a dark card too.
const quietZoneFor = (size: number) => Math.round(size * 0.06);

function Code({ value, size, testID }: { value: string; size: number; testID?: string }) {
  return (
    <QRCode
      value={qrPayload(value)}
      size={size}
      quietZone={quietZoneFor(size)}
      backgroundColor="#FFFFFF"
      color="#000000"
      testID={testID}
    />
  );
}

export default function ScannableQr({ value, size, testID, expandable = true }: Props) {
  const t = useTranslation();
  const styles = useMemo(() => createScannableQrStyles(), []);
  const { width, height } = useWindowDimensions();
  const [fullScreen, setFullScreen] = useState(false);
  if (!expandable) return <Code value={value} size={size} testID={testID} />;
  // The whole screen is white, so the full-size code keeps a wide quiet zone beyond its own margin.
  const fullSize = Math.floor(Math.min(width, height) - 48);
  return (
    <>
      <Pressable
        onPress={() => setFullScreen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('scannableQr.showFullScreen')}
        testID={testID ? `${testID}-expand` : 'qr-expand'}
      >
        <Code value={value} size={size} testID={testID} />
      </Pressable>
      <Modal
        visible={fullScreen}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setFullScreen(false)}
      >
        <Pressable
          style={styles.fullScreen}
          onPress={() => setFullScreen(false)}
          accessibilityRole="button"
          accessibilityLabel={t('scannableQr.tapToClose')}
          testID="qr-fullscreen"
        >
          <Code value={value} size={fullSize} />
          <Text style={styles.hint}>{t('scannableQr.tapToClose')}</Text>
        </Pressable>
      </Modal>
    </>
  );
}
