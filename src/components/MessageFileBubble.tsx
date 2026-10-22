import { useChatCardWidth } from '../styles/chatCardWidth';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, TouchableOpacity, View } from 'react-native';
import { Download, FileText, Share2, ShieldOff } from 'lucide-react-native';
import { Toast } from './BrandedToast';
import { Alert } from './BrandedAlert';
import { FileVerificationError } from '../services/fileDownload';
import { useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createMessageFileBubbleStyles } from '../styles/MessageFileBubble.styles';
import type { FileAttachment } from '../utils/fileAttachment';
import { Image } from 'expo-image';
import { useTapToReveal } from '../hooks/useTapToReveal';
import { usePdfPreview } from '../hooks/usePdfPreview';
import { pdfPreviewEligible } from '../utils/pdfPreviewEligibility';
import MediaStatusBox from './MediaStatusBox';
import TapToLoadMedia, { displayHost } from './TapToLoadMedia';
import { attachmentTypeLabel, formatAttachmentSize } from '../utils/attachmentPresentation';
import { isSafeFileUrl } from '../utils/fileAttachment';

type FileShareModule = typeof import('../services/fileShare');
type FileSaveModule = typeof import('../services/fileSave');

export default React.memo(function MessageFileBubble({
  id,
  file,
  fromMe,
  autoLoad = false,
  header,
  onLongPress,
  footer,
}: {
  id: string;
  file: FileAttachment;
  fromMe: boolean;
  autoLoad?: boolean;
  header?: React.ReactNode;
  onLongPress?: () => void;
  footer: React.ReactNode;
}) {
  const { t } = useLocale();
  const colors = useThemeColors();
  const cardWidth = useChatCardWidth();
  const styles = useMemo(
    () => createMessageFileBubbleStyles(colors, cardWidth),
    [colors, cardWidth],
  );
  const safe = file.available && isSafeFileUrl(file.url);
  const [allowed, reveal] = useTapToReveal(
    `pdf:${id}:${file.url}`,
    (autoLoad || fromMe) && safe && !file.plainUrl,
  );
  const isPdf = file.mime === 'application/pdf' && !file.dangerous && !file.typeMismatch;
  const {
    uri: preview,
    status: previewStatus,
    retry: retryPreview,
  } = usePdfPreview(file, safe && allowed && isPdf);
  // A previewable PDF holds a first-page-sized box until its preview is in:
  // tap to load, loading, or tap to retry. Too big (or nothing rendered)
  // falls back to the file icon and a text link.
  const previewBox =
    isPdf &&
    safe &&
    pdfPreviewEligible(file) &&
    previewStatus !== 'ready' &&
    previewStatus !== 'none'
      ? previewStatus
      : null;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<'verification' | 'share' | null>(null);
  const [verified, setVerified] = useState<{ size: number; mime: string } | null>(null);
  const act = useCallback(
    async (action: 'save' | 'share') => {
      if (busy) return;
      setBusy(true);
      setFailed(null);
      try {
        // Load crypto and native sharing only on an explicit user action.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { shareFileAttachment } = require('../services/fileShare') as FileShareModule;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { saveFileAttachment } = require('../services/fileSave') as FileSaveModule;
        await (action === 'save' ? saveFileAttachment : shareFileAttachment)(
          file,
          () =>
            new Promise<boolean>((resolve) => {
              Alert.alert(
                t('messageBubble.fileWarningTitle'),
                t('messageBubble.fileWarning'),
                [
                  { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
                  { text: t('messageBubble.fileSave'), onPress: () => resolve(true) },
                ],
                { onDismiss: () => resolve(false) },
              );
            }),
          setVerified,
          (folder: string) =>
            Toast.show({ type: 'success', text1: t('messageBubble.fileSaved', { folder }) }),
        );
      } catch (error) {
        setFailed(error instanceof FileVerificationError ? 'verification' : 'share');
      } finally {
        setBusy(false);
      }
    },
    [busy, file, t],
  );
  const type = attachmentTypeLabel(verified?.mime ?? file.mime, file.name);
  const friendlyType = ['Text', 'Audio', 'Video'].includes(type)
    ? t(`messageBubble.fileLabel${type}` as 'messageBubble.fileLabelText')
    : type;
  const size = verified?.size ?? file.size;
  const formattedSize = formatAttachmentSize(size);
  const sizeLabel =
    formattedSize && size !== undefined && size < 1000
      ? t('messageBubble.fileBytes', { size: formattedSize })
      : formattedSize;
  // Short types (PDF, ZIP, DOCX) ride on the file icon; a longer one joins
  // the size line instead, so the card needs one line, two at most.
  const badgeType = friendlyType.length <= 4 ? friendlyType : '';
  const meta = [badgeType ? '' : friendlyType, sizeLabel].filter(Boolean).join(' · ');
  const shortId = id.replace(/^dm-/, '').slice(0, 8);
  return (
    <View style={[styles.row, fromMe && styles.sent]}>
      <Pressable
        style={[styles.bubble, fromMe && styles.sentBubble]}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessible={false}
        testID={`chat-file-bubble-${shortId}`}
        accessibilityLabel={file.name || t('messageBubble.file')}
      >
        {preview && (
          <Image
            source={{ uri: preview }}
            style={styles.preview}
            cachePolicy="memory"
            contentFit="contain"
          />
        )}
        {previewBox === 'loading' && <MediaStatusBox status="loading" style={styles.previewBox} />}
        {(previewBox === 'idle' || previewBox === 'failed') && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={previewBox === 'idle' ? reveal : retryPreview}
            onLongPress={onLongPress}
            delayLongPress={350}
            accessibilityRole="button"
            accessibilityLabel={
              previewBox === 'idle'
                ? t('messageBubble.loadPdfA11y', { host: displayHost(file.url) })
                : `${t('messageBubble.pdfLoadFailed')}. ${t('messageBubble.tapToRetry')}`
            }
            testID={`chat-file-${previewBox === 'idle' ? 'load' : 'retry'}-${shortId}`}
          >
            {previewBox === 'idle' ? (
              <TapToLoadMedia
                variant="pdf"
                url={file.url}
                fromMe={fromMe}
                style={styles.previewBox}
                testID={`chat-file-placeholder-${shortId}`}
              />
            ) : (
              <MediaStatusBox
                status="failed"
                label={t('messageBubble.pdfLoadFailed')}
                style={styles.previewBox}
              />
            )}
          </TouchableOpacity>
        )}
        <View style={styles.body}>
          {header}
          {file.plainUrl && (
            <View style={styles.notice}>
              <ShieldOff size={14} color={colors.textSupplementary} />
              <Text style={styles.noticeText}>{t('messageBubble.filePlainUrl')}</Text>
            </View>
          )}
          <View style={styles.summary}>
            <View style={styles.typeTile}>
              <FileText size={20} color={colors.brandPink} />
              {badgeType ? (
                <Text style={styles.typeTileLabel} numberOfLines={1}>
                  {badgeType}
                </Text>
              ) : null}
            </View>
            <View style={styles.summaryText}>
              <Text style={styles.summaryName} numberOfLines={1} ellipsizeMode="middle">
                {file.name || t('messageBubble.file')}
              </Text>
              {meta ? <Text style={styles.summaryMeta}>{meta}</Text> : null}
            </View>
          </View>
          {isPdf && safe && !allowed && !previewBox && (
            <TouchableOpacity
              onPress={reveal}
              accessibilityRole="button"
              accessibilityLabel={t('chatMenu.loadMedia')}
              testID={`chat-file-load-${shortId}`}
            >
              <Text style={styles.actionText}>{t('chatMenu.loadMedia')}</Text>
            </TouchableOpacity>
          )}
          {(file.typeMismatch || (file.plainUrl && verified && verified.mime !== file.mime)) && (
            <Text style={styles.caption}>
              {t('messageBubble.fileTypeMismatch', { type: friendlyType })}
            </Text>
          )}
          {file.caption ? <Text style={styles.name}>{file.caption}</Text> : null}
          {file.available && isSafeFileUrl(file.url) ? (
            <View style={styles.actions}>
              {(['save', 'share'] as const).map((action) => {
                const Icon = action === 'save' ? Download : Share2;
                return (
                  <TouchableOpacity
                    key={action}
                    testID={`file-${action}-${id}`}
                    accessibilityLabel={t(
                      action === 'save'
                        ? 'messageBubble.fileSaveLabel'
                        : 'messageBubble.fileShareLabel',
                      { filename: file.name || t('messageBubble.file') },
                    )}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void act(action)}
                    style={[styles.action, busy && styles.busy]}
                  >
                    <Icon size={18} color={colors.brandPink} />
                    <Text style={styles.actionText}>
                      {t(action === 'save' ? 'messageBubble.fileSave' : 'messageBubble.fileShare')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <Text style={styles.caption}>{t('messageBubble.fileUnavailable')}</Text>
          )}
          {failed && (
            <Text style={styles.caption} accessibilityRole="alert">
              {t(
                failed === 'verification'
                  ? 'messageBubble.fileVerificationFailed'
                  : 'messageBubble.fileShareFailed',
              )}
            </Text>
          )}
          {footer}
        </View>
      </Pressable>
    </View>
  );
});
