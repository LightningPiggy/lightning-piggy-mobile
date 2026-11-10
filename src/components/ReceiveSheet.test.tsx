import React from 'react';
import { bech32 } from 'bech32';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import ReceiveSheet from './ReceiveSheet';

// Boundary test for the real ReceiveSheet: native sheet/QR, contexts and child
// sheets are stubbed; the sheet's own open / wallet-switch effects and invoice
// generation run for real. HomeSheets retains the sheet across opens, so a
// slow address/invoice request from one open or wallet must never land on the
// QR of a later one.

// Runs once from the sheet's next commit (layout phase): lets a test settle a
// request after React commits an update but before its passive effects flush.
let mockDuringCommit: (() => void) | null = null;
jest.mock('@gorhom/bottom-sheet', () => {
  const R = jest.requireActual('react');
  const RN = jest.requireActual('react-native');
  const Pass = ({ children }: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, children);
  return {
    BottomSheetModal: R.forwardRef(function Modal(
      { children }: { children?: React.ReactNode },
      ref: React.Ref<unknown>,
    ) {
      R.useImperativeHandle(ref, () => ({ present: jest.fn(), dismiss: jest.fn() }));
      R.useLayoutEffect(() => {
        const run = mockDuringCommit;
        mockDuringCommit = null;
        run?.();
      });
      return R.createElement(RN.View, null, children);
    }),
    BottomSheetBackdrop: () => null,
    BottomSheetView: Pass,
  };
});
// Every committed QR value, so a test can catch a stale frame that a later
// effect overwrites.
const mockQrRenders: string[] = [];
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = jest.requireActual('react-native');
  return function MockQrCode({ value }: { value: string }) {
    mockQrRenders.push(value);
    return <Text testID="receive-qr">{value}</Text>;
  };
});
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
const mockOpenWithdraw = jest.fn((..._args: unknown[]) => true);
jest.mock('./LnurlWithdrawSheet', () => ({
  openLnurlWithdrawSheet: (...args: unknown[]) => mockOpenWithdraw(...args),
}));
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
}));
let mockScan: ((event: { data: string }) => void) | null = null;
jest.mock('./SendScanPane', () => ({
  __esModule: true,
  default: ({ onBarcodeScanned }: { onBarcodeScanned: typeof mockScan }) => {
    mockScan = onBarcodeScanned;
    return null;
  },
}));

jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
jest.mock('../styles/ReceiveSheet.styles', () => ({
  createReceiveSheetStyles: () => new Proxy({}, { get: () => ({}) }),
}));

type Wallet = { id: string; alias: string; walletType: 'onchain' | 'nwc'; isConnected: boolean };
const mockWallets: Wallet[] = [
  { id: 'A', alias: 'Alpha', walletType: 'onchain', isConnected: true },
  { id: 'B', alias: 'Bravo', walletType: 'onchain', isConnected: true },
  { id: 'LA', alias: 'Lima', walletType: 'nwc', isConnected: true },
  { id: 'LB', alias: 'Lynx', walletType: 'nwc', isConnected: true },
];
let mockActiveWalletId = 'A';

// Per-wallet deferred responses, resolved explicitly by each test.
const mockPending: Record<string, ((value: string) => void)[]> = {};
const deferFor = (id: string) =>
  new Promise<string>((resolve) => (mockPending[id] ??= []).push(resolve));
const resolveFor = async (id: string, value: string) => {
  const waiting = mockPending[id] ?? [];
  expect(waiting.length).toBeGreaterThan(0);
  delete mockPending[id];
  await act(async () => waiting.forEach((resolve) => resolve(value)));
};
// Synchronous variant for use inside a commit (see mockDuringCommit).
const resolveNow = (id: string, value: string) => {
  const waiting = mockPending[id] ?? [];
  delete mockPending[id];
  waiting.forEach((resolve) => resolve(value));
};

const mockGetReceiveAddress = jest.fn((id: string) => deferFor(id));
const mockMakeInvoice = jest.fn((id: string) => deferFor(id));
const mockExpectPayment = jest.fn();
let mockLastIncoming: Record<string, unknown> | null = null;
jest.mock('../contexts/WalletContext', () => ({
  useWallet: () => ({
    makeInvoiceForWallet: mockMakeInvoice,
    refreshBalanceForWallet: jest.fn(),
    activeWalletId: mockActiveWalletId,
    activeWallet: mockWallets.find((w) => w.id === mockActiveWalletId),
    wallets: mockWallets,
    currency: 'USD',
    getReceiveAddress: mockGetReceiveAddress,
    expectPayment: mockExpectPayment,
  }),
  useWalletLive: () => ({ btcPrice: null, lastIncomingPayment: mockLastIncoming }),
}));
jest.mock('../utils/bolt11', () => ({ paymentHashFromBolt11: (inv: string) => `hash-${inv}` }));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ sendDirectMessage: jest.fn() }),
  useNostrContacts: () => ({ contacts: [] }),
}));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => new Proxy({}, { get: () => '#000' }),
}));
jest.mock('../contexts/LocaleContext', () =>
  (() => {
    const context = { useTranslation: () => (k: string) => k };
    return {
      ...context,
      useLocale: () => ({ t: context.useTranslation(), locale: 'en', formatLocale: 'en' }),
    };
  })(),
);
jest.mock('./BrandedToast', () => ({ show: jest.fn() }));
jest.mock('../services/fiatService', () => ({ satsToFiat: () => 0, formatFiat: () => '' }));
jest.mock('./FriendPickerSheet', () => () => null);
jest.mock('./BoltzReceiveSheet', () => () => null);
let mockConfirmAmount: ((sats: number) => void) | null = null;
jest.mock('./AmountEntryScreen', () => (props: { onConfirm: (sats: number) => void }) => {
  mockConfirmAmount = props.onConfirm;
  return null;
});

const onClose = jest.fn();
const qrValue = () => screen.queryByTestId('receive-qr')?.props.children ?? null;

beforeEach(() => {
  mockActiveWalletId = 'A';
  mockConfirmAmount = null;
  mockDuringCommit = null;
  mockQrRenders.length = 0;
  for (const id of Object.keys(mockPending)) delete mockPending[id];
  jest.clearAllMocks();
  mockGetReceiveAddress.mockImplementation((id: string) => deferFor(id));
});

// Open on wallet A, close, reopen on wallet B — with A's request still pending.
function openAThenReopenB() {
  const view = render(<ReceiveSheet visible onClose={onClose} />);
  view.rerender(<ReceiveSheet visible={false} onClose={onClose} />);
  mockActiveWalletId = 'B';
  view.rerender(<ReceiveSheet visible onClose={onClose} />);
  // Exactly one request per open, for that open's wallet.
  expect(mockGetReceiveAddress.mock.calls).toEqual([['A'], ['B']]);
}

// Owns `visible` so a test can flip it OUTSIDE act(), as a production state
// update does. React then commits and flushes passive effects in separate
// scheduler tasks, so a request settled during the commit (mockDuringCommit)
// runs its continuation in between — exactly the window a token bumped from a
// passive effect leaves open.
let setHarnessVisible: (visible: boolean) => void = () => {};
// A closed sheet renders nothing, so the harness commits its own probe too.
function CommitProbe() {
  React.useLayoutEffect(() => {
    const run = mockDuringCommit;
    mockDuringCommit = null;
    run?.();
  });
  return null;
}
function Harness() {
  const [visible, setVisible] = React.useState(true);
  setHarnessVisible = setVisible;
  return (
    <>
      <ReceiveSheet visible={visible} onClose={onClose} />
      <CommitProbe />
    </>
  );
}
async function outsideAct(update: () => void) {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    update();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}
// The composite's onPress, callable outside act() (fireEvent always wraps).
function onPressOf(testID: string): () => void {
  let node = screen.getByTestId(testID);
  while (!node.props.onPress && node.parent) node = node.parent;
  return node.props.onPress;
}

it('first open makes one address request and shows it even if a duplicate would fail', async () => {
  mockGetReceiveAddress
    .mockImplementationOnce(() => Promise.resolve('bc1qalpha000000'))
    .mockImplementation(() => Promise.reject(new Error('rate limited')));
  render(<ReceiveSheet visible onClose={onClose} />);
  await act(async () => {});
  expect(mockGetReceiveAddress).toHaveBeenCalledTimes(1);
  expect(qrValue()).toBe('bitcoin:bc1qalpha000000');
});

it('reopening on the same wallet makes one fresh request', async () => {
  const view = render(<ReceiveSheet visible onClose={onClose} />);
  await resolveFor('A', 'bc1qalpha000000');
  view.rerender(<ReceiveSheet visible={false} onClose={onClose} />);
  view.rerender(<ReceiveSheet visible onClose={onClose} />);
  expect(mockGetReceiveAddress.mock.calls).toEqual([['A'], ['A']]);
  await resolveFor('A', 'bc1qalpha000001');
  expect(qrValue()).toBe('bitcoin:bc1qalpha000001');
});

it("never commits the previous wallet's address under a dropdown switch", async () => {
  render(<ReceiveSheet visible onClose={onClose} />);
  await resolveFor('A', 'bc1qalpha000000');
  fireEvent.press(screen.getByTestId('receive-wallet-dropdown-toggle'));
  mockQrRenders.length = 0;
  fireEvent.press(screen.getByTestId('receive-wallet-option-B'));
  // Cleared in the switch's own commit, not one effect later.
  expect(mockQrRenders).toEqual([]);
  expect(mockGetReceiveAddress.mock.calls).toEqual([['A'], ['B']]);
  await resolveFor('B', 'bc1qbravo000000');
  expect(qrValue()).toBe('bitcoin:bc1qbravo000000');
});

it('drops an invoice that settles after the close commits but before its effects run', async () => {
  mockActiveWalletId = 'LA';
  render(<Harness />);
  act(() => mockConfirmAmount?.(1000));
  expect(mockMakeInvoice).toHaveBeenCalledWith('LA', 1000, expect.any(String));

  mockDuringCommit = () => resolveNow('LA', 'lnbc-alpha');
  await outsideAct(() => setHarnessVisible(false));
  expect(mockDuringCommit).toBeNull();
  // The closed session's invoice is never watched for payment.
  expect(mockExpectPayment).not.toHaveBeenCalled();
});

it('drops an invoice that settles after a dropdown switch commits but before its effects run', async () => {
  mockActiveWalletId = 'LA';
  render(<Harness />);
  act(() => mockConfirmAmount?.(1000));
  fireEvent.press(screen.getByTestId('receive-wallet-dropdown-toggle'));
  const selectLB = onPressOf('receive-wallet-option-LB');

  mockDuringCommit = () => resolveNow('LA', 'lnbc-alpha');
  await outsideAct(selectLB);
  expect(mockDuringCommit).toBeNull();
  expect(mockExpectPayment).not.toHaveBeenCalled();
  expect(mockQrRenders).not.toContain('lnbc-alpha');
});

it('drops a delayed wallet-A address that resolves after reopening on wallet B', async () => {
  openAThenReopenB();
  await resolveFor('B', 'bc1qbravo000000');
  expect(qrValue()).toBe('bitcoin:bc1qbravo000000');
  await resolveFor('A', 'bc1qalpha000000');
  expect(qrValue()).toBe('bitcoin:bc1qbravo000000');
});

it("does not show wallet A's address while wallet B's is still loading", async () => {
  openAThenReopenB();
  await resolveFor('A', 'bc1qalpha000000');
  expect(qrValue()).toBeNull();
  await resolveFor('B', 'bc1qbravo000000');
  expect(qrValue()).toBe('bitcoin:bc1qbravo000000');
});

it("drops the previous wallet's late address after a dropdown switch in one open", async () => {
  render(<ReceiveSheet visible onClose={onClose} />);
  fireEvent.press(screen.getByTestId('receive-wallet-dropdown-toggle'));
  fireEvent.press(screen.getByTestId('receive-wallet-option-B'));
  await resolveFor('B', 'bc1qbravo000000');
  await resolveFor('A', 'bc1qalpha000000');
  expect(qrValue()).toBe('bitcoin:bc1qbravo000000');
});

it('drops a delayed invoice minted in a previous open for another wallet', async () => {
  mockActiveWalletId = 'LA';
  const view = render(<ReceiveSheet visible onClose={onClose} />);
  act(() => mockConfirmAmount?.(1000));
  expect(mockMakeInvoice).toHaveBeenCalledWith('LA', 1000, expect.any(String));

  view.rerender(<ReceiveSheet visible={false} onClose={onClose} />);
  mockActiveWalletId = 'LB';
  view.rerender(<ReceiveSheet visible onClose={onClose} />);
  act(() => mockConfirmAmount?.(2000));
  expect(mockMakeInvoice).toHaveBeenCalledWith('LB', 2000, expect.any(String));

  await resolveFor('LB', 'lnbc-bravo');
  await resolveFor('LA', 'lnbc-alpha');
  expect(qrValue()).toBe('lnbc-bravo');
  // The stale invoice was never shown, so it is not watched for payment.
  expect(mockExpectPayment).toHaveBeenCalledTimes(1);
  expect(mockExpectPayment).toHaveBeenCalledWith('LB', 'hash-lnbc-bravo', 2000);
});

it('a stale invoice request does not hide the spinner of the current one', async () => {
  mockActiveWalletId = 'LA';
  const view = render(<ReceiveSheet visible onClose={onClose} />);
  act(() => mockConfirmAmount?.(1000));
  view.rerender(<ReceiveSheet visible={false} onClose={onClose} />);
  mockActiveWalletId = 'LB';
  view.rerender(<ReceiveSheet visible onClose={onClose} />);
  act(() => mockConfirmAmount?.(2000));

  await resolveFor('LA', 'lnbc-alpha');
  expect(qrValue()).toBeNull();
  expect(screen.queryByTestId('branded-spinner')).not.toBeNull();
  await resolveFor('LB', 'lnbc-bravo');
  expect(qrValue()).toBe('lnbc-bravo');
});

it('selecting the displayed wallet preserves its in-flight address request', async () => {
  render(<ReceiveSheet visible onClose={onClose} />);
  fireEvent.press(screen.getByTestId('receive-wallet-dropdown-toggle'));
  fireEvent.press(screen.getByTestId('receive-wallet-option-A'));
  expect(mockGetReceiveAddress.mock.calls).toEqual([['A']]);
  await resolveFor('A', 'bc1qalpha000000');
  expect(qrValue()).toBe('bitcoin:bc1qalpha000000');
});

describe('withdraw QR intake', () => {
  beforeEach(() => {
    mockActiveWalletId = 'LB';
    mockOpenWithdraw.mockClear();
    mockScan = null;
  });

  it.each([
    bech32
      .encode(
        'lnurl',
        bech32.toWords(Array.from(new TextEncoder().encode('https://example.com/voucher'))),
        2000,
      )
      .toUpperCase(),
    'lnurlw://example.com/voucher',
    'lightning:lnurlw://example.com/voucher',
    'https://example.com/voucher',
  ])('opens a claim for the selected Receive wallet: %s', (data) => {
    const onClose = jest.fn();
    render(<ReceiveSheet visible onClose={onClose} />);
    fireEvent.press(screen.getByTestId('receive-scan-to-claim'));
    act(() => {
      mockScan!({ data });
      mockScan!({ data });
    });
    expect(mockOpenWithdraw).toHaveBeenCalledTimes(1);
    expect(mockOpenWithdraw).toHaveBeenCalledWith(data, 'LB', true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockMakeInvoice).not.toHaveBeenCalled();
  });

  it('rejects a payment invoice and keeps the scanner usable', () => {
    render(<ReceiveSheet visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByTestId('receive-scan-to-claim'));
    act(() => mockScan!({ data: 'lnbc123invalid' }));
    expect(mockOpenWithdraw).not.toHaveBeenCalled();
    act(() => mockScan!({ data: 'lnurlw://example.com/voucher' }));
    expect(mockOpenWithdraw).toHaveBeenCalledTimes(1);
  });

  it('ignores camera callbacks after cancelling the scanner', () => {
    render(<ReceiveSheet visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByTestId('receive-scan-to-claim'));
    const lateCallback = mockScan!;
    fireEvent.press(screen.getByTestId('receive-scan-to-claim'));
    act(() => lateCallback({ data: 'lnurlw://example.com/voucher' }));
    expect(mockOpenWithdraw).not.toHaveBeenCalled();
  });

  it('does not offer a Lightning voucher for an on-chain wallet', () => {
    mockActiveWalletId = 'A';
    render(<ReceiveSheet visible onClose={jest.fn()} />);
    expect(screen.queryByTestId('receive-scan-to-claim')).toBeNull();
  });
});

it('ignores a late camera callback after Receive closes, and can rescan on reopen', () => {
  mockActiveWalletId = 'LB';
  mockOpenWithdraw.mockClear();
  const onClose = jest.fn();
  const { rerender } = render(<ReceiveSheet visible onClose={onClose} />);
  fireEvent.press(screen.getByTestId('receive-scan-to-claim'));
  const lateCallback = mockScan!;
  rerender(<ReceiveSheet visible={false} onClose={onClose} />);
  act(() => lateCallback({ data: 'lnurlw://example.com/voucher' }));
  expect(mockOpenWithdraw).not.toHaveBeenCalled();
  rerender(<ReceiveSheet visible onClose={onClose} />);
  fireEvent.press(screen.getByTestId('receive-scan-to-claim'));
  act(() => mockScan!({ data: 'lnurlw://example.com/voucher' }));
  expect(mockOpenWithdraw).toHaveBeenCalledTimes(1);
});

it('exposes copy/share as disabled buttons until an address is ready', async () => {
  render(<ReceiveSheet visible onClose={onClose} />);
  for (const name of ['receiveSheet.copy', 'receiveSheet.share']) {
    expect(screen.getByRole('button', { name, disabled: true })).toBeTruthy();
  }
  await resolveFor('A', 'bc1qalpha000000');
  expect(screen.getByRole('image', { name: 'receiveSheet.paymentQr' })).toBeTruthy();
  for (const name of ['receiveSheet.copy', 'receiveSheet.share']) {
    expect(screen.getByRole('button', { name, disabled: false })).toBeTruthy();
  }
});

describe('received checkmark vs catch-up receipts', () => {
  afterEach(() => {
    mockLastIncoming = null;
  });
  const showAddress = async () => {
    mockGetReceiveAddress.mockImplementation(() => Promise.resolve('bc1qalpha000000'));
    render(<ReceiveSheet visible onClose={onClose} />);
    await act(async () => {});
  };

  it('ignores a receipt that settled long before it was noticed (found on app open)', async () => {
    const at = Date.now();
    mockLastIncoming = { walletId: 'A', amountSats: 21, at, settledAt: at / 1000 - 3 * 3600 };
    await showAddress();
    expect(screen.queryByText('\u2713')).toBeNull();
  });

  it('still ticks for a live receipt', async () => {
    const at = Date.now();
    mockLastIncoming = { walletId: 'A', amountSats: 21, at, settledAt: at / 1000 - 5 };
    await showAddress();
    expect(screen.getByText('\u2713')).toBeTruthy();
  });
});

// #1849: a home-screen widget tap re-opens Receive while it's already up on
// another wallet. The new openKey must re-capture the now-active wallet, and
// the old wallet's late address must never show.
it('re-captures the active wallet when re-opened while visible (widget tap)', async () => {
  const view = render(<ReceiveSheet visible openKey={1} onClose={onClose} />);
  mockActiveWalletId = 'B';
  view.rerender(<ReceiveSheet visible openKey={2} onClose={onClose} />);
  expect(mockGetReceiveAddress.mock.calls).toEqual([['A'], ['B']]);
  await resolveFor('B', 'bc1qbravo000000');
  await resolveFor('A', 'bc1qalpha000000');
  expect(qrValue()).toBe('bitcoin:bc1qbravo000000');
});

it('an unrelated re-render with the same openKey keeps the captured wallet', async () => {
  const view = render(<ReceiveSheet visible openKey={1} onClose={onClose} />);
  mockActiveWalletId = 'B';
  view.rerender(<ReceiveSheet visible openKey={1} onClose={onClose} />);
  expect(mockGetReceiveAddress.mock.calls).toEqual([['A']]);
});
