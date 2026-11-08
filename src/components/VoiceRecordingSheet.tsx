import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, BackHandler, Linking } from 'react-native';
import { Mic, Square, Send, X, Play, Pause } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import {
  useAudioRecorder,
  useAudioPlayer,
  useAudioPlayerStatus,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { getInfoAsync } from 'expo-file-system/legacy';
import { Alert } from './BrandedAlert';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import type { Palette } from '../styles/palettes';
import {
  createVoiceRecordingSheetStyles,
  voiceWaveformStyles,
} from '../styles/VoiceRecordingSheet.styles';
import { useRecorderStatusWhileActive } from '../hooks/useRecorderStatusWhileActive';

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * Called once the user taps Send. The parent uploads `uri` to Blossom and
   * sends the resulting URL as the message body — same path as image / GIF
   * sends today (#235). Resolve `false` when nothing was sent, so the
   * sheet lets the user tap Send again with the same recording.
   */
  onSend: (uri: string, durationMs?: number) => void | boolean | Promise<void | boolean>;
  /**
   * When true, the Send button shows a spinner and stays disabled
   * while the parent's upload + post is in flight. Cancel only
   * dismisses the sheet — it does NOT abort an in-flight upload, so
   * a tap on Cancel during `sending` may still result in the voice
   * note posting once the parent's `onSend` resolves. (Aborting
   * an in-flight upload would require threading an AbortSignal
   * through `uploadBlob`, tracked as a follow-up.)
   */
  sending?: boolean;
}

const MAX_RECORDING_SECONDS = 60;

// Soft cap below typical Blossom server limits (often 25-100 MB) to
// fail fast with a friendly error rather than waste bandwidth on an
// upload the server will reject. Bump this when you know your default
// Blossom server's advertised limit is larger.
const MAX_VOICE_NOTE_SIZE_BYTES = 5 * 1024 * 1024;

// Fixed bar count for the WhatsApp-style review waveform. We average the
// captured metering samples into this many buckets so the wave looks
// consistent whether the clip is 2 s or 60 s.
const WAVEFORM_BARS = 40;

/**
 * Average a variable-length metering history (0-1 loudness samples
 * captured at ~5 Hz while recording) into a fixed number of bars.
 */
function bucketMetering(history: number[], bars: number): number[] {
  if (history.length === 0) return [];
  // Always emit exactly `bars` values so the waveform (and the playback
  // `progress` mapping over it) stays consistent regardless of clip length.
  // The loop below stretches a short history (size < 1 repeats samples) just
  // as it averages a long one, so we must NOT early-return the raw history
  // for short clips — that would render fewer than `bars` bars.
  const out: number[] = [];
  const size = history.length / bars;
  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i * size);
    const end = Math.max(start + 1, Math.floor((i + 1) * size));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < history.length; j++) {
      sum += history[j];
      n += 1;
    }
    out.push(n ? sum / n : 0);
  }
  return out;
}

/**
 * WhatsApp-style waveform. `progress` (0-1) paints the played portion in
 * brand pink and the rest in the divider grey, so it doubles as a
 * playback scrubber. Decorative — the time label carries the duration.
 */
const Waveform: React.FC<{
  data: number[];
  progress: number;
  colors: Palette;
  /** How many bars to render. Defaults to the full `WAVEFORM_BARS` (the static
   *  review waveform). While recording, the caller passes a smaller, time-
   *  proportional count so the left-aligned waveform visibly grows toward the
   *  right, reaching full width at the 60 s cap. */
  barCount?: number;
}> = ({ data, progress, colors, barCount = WAVEFORM_BARS }) => {
  const t = useTranslation();
  const bars = useMemo(() => bucketMetering(data, barCount), [data, barCount]);
  if (bars.length === 0) return null;
  const played = Math.round(progress * bars.length);
  return (
    <View
      style={voiceWaveformStyles.row}
      accessibilityLabel={t('voiceRecordingSheet.waveformAccessibility')}
    >
      {bars.map((v, i) => (
        <View
          key={i}
          style={[
            voiceWaveformStyles.bar,
            {
              height: 3 + v * 28,
              backgroundColor: i < played ? colors.brandPink : colors.divider,
            },
          ]}
        />
      ))}
    </View>
  );
};

const fmtTime = (totalSeconds: number) => {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
};

/**
 * In-app voice-note recording sheet (#235). Tap-to-toggle: the big mic
 * button starts recording on first tap, switches to a stop icon while
 * recording, and the elapsed-time display + animated pulse confirm the
 * mic is live. A 60 second hard cap auto-stops the recording so the
 * resulting `.m4a` stays under ~1 MB.
 *
 * After stopping, a WhatsApp-style review row (play/pause + waveform +
 * time) lets the user listen back before sending. The waveform is built
 * from the loudness samples captured during recording.
 *
 * The screens render this sheet permanently and drive it with the
 * `visible` prop: `present()` on open, `dismiss()` on close — the
 * component is NOT unmounted between opens. Session state (recorded URI,
 * metering, send guard) is therefore reset on each open, and every close
 * path (Cancel, hardware-back, pan-down dismiss) routes through the same
 * teardown so `recorder.stop()` always releases the mic — a back-out
 * mid-recording can't leave it live off-screen.
 *
 * The recorded clip is AES-256-GCM-encrypted on send (NIP-17 kind 15);
 * both sender and recipient play it inline via VoiceNotePlayer /
 * MessageBubble.
 */
const VoiceRecordingSheet: React.FC<Props> = ({ visible, onClose, onSend, sending = false }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createVoiceRecordingSheetStyles(colors), [colors]);
  const sheetRef = useRef<BottomSheetModal>(null);
  // No explicit snapPoints — gorhom v5 defaults `enableDynamicSizing` to
  // true and sizes the sheet to its content intrinsically (BottomSheetView
  // measures the height). A literal 'CONTENT_HEIGHT' snap point is not a
  // valid value and the library throws on open, so we omit snapPoints
  // entirely (matches ContactProfileSheet / AccountSwitcherSheet).

  // The recorder hook re-uses the same native recorder across renders.
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  // Track the recorded file URI captured at stop-time so the Send
  // handler doesn't race a still-finalising recorder. Cleared on every
  // open so a previous session's URI can't leak to a new send.
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  // Loudness samples (0-1) captured while recording — the source for the
  // review waveform. Reset on every open / re-record.
  const [meteringHistory, setMeteringHistory] = useState<number[]>([]);

  // Playback of the just-recorded clip so the user can listen back
  // before sending. Passing `undefined` while there's no recording keeps
  // the player idle; it loads the file once `recordedUri` is set.
  const player = useAudioPlayer(recordedUri ?? undefined);
  const playerStatus = useAudioPlayerStatus(player);
  const isPlaying = playerStatus?.playing ?? false;
  const playbackDuration =
    playerStatus?.duration && isFinite(playerStatus.duration) ? playerStatus.duration : 0;
  const playbackCurrent = playerStatus?.currentTime ?? 0;
  const playbackProgress =
    playbackDuration > 0 ? Math.min(1, playbackCurrent / playbackDuration) : 0;

  // Synchronous send guard. The parent's `sending` prop only flips
  // after onSend's first await, so a quick double-tap on Send can call
  // onSend twice before either screen re-renders. A ref flips
  // synchronously inside handleSend before the first await so the
  // second tap returns immediately.
  const sendInFlightRef = useRef(false);
  // Tracks whether we've ever started recording in this session — used
  // to gate the pulse animation and the "tap mic to record" hint.
  const [didStart, setDidStart] = useState(false);
  // True while we're awaiting a permission decision so the mic button
  // shows a disabled state instead of double-firing the prompt.
  const [requesting, setRequesting] = useState(false);
  // Recorder state at 200 ms — smooth enough for the elapsed counter and the
  // metering pulse — but only while a recording is in progress: from the
  // start tap until the clip is captured (recordedUri) or the sheet closes.
  const recorderState = useRecorderStatusWhileActive(
    recorder,
    visible && didStart && recordedUri === null,
  );

  // 60 s hard-cap timer. We don't rely on the recorder's internal
  // `stopOnReachingTimeLimit` (varies by platform) — JS-side timer is
  // simple, predictable, and easy to cancel on unmount.
  const cutoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const elapsedSeconds = Math.min(
    MAX_RECORDING_SECONDS,
    Math.floor(recorderState.durationMillis / 1000),
  );
  const isRecording = recorderState.isRecording;
  const isFinalised = !isRecording && !!recordedUri;

  // Time shown in the review row: live playback position while playing,
  // otherwise the clip's total length.
  const reviewTimeLabel = fmtTime(isPlaying ? playbackCurrent : playbackDuration || elapsedSeconds);

  // Animated pulse driven by the recorder's metering value. metering is
  // dB (negative; -160 is silence, 0 is clipping). Map to a 0-1 scale
  // and feed a withTiming so the indicator breathes smoothly rather
  // than snapping on every 200 ms tick. We also push the same 0-1 value
  // into `meteringHistory` so the review waveform mirrors what was said.
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!isRecording) {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 200 });
      return;
    }
    const db = recorderState.metering ?? -60;
    // Squash -60 dB → 0, -10 dB → 1. Voice usually sits around -30 to
    // -10 in normal speech, so the visible range is in the comfortable
    // middle of the pulse curve.
    const normalized = Math.max(0, Math.min(1, (db + 60) / 50));
    pulse.value = withTiming(normalized, {
      duration: 200,
      easing: Easing.out(Easing.cubic),
    });
    setMeteringHistory((prev) => [...prev, normalized]);
  }, [recorderState.metering, isRecording, pulse]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.4 }],
    opacity: 0.25 + pulse.value * 0.6,
  }));

  // Open / dismiss the sheet in lockstep with the parent's `visible`
  // prop. We also reset session state on open (so a previous URI can't
  // be resent) and tear down any in-flight recording on close.
  useEffect(() => {
    if (visible) {
      setRecordedUri(null);
      setMeteringHistory([]);
      setDidStart(false);
      sendInFlightRef.current = false;
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  // Cancel + cleanup on unmount or visibility flip while recording.
  // Without this the native mic stays held open until the OS reclaims
  // it — visible as a system mic indicator that lingers after the
  // sheet has disappeared. Best-effort: we ignore errors because the
  // recorder may already be stopped from the user's last action.
  useEffect(() => {
    return () => {
      if (cutoffTimerRef.current) {
        clearTimeout(cutoffTimerRef.current);
        cutoffTimerRef.current = null;
      }
      // No await — unmount cleanup must be synchronous.
      recorder.stop().catch(() => {
        // Already stopped — fine.
      });
    };
    // recorder identity is stable across renders within a single mount
    // (useAudioRecorder caches it), so this effect runs only on
    // sheet-mount / sheet-unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensurePermission = useCallback(async (): Promise<boolean> => {
    const current = await getRecordingPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) {
      Alert.alert(
        t('voiceRecordingSheet.micAccessNeededTitle'),
        t('voiceRecordingSheet.micAccessNeededSettings'),
        [
          { text: t('voiceRecordingSheet.cancel'), style: 'cancel' },
          { text: t('voiceRecordingSheet.openSettings'), onPress: () => Linking.openSettings() },
        ],
      );
      return false;
    }
    setRequesting(true);
    let result;
    try {
      result = await requestRecordingPermissionsAsync();
    } finally {
      setRequesting(false);
    }
    if (!result.granted) {
      // First-time deny — surface the "Open Settings" path immediately
      // so the user doesn't have to tap the mic a second time to learn
      // how to recover. On Android the second prompt also auto-flips
      // canAskAgain to false; iOS only ever shows the OS prompt once.
      Alert.alert(
        t('voiceRecordingSheet.micAccessNeededTitle'),
        t('voiceRecordingSheet.micAccessNeededGrant'),
        result.canAskAgain
          ? [{ text: t('voiceRecordingSheet.ok'), style: 'cancel' }]
          : [
              { text: t('voiceRecordingSheet.cancel'), style: 'cancel' },
              {
                text: t('voiceRecordingSheet.openSettings'),
                onPress: () => Linking.openSettings(),
              },
            ],
      );
      return false;
    }
    return true;
  }, [t]);

  const handleStart = useCallback(async () => {
    if (sending || requesting || isRecording) return;
    const ok = await ensurePermission();
    if (!ok) return;
    try {
      // Stop any review playback before we re-arm the mic.
      try {
        player.pause();
      } catch {
        // No active playback — fine.
      }
      // Switch the audio session into record mode. Without this iOS
      // routes through the playback category (silenced when the ringer
      // switch is off) and Android's voice routing can be wrong on
      // some OEMs. No-op on web.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setDidStart(true);
      setRecordedUri(null);
      setMeteringHistory([]);
      cutoffTimerRef.current = setTimeout(() => {
        // Hard 60 s cap — fire-and-forget; once stop() resolves the
        // captured clip ends polling, whose last sample picks up
        // isRecording=false.
        recorder
          .stop()
          .then(() => setRecordedUri(recorder.uri ?? null))
          .catch(() => {
            // Already stopped — fine.
          });
      }, MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      console.warn('[VoiceRecordingSheet] start failed', err);
      Alert.alert(
        t('voiceRecordingSheet.recordingFailedTitle'),
        err instanceof Error ? err.message : t('voiceRecordingSheet.recordingFailedMessage'),
      );
    }
  }, [ensurePermission, isRecording, recorder, requesting, sending, player, t]);

  const handleStop = useCallback(async () => {
    if (cutoffTimerRef.current) {
      clearTimeout(cutoffTimerRef.current);
      cutoffTimerRef.current = null;
    }
    try {
      await recorder.stop();
      setRecordedUri(recorder.uri ?? null);
    } catch (err) {
      console.warn('[VoiceRecordingSheet] stop failed', err);
    }
  }, [recorder]);

  const handleToggle = useCallback(() => {
    if (isRecording) {
      handleStop();
    } else {
      handleStart();
    }
  }, [isRecording, handleStart, handleStop]);

  // Play / pause the recorded clip for review before sending.
  const handlePlayToggle = useCallback(async () => {
    if (!recordedUri) return;
    try {
      // Route to the speaker for playback (recording mode silences
      // output on iOS). playsInSilentMode so it's audible with the
      // ringer switch off.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (isPlaying) {
        player.pause();
      } else {
        // Restart from the top if we're at (or past) the end.
        if (playbackDuration > 0 && playbackCurrent >= playbackDuration - 0.05) {
          player.seekTo(0);
        }
        player.play();
      }
    } catch (err) {
      console.warn('[VoiceRecordingSheet] playback failed', err);
    }
  }, [recordedUri, isPlaying, player, playbackCurrent, playbackDuration]);

  // Release the mic + halt review playback + clear the cutoff timer.
  // Shared by every close path (Cancel button, hardware back, pan-down
  // dismiss) — the sheet is never unmounted on close, so without this a
  // back-out / swipe-away mid-recording would leave the recorder running
  // off-screen until the 60 s cap fires.
  const teardownRecording = useCallback(async () => {
    if (cutoffTimerRef.current) {
      clearTimeout(cutoffTimerRef.current);
      cutoffTimerRef.current = null;
    }
    try {
      player.pause();
    } catch {
      // No active playback — fine.
    }
    try {
      await recorder.stop();
    } catch {
      // Recorder may already be stopped — discard.
    }
  }, [recorder, player]);

  const handleCancel = useCallback(async () => {
    await teardownRecording();
    setRecordedUri(null);
    setMeteringHistory([]);
    setDidStart(false);
    onClose();
  }, [onClose, teardownRecording]);

  const handleSend = useCallback(async () => {
    if (!recordedUri || sending || sendInFlightRef.current) return;
    // Flip the synchronous guard BEFORE any await so a second tap that
    // arrives in the same JS turn (before `sending` has had a chance
    // to flip via the parent's setState) returns at the guard above.
    sendInFlightRef.current = true;
    try {
      player.pause();
    } catch {
      // No active playback — fine.
    }
    try {
      // Belt-and-braces size cap. The 60 s recording limit *should*
      // keep an AAC clip well under 2 MB at typical speech bitrates,
      // so this path is unlikely to trigger today — but if a user
      // swaps to a stricter Blossom server, or the codec/quality
      // changes in future, we'd rather fail fast here than burn
      // upload bandwidth on a clip the server will reject anyway.
      try {
        const sizeBytes = await getFileSizeBytes(recordedUri);
        if (sizeBytes > MAX_VOICE_NOTE_SIZE_BYTES) {
          const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
          Alert.alert(
            t('voiceRecordingSheet.tooLargeTitle'),
            t('voiceRecordingSheet.tooLargeMessage', { size: sizeMb }),
          );
          // Failed fast — let the user retry; clear the guard so a
          // subsequent tap can proceed.
          sendInFlightRef.current = false;
          return;
        }
      } catch (err) {
        console.warn('[VoiceRecordingSheet] size check failed', err);
        // Fall through — let the upload path surface its own error
        // rather than blocking the send because we couldn't stat the
        // file.
      }
      // `false` = not sent (failed, or the user cancelled a NIP-17 fallback):
      // the sheet keeps the recording, so let a later tap send it.
      const durationMs = Math.round(
        (playbackDuration || recorderState.durationMillis / 1000) * 1000,
      );
      if ((await onSend(recordedUri, durationMs)) === false) sendInFlightRef.current = false;
    } catch (err) {
      // Parent's onSend may throw — clear the guard so the user can
      // retry without remounting the sheet.
      sendInFlightRef.current = false;
      throw err;
    }
    // Note: on success we leave sendInFlightRef = true. The sheet is
    // about to be dismissed by the parent, and `visible` flipping will
    // reset the ref on the next open. Holding it true in the meantime
    // prevents a third tap from racing in if the user happens to keep
    // jabbing the button while the sheet is animating away.
  }, [recordedUri, sending, onSend, player, t, playbackDuration, recorderState.durationMillis]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        pressBehavior="none"
      />
    ),
    [],
  );

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        // Pan-down dismiss bypasses the Cancel button, so tear the
        // recorder down here too — otherwise a swipe-away mid-recording
        // leaves the mic live off-screen.
        teardownRecording();
        onClose();
      }
    },
    [onClose, teardownRecording],
  );

  // Hardware back button → run the same teardown as Cancel so the mic is
  // released, then close. Mirrors the GifPickerSheet pattern. Declared
  // after handleCancel so the dependency is initialised before this runs.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleCancel();
      return true;
    });
    return () => sub.remove();
  }, [visible, handleCancel]);

  const elapsedLabel = fmtTime(elapsedSeconds);

  const hint = isRecording
    ? t('voiceRecordingSheet.hintRecording', { max: MAX_RECORDING_SECONDS })
    : isFinalised
      ? t('voiceRecordingSheet.hintFinalised')
      : didStart
        ? t('voiceRecordingSheet.hintRecordAgain')
        : t('voiceRecordingSheet.hintStart');

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      onChange={handleSheetChange}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.sheetBackground}
      // Stack on top of the parent attach panel so the close cascade
      // doesn't dismiss the underlying ConversationScreen — same
      // pattern GifPickerSheet uses.
      stackBehavior="push"
    >
      <BottomSheetView style={styles.content} testID="voice-recording-sheet">
        <Text style={styles.title}>{t('voiceRecordingSheet.title')}</Text>
        <Text style={styles.encryptionNote} testID="voice-encryption-note">
          {t('voiceRecordingSheet.encryptionNote')}
        </Text>

        {!isFinalised && (
          <Text style={styles.elapsed} testID="voice-elapsed">
            {elapsedLabel}
          </Text>
        )}

        <View style={styles.micArea}>
          {isRecording ? (
            <Animated.View
              style={[styles.pulse, { backgroundColor: colors.brandPink }, pulseStyle]}
            />
          ) : null}
          <TouchableOpacity
            style={[styles.micButton, { backgroundColor: colors.brandPink }]}
            onPress={handleToggle}
            disabled={sending || requesting}
            accessibilityLabel={
              isRecording
                ? t('voiceRecordingSheet.stopRecording')
                : t('voiceRecordingSheet.startRecording')
            }
            accessibilityState={{ disabled: sending || requesting }}
            testID="voice-record-toggle"
          >
            {isRecording ? (
              <Square size={36} color={colors.white} fill={colors.white} />
            ) : (
              <Mic size={36} color={colors.white} />
            )}
          </TouchableOpacity>
        </View>

        {/* Live waveform while recording — grows left→right, full at 60s. */}
        {isRecording && meteringHistory.length > 0 && (
          <View style={styles.liveWave}>
            <Waveform
              data={meteringHistory}
              progress={1}
              barCount={Math.max(
                1,
                Math.round((elapsedSeconds / MAX_RECORDING_SECONDS) * WAVEFORM_BARS),
              )}
              colors={colors}
            />
          </View>
        )}

        {/* WhatsApp-style review row: play/pause + waveform + time */}
        {isFinalised && (
          <View style={styles.playerCard} testID="voice-player-card">
            <TouchableOpacity
              style={styles.playButton}
              onPress={handlePlayToggle}
              accessibilityLabel={
                isPlaying
                  ? t('voiceRecordingSheet.pausePlayback')
                  : t('voiceRecordingSheet.playVoiceNote')
              }
              testID="voice-play-toggle"
            >
              {isPlaying ? (
                <Pause size={20} color={colors.white} fill={colors.white} />
              ) : (
                <Play size={20} color={colors.white} fill={colors.white} />
              )}
            </TouchableOpacity>
            <Waveform data={meteringHistory} progress={playbackProgress} colors={colors} />
            <Text style={styles.playerTime} testID="voice-player-time">
              {reviewTimeLabel}
            </Text>
          </View>
        )}

        <Text style={styles.hint}>{hint}</Text>

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.actionButton, styles.cancelButton, sending && styles.sendButtonDisabled]}
            onPress={handleCancel}
            disabled={sending}
            accessibilityLabel={t('voiceRecordingSheet.cancelVoiceNote')}
            accessibilityState={{ disabled: sending }}
            testID="voice-cancel-button"
          >
            <X size={18} color={colors.textBody} />
            <Text style={[styles.actionLabel, { color: colors.textBody }]}>
              {t('voiceRecordingSheet.cancel')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.actionButton,
              styles.sendButton,
              (!isFinalised || sending) && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!isFinalised || sending}
            accessibilityLabel={t('voiceRecordingSheet.sendVoiceNote')}
            accessibilityState={{ disabled: !isFinalised || sending }}
            testID="voice-send-button"
          >
            <Send size={18} color={colors.white} />
            <Text style={[styles.actionLabel, { color: colors.white }]}>
              {sending ? t('voiceRecordingSheet.sending') : t('voiceRecordingSheet.send')}
            </Text>
          </TouchableOpacity>
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
};

/**
 * Stat a local `file://` URI via expo-file-system (native, reliable on
 * Android). The previous XHR-to-Blob approach failed on the recorder's
 * cache path ("Failed to stat file://…/cache/Audio/…m4a") — RN's XHR on
 * file:// is flaky — so we read the size natively (matches AboutScreen).
 */
async function getFileSizeBytes(fileUri: string): Promise<number> {
  const info = await getInfoAsync(fileUri);
  if (!info.exists) throw new Error(`File not found: ${fileUri}`);
  return info.size;
}

export default VoiceRecordingSheet;
