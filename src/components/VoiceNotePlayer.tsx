import BrandedSpinner from './BrandedSpinner';
import OutgoingBubbleBackground from './OutgoingBubbleBackground';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Pressable } from 'react-native';
import { Play, Pause, AlertCircle } from 'lucide-react-native';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { useTapToReveal } from '../hooks/useTapToReveal';
import { checkRemoteUrl, MEDIA_MAX_BYTES } from '../utils/remoteUrlPolicy';
import { useActivePubkey } from '../hooks/useActivePubkey';
import { useRemoteMedia } from '../hooks/useRemoteMediaUri';
import { useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createVoiceNotePlayerStyles } from '../styles/VoiceNotePlayer.styles';
import { formatTime } from '../utils/messageContent';
import {
  captureDecryptedMediaSession,
  DecryptedMediaCancelledError,
  resolveDecryptedMedia,
} from '../services/decryptedMediaCache';
import type { MarmotImageParams } from '../utils/messageContent';

const BARS = 40;

/**
 * Inline voice-note player for chat bubbles (#235) — sender AND receiver.
 *
 * Two playback modes:
 *  - **Plain** (`encrypted=false`): legacy / unencrypted notes — bounded download to an
 *    account-scoped cache file before playback.
 *  - **Encrypted** (`encrypted=true`, NIP-17 kind 15): on first play, fetch
 *    the AES-256-GCM ciphertext from Blossom, decrypt with the key/nonce
 *    (carried inside the E2E DM), write the plaintext to a cache file, and
 *    play that. The Blossom server only ever holds ciphertext.
 *
 * The waveform is a deterministic pseudo-wave seeded from the URL — like
 * WhatsApp's bubble, decorative but stable per-clip, scrubbed by playback.
 */
function pseudoWave(seed: string, bars: number): number[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ seed.charCodeAt(i)) >>> 0;
    h = (h * 16777619) >>> 0;
  }
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    // 0.2 .. 1.0 so bars never collapse to a flat line.
    out.push(0.2 + (((h >>> 8) % 1000) / 1000) * 0.8);
  }
  return out;
}

const fmtDuration = (seconds: number) => {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`;
};

interface Props {
  url: string;
  fromMe: boolean;
  createdAt: number;
  senderName?: string | null;
  /** Encrypted (NIP-17 kind 15) → fetch ciphertext + decrypt before play. */
  encrypted?: boolean;
  sha256?: string;
  keyHex?: string;
  nonceHex?: string;
  /** A Marmot (MIP-04) voice note: decrypted with these instead of `keyHex`. */
  marmot?: MarmotImageParams;
  mime?: string;
  size?: number;
  /** Trust gate (#1338): stream a PLAIN note's URL on mount only for my own /
   *  followed senders. Otherwise nothing is requested until play is tapped.
   *  (Encrypted notes already fetch only on play.) Defaults to false. */
  autoLoad?: boolean;
  testID?: string;
  /** Optional time + delivery-tick footer (#856). When supplied it replaces
   *  the bare timestamp so a sent voice note shows its delivery tick. */
  footer?: React.ReactNode;
  /** Shown under the sender label — a Marmot reply's quoted parent. */
  header?: React.ReactNode;
  /** Long-press on the bubble opens the message menu (e.g. Delete for everyone). */
  onLongPress?: () => void;
}

const VoiceNotePlayer: React.FC<Props> = ({
  url,
  fromMe,
  createdAt,
  senderName,
  encrypted = false,
  sha256,
  keyHex,
  nonceHex,
  marmot,
  mime,
  size,
  autoLoad = false,
  testID,
  footer,
  header,
  onLongPress,
}) => {
  const owner = useActivePubkey();
  const colors = useThemeColors();
  const styles = useMemo(() => createVoiceNotePlayerStyles(colors), [colors]);
  const bars = useMemo(() => pseudoWave(url, BARS), [url]);

  // Decrypted clip is written to a cache file on first play; for plain notes
  // we download through the bounded, account-scoped transport. Encrypted
  // clips are NOT seeded from memory: the OS can evict cacheDirectory,
  // so a hit isn't proof the file still exists —
  // resolveDecryptedMedia verifies existence (and re-decrypts on a miss)
  // before ensureLocal sets localUri (#732 review).
  const [local, setLocal] = useState<{ owner: string | null; uri: string } | null>(null);
  const localUri = local?.owner === owner ? local.uri : null;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const wantPlayRef = useRef(false);
  useEffect(() => {
    wantPlayRef.current = false;
    setLocal(null);
    setBusy(false);
    setFailed(false);
  }, [owner, url]);
  // The parsed `marmot` object is rebuilt every render; read it via a ref so
  // it doesn't churn ensureLocal's identity.
  const marmotRef = useRef(marmot);
  marmotRef.current = marmot;

  // A plain note downloads on mount only for a trusted sender AND a safe URL;
  // otherwise it stays unloaded until the first tap. Consent is keyed by the
  // URL, so an edited message needs a fresh tap.
  const [plainAllowed, revealPlain] = useTapToReveal(
    `voice:${url}`,
    autoLoad && checkRemoteUrl(url, { kind: 'media' }).ok,
  );
  const { t } = useLocale();
  const safe = checkRemoteUrl(url, { kind: 'media' }).ok;
  const {
    uri: plainUri,
    failed: plainFailed,
    retry: retryPlain,
  } = useRemoteMedia(!encrypted && plainAllowed && safe ? url : null, MEDIA_MAX_BYTES);
  const source = safe ? (encrypted ? localUri : plainUri) : null;
  const player = useAudioPlayer(source ?? undefined);
  const status = useAudioPlayerStatus(player);
  const isPlaying = status?.playing ?? false;
  const duration = status?.duration && isFinite(status.duration) ? status.duration : 0;
  const current = status?.currentTime ?? 0;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const playedBars = Math.round(progress * bars.length);

  // Fetch ciphertext → decrypt → cache a playable file, via the shared
  // per-account cache (decrypt once across remounts, #730; scoped to the
  // account and wiped on sign-out, #1241). Returns the local uri (or null on
  // failure). Plain notes resolve through useRemoteMediaUri.
  const ensureLocal = useCallback(
    async (session: ReturnType<typeof captureDecryptedMediaSession>): Promise<string | null> => {
      session.assertCurrent();
      if (!encrypted) return plainUri;
      if (localUri) return localUri;
      const marmotParams = marmotRef.current;
      if ((!keyHex && !marmotParams) || !nonceHex) {
        setFailed(true);
        return null;
      }
      setBusy(true);
      try {
        const uri = await resolveDecryptedMedia(
          {
            url,
            kind: 'voice',
            mime,
            size,
            sha256,
            keyHex,
            nonceHex,
            marmot: marmotParams,
          },
          session.owner,
        );
        session.assertCurrent();
        setLocal({ owner, uri });
        return uri;
      } catch (e) {
        if (e instanceof DecryptedMediaCancelledError) return null;
        console.warn('[VoiceNotePlayer] decrypt/playback prep failed:', e);
        setFailed(true);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [owner, encrypted, url, localUri, sha256, keyHex, nonceHex, mime, size, plainUri],
  );

  // Once the decrypted file lands and the user had asked to play, start it
  // (the player's source only switches on the next render). Covers both a
  // decrypted note and a gated plain note armed by the first tap.
  useEffect(() => {
    if (source && wantPlayRef.current) {
      wantPlayRef.current = false;
      player.play();
    }
  }, [source, player]);

  const onToggle = useCallback(async () => {
    if (!safe) return;
    const session = captureDecryptedMediaSession(owner);
    try {
      session.assertCurrent();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      session.assertCurrent();
      if (isPlaying) {
        player.pause();
        return;
      }
      if (encrypted && !localUri) {
        wantPlayRef.current = true;
        await ensureLocal(session); // playback fires from the effect once decrypted
        return;
      }
      if (!source) {
        // Gated plain note: load it now; playback fires from the effect.
        wantPlayRef.current = true;
        if (plainFailed) retryPlain();
        else revealPlain();
        return;
      }
      if (duration > 0 && current >= duration - 0.05) player.seekTo(0);
      player.play();
    } catch {
      // Playback is best-effort; a failed load just leaves the button idle.
    }
  }, [
    owner,
    safe,
    isPlaying,
    player,
    current,
    duration,
    encrypted,
    localUri,
    ensureLocal,
    source,
    revealPlain,
    plainFailed,
    retryPlain,
  ]);

  // On-bubble colours: white-on-pink for my bubbles, themed for theirs.
  const fg = fromMe ? colors.outgoingBubble.foreground : colors.textBody;
  const playBg = fromMe ? colors.outgoingBubble.foreground : colors.brandPink;
  const playFg = fromMe ? colors.outgoingBubble.gradient[0] : colors.white;
  const playedColor = fromMe ? colors.outgoingBubble.foreground : colors.brandPink;
  const unplayedColor = fromMe ? colors.outgoingBubble.foreground + '73' : colors.divider;

  const timeLabel = fmtDuration(isPlaying ? current : duration);

  if (!safe) return <Text style={styles.title}>{t('messageBubble.blockedLink')}</Text>;

  return (
    <View style={[styles.row, fromMe ? styles.rowRight : styles.rowLeft]}>
      <Pressable
        style={[styles.bubble, fromMe ? styles.bubbleMe : styles.bubbleThem]}
        onLongPress={onLongPress}
        disabled={!onLongPress}
      >
        <OutgoingBubbleBackground fromMe={fromMe} />
        {senderName ? <Text style={styles.senderLabel}>{senderName}</Text> : null}
        {header}
        <Text
          style={[
            styles.title,
            { color: fromMe ? colors.outgoingBubble.foreground : colors.textSupplementary },
          ]}
        >
          {encrypted ? 'Encrypted voice note' : 'Voice note'}
        </Text>
        <View
          style={styles.playerRow}
          accessibilityLabel={fromMe ? 'Voice note sent' : 'Voice note received'}
          testID={testID}
        >
          <TouchableOpacity
            style={[styles.playBtn, { backgroundColor: playBg }]}
            onPress={onToggle}
            disabled={busy}
            accessibilityLabel={isPlaying ? 'Pause voice note' : 'Play voice note'}
            testID={testID ? `${testID}-toggle` : undefined}
          >
            {busy ? (
              <BrandedSpinner size="small" onGradient={playBg !== colors.white} />
            ) : failed || plainFailed ? (
              <AlertCircle size={18} color={playFg} />
            ) : isPlaying ? (
              <Pause size={18} color={playFg} fill={playFg} />
            ) : (
              <Play size={18} color={playFg} fill={playFg} />
            )}
          </TouchableOpacity>
          <View style={styles.waveRow}>
            {bars.map((v, i) => (
              <View
                key={i}
                style={[
                  styles.bar,
                  {
                    height: 4 + v * 24,
                    backgroundColor: i < playedBars ? playedColor : unplayedColor,
                  },
                ]}
              />
            ))}
          </View>
          <Text style={[styles.duration, { color: fg }]}>
            {failed || plainFailed ? '--:--' : timeLabel}
          </Text>
        </View>
        {footer ?? (
          <Text style={[styles.time, fromMe ? styles.timeMe : styles.timeThem]}>
            {formatTime(createdAt)}
          </Text>
        )}
      </Pressable>
    </View>
  );
};

export default VoiceNotePlayer;
