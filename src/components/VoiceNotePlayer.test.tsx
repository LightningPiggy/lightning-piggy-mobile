import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  captureDecryptedMediaSession,
  resolveDecryptedMedia,
} from '../services/decryptedMediaCache';
import { setAudioModeAsync } from 'expo-audio';
import VoiceNotePlayer from './VoiceNotePlayer';
import { resolveRemoteMedia } from '../services/remoteMediaCache';
import { __resetForTests } from '../services/mediaRevealStore';

const mockPlay = jest.fn();
const mockPlayer = { play: mockPlay, pause: jest.fn(), seekTo: jest.fn() };
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => mockPlayer,
  useAudioPlayerStatus: () => ({ playing: false, duration: 0, currentTime: 0 }),
  setAudioModeAsync: jest.fn(async () => {}),
}));
jest.mock('../hooks/useActivePubkey', () => ({ useActivePubkey: () => 'alice' }));
jest.mock('../services/remoteMediaCache', () => ({ resolveRemoteMedia: jest.fn() }));
jest.mock('../services/decryptedMediaCache', () => ({
  captureDecryptedMediaSession: jest.fn((owner = 'alice') => ({ owner, assertCurrent: jest.fn() })),
  resolveDecryptedMedia: jest.fn(),
  DecryptedMediaCancelledError: class extends Error {},
}));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({ useLocale: () => ({ t: (key: string) => key }) }));
jest.mock('./OutgoingBubbleBackground', () => () => null);
beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
});
it.each([false, true])(
  'retries a failed voice note on the next Play tap (autoLoad=%s)',
  async (autoLoad) => {
    jest
      .mocked(resolveRemoteMedia)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('file:///alice/voice');
    const view = render(
      <VoiceNotePlayer
        url="https://example.com/voice.mp3"
        fromMe={false}
        createdAt={1}
        autoLoad={autoLoad}
        testID="voice"
      />,
    );
    if (!autoLoad) {
      expect(resolveRemoteMedia).not.toHaveBeenCalled();
      await act(async () => fireEvent.press(view.getByTestId('voice-toggle')));
    }
    await waitFor(() => expect(view.getByText('--:--')).toBeTruthy());
    await act(async () => fireEvent.press(view.getByTestId('voice-toggle')));
    await waitFor(() => expect(mockPlay).toHaveBeenCalledTimes(1));
    expect(resolveRemoteMedia).toHaveBeenCalledTimes(2);
    expect(view.queryByText('--:--')).toBeNull();
  },
);

it('cancels encrypted playback if the session changes while setting audio mode', async () => {
  let current = true;
  jest.mocked(captureDecryptedMediaSession).mockReturnValueOnce({
    owner: 'alice',
    assertCurrent: () => {
      if (!current) throw new Error('cancelled');
    },
  });
  jest.mocked(setAudioModeAsync).mockImplementationOnce(async () => {
    current = false;
  });
  const view = render(
    <VoiceNotePlayer
      url="https://example.com/voice"
      fromMe={false}
      createdAt={1}
      encrypted
      keyHex="key"
      nonceHex="nonce"
      testID="voice"
    />,
  );
  await act(async () => fireEvent.press(view.getByTestId('voice-toggle')));
  expect(resolveDecryptedMedia).not.toHaveBeenCalled();
  expect(mockPlay).not.toHaveBeenCalled();
});
it('passes the initiating owner to encrypted voice resolution', async () => {
  jest.mocked(resolveDecryptedMedia).mockResolvedValueOnce('file:///alice/voice');
  const view = render(
    <VoiceNotePlayer
      url="https://example.com/voice"
      fromMe={false}
      createdAt={1}
      encrypted
      keyHex="key"
      nonceHex="nonce"
      testID="voice"
    />,
  );
  await act(async () => fireEvent.press(view.getByTestId('voice-toggle')));
  expect(resolveDecryptedMedia).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'voice' }),
    'alice',
  );
});
