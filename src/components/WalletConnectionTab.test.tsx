import React from 'react';
import { render } from '@testing-library/react-native';
import { createI18nInstance } from '../i18n';
import { useWalletSecretGate } from '../hooks/useWalletSecretGate';
import WalletConnectionTab from './WalletConnectionTab';

const XPUB =
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz';

jest.mock('../hooks/useWalletSecretGate', () => ({
  useWalletSecretGate: jest.fn(() => ({
    unlocked: false,
    busy: false,
    authFailed: false,
    reveal: jest.fn(async () => false),
    copy: jest.fn(async () => false),
  })),
}));
jest.mock('../services/sensitiveClipboard', () => ({ canCopySensitiveText: () => true }));
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));
jest.mock('react-native-qrcode-svg', () => () => null);
jest.mock('./SettingsRow', () => () => null);

describe('on-chain xpub on the Connection tab (#1833)', () => {
  it('keeps the xpub masked and gates the screen until the device is unlocked', () => {
    const i18n = createI18nInstance('en');
    const { queryByText } = render(
      <WalletConnectionTab
        styles={{} as React.ComponentProps<typeof WalletConnectionTab>['styles']}
        colors={{} as React.ComponentProps<typeof WalletConnectionTab>['colors']}
        t={(scope, options) => i18n.t(scope, options)}
        walletType="onchain"
        walletId="wallet-1"
        screenFocused
        xpubDisplay={XPUB}
        relayUrl={null}
        nwcConnection={null}
        nwcRevealed={false}
        onToggleNwcRevealed={jest.fn()}
        nwcQrShown={false}
        onToggleNwcQr={jest.fn()}
        coinosRecovery={null}
        passwordRevealed={false}
        onTogglePasswordRevealed={jest.fn()}
        recoveryError={null}
        onShare={jest.fn()}
      />,
    );

    expect(useWalletSecretGate).toHaveBeenLastCalledWith(true, 'wallet-1');
    expect(queryByText(XPUB)).toBeNull();
  });
});
