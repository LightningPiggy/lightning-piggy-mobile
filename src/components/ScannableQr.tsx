import React from 'react';
import QRCode from 'react-native-qrcode-svg';
import { qrPayload } from '../utils/qrPayload';

interface Props {
  value: string;
  size: number;
  testID?: string;
}

// Black on white with a white margin inside `size`, so scanners find the code's edges on a dark card too (dark mode left none).
export default function ScannableQr({ value, size, testID }: Props) {
  return (
    <QRCode
      value={qrPayload(value)}
      size={size}
      quietZone={Math.round(size * 0.06)}
      backgroundColor="#FFFFFF"
      color="#000000"
      testID={testID}
    />
  );
}
