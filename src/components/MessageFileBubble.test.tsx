import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import MessageFileBubble from './MessageFileBubble';
import { __resetForTests } from '../services/mediaRevealStore';
import { usePdfPreview } from '../hooks/usePdfPreview';
import { Alert } from './BrandedAlert';
import { shareFileAttachment } from '../services/fileShare';
import { FileVerificationError } from '../services/fileDownload';
import { parseFileAttachment, parsePlainFileAttachment } from '../utils/fileAttachment';

const mockRetry = jest.fn();
jest.mock('../hooks/usePdfPreview', () => ({
  usePdfPreview: jest.fn((_file: unknown, enabled: boolean) => ({
    uri: null,
    status: enabled ? 'loading' : 'idle',
    retry: mockRetry,
  })),
}));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
  useTranslation: () => (key: string) => key,
}));
jest.mock('./BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('../services/fileShare', () => ({ shareFileAttachment: jest.fn(async () => {}) }));
const file = (name = 'invoice.pdf', mime = 'application/pdf') =>
  parseFileAttachment(
    '[FILE]' +
      JSON.stringify({
        name,
        mime,
        encrypted: false,
        url: 'https://example.com/f',
        size: 999,
        plaintextSha256: 'aa'.repeat(32),
      }),
  )!;
const bubble = (attachment = file()) =>
  render(<MessageFileBubble id="file" file={attachment} fromMe={false} footer={null} />);
beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
});
it('offers Save and Share for dangerous files and requires the explicit warning', async () => {
  let approved: boolean | undefined;
  (shareFileAttachment as jest.Mock).mockImplementationOnce(async (_file, confirm) => {
    approved = await confirm();
  });
  const ui = bubble(file('invoice.pdf.exe'));
  expect(ui.getByText('messageBubble.fileSave')).toBeTruthy();
  expect(ui.getByText('messageBubble.fileShare')).toBeTruthy();
  fireEvent.press(ui.getByTestId('file-share-file'));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
  const [title, body, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
  expect(title).toBe('messageBubble.fileWarningTitle');
  expect(body).toBe('messageBubble.fileWarning');
  expect(approved).toBeUndefined();
  buttons[1].onPress();
  await waitFor(() => expect(approved).toBe(true));
});
it('shows the localized verification failure after a hash mismatch', async () => {
  (shareFileAttachment as jest.Mock).mockRejectedValueOnce(new FileVerificationError());
  const ui = bubble();
  fireEvent.press(ui.getByTestId('file-share-file'));
  await waitFor(() => expect(ui.getByText('messageBubble.fileVerificationFailed')).toBeTruthy());
});
it('shows type mismatch and replaces declared MIME with the verified type', async () => {
  (shareFileAttachment as jest.Mock).mockImplementationOnce(async (_file, _confirm, verified) => {
    verified({ mime: 'application/octet-stream', size: 3 });
  });
  const ui = bubble(file('invoice.exe'));
  expect(ui.getByText('messageBubble.fileTypeMismatch')).toBeTruthy();
  fireEvent.press(ui.getByTestId('file-share-file'));
  await waitFor(() => expect(ui.getByText('EXE · messageBubble.fileBytes')).toBeTruthy());
  expect(ui.queryByText('application/pdf')).toBeNull();
});

it('explains unavailable hashless files and offers no share action', () => {
  const attachment = parseFileAttachment(
    '[FILE]' +
      JSON.stringify({
        name: 'invoice.pdf',
        mime: 'application/pdf',
        encrypted: false,
        url: 'https://example.com/f',
      }),
  )!;
  const ui = bubble(attachment);
  expect(ui.getByText('messageBubble.fileUnavailable')).toBeTruthy();
  expect(ui.queryByTestId('file-share-file')).toBeNull();
  expect(shareFileAttachment).not.toHaveBeenCalled();
});

it('requires stranger consent but auto-loads a trusted PDF', () => {
  const attachment = file();
  const ui = bubble(attachment);
  expect(usePdfPreview).toHaveBeenLastCalledWith(attachment, false);
  fireEvent.press(ui.getByTestId('chat-file-load-file'));
  expect(usePdfPreview).toHaveBeenLastCalledWith(attachment, true);
  ui.unmount();
  const trusted = render(
    <MessageFileBubble id="trusted" file={attachment} fromMe={false} autoLoad footer={null} />,
  );
  expect(usePdfPreview).toHaveBeenLastCalledWith(attachment, true);
  expect(trusted.queryByTestId('chat-file-load-trusted')).toBeNull();
});
it('never previews a dangerous file even from a trusted sender', () => {
  const attachment = file('invoice.pdf.exe');
  render(<MessageFileBubble id="danger" file={attachment} fromMe autoLoad footer={null} />);
  expect(usePdfPreview).toHaveBeenLastCalledWith(attachment, false);
});

it.each([false, true])(
  'requires a tap for plain links even with trust or ownership (fromMe=%s)',
  (fromMe) => {
    const attachment = parsePlainFileAttachment('https://example.com/invoice.pdf')!;
    const ui = render(
      <MessageFileBubble id="plain" file={attachment} fromMe={fromMe} autoLoad footer={null} />,
    );
    expect(usePdfPreview).toHaveBeenLastCalledWith(attachment, false);
    fireEvent.press(ui.getByTestId('chat-file-load-plain'));
    expect(usePdfPreview).toHaveBeenLastCalledWith(attachment, true);
  },
);
it('shows a mismatch discovered while sharing a plain link', async () => {
  (shareFileAttachment as jest.Mock).mockImplementationOnce(async (_file, _confirm, verified) => {
    verified({ mime: 'application/octet-stream', size: 3 });
  });
  const ui = bubble(parsePlainFileAttachment('https://example.com/invoice.pdf')!);
  expect(ui.queryByText('messageBubble.fileTypeMismatch')).toBeNull();
  fireEvent.press(ui.getByTestId('file-share-file'));
  await waitFor(() => expect(ui.getByText('messageBubble.fileTypeMismatch')).toBeTruthy());
});

it('holds a first-page box for a previewable PDF: tap to load, then loading', () => {
  const ui = bubble();
  expect(ui.getByTestId('chat-file-placeholder-file')).toBeTruthy();
  expect(ui.getByText('messageBubble.tapToLoadPdf')).toBeTruthy();
  expect(ui.queryByText('chatMenu.loadMedia')).toBeNull();
  fireEvent.press(ui.getByTestId('chat-file-load-file'));
  expect(ui.queryByTestId('chat-file-placeholder-file')).toBeNull();
  expect(ui.queryByText('messageBubble.tapToLoadPdf')).toBeNull();
});

it('offers a retry when the PDF failed to load', () => {
  jest.mocked(usePdfPreview).mockReturnValue({ uri: null, status: 'failed', retry: mockRetry });
  const ui = render(
    <MessageFileBubble id="failed" file={file()} fromMe={false} autoLoad footer={null} />,
  );
  expect(ui.getByText('messageBubble.pdfLoadFailed')).toBeTruthy();
  fireEvent.press(ui.getByTestId('chat-file-retry-failed'));
  expect(mockRetry).toHaveBeenCalledTimes(1);
});

it('keeps the text link for a PDF too big to preview', () => {
  jest.mocked(usePdfPreview).mockImplementation((_f, enabled) => ({
    uri: null,
    status: enabled ? 'none' : 'idle',
    retry: mockRetry,
  }));
  const big = { ...file(), size: 50 * 1024 * 1024 };
  const ui = bubble(big);
  expect(ui.queryByTestId('chat-file-placeholder-file')).toBeNull();
  expect(ui.getByText('chatMenu.loadMedia')).toBeTruthy();
});
