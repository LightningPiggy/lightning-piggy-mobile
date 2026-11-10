import { useCallback, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { useNostr } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import { Alert } from '../components/BrandedAlert';
import { stripImageMetadata, uploadImage } from '../services/imageUploadService';
import { ensurePermission } from '../utils/permissionPrompt';

/**
 * Pick a photo from the library, strip its metadata (EXIF / GPS) and upload
 * it through the app's existing Blossom path (signed with the user's signer,
 * nostr.build fallback). Resolves to the public URL, or null when cancelled
 * or failed (the failure is surfaced with the branded alert).
 */
export function useListingPhotoUpload() {
  const { signEvent } = useNostr();
  const t = useTranslation();
  const [uploading, setUploading] = useState(false);

  const pickAndUpload = useCallback(async (): Promise<string | null> => {
    const allowed = await ensurePermission(
      ImagePicker.requestMediaLibraryPermissionsAsync,
      t('market.sell.editor.permissionNeeded'),
      t('market.sell.editor.libraryPermission'),
    );
    if (!allowed) return null;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
      base64: true,
    });
    const asset = result.canceled ? undefined : result.assets?.[0];
    if (!asset) return null;
    setUploading(true);
    try {
      const scrubbed = await stripImageMetadata(asset.uri, asset.base64);
      return await uploadImage(scrubbed.uri, signEvent ?? null, scrubbed.base64);
    } catch (e) {
      Alert.alert(t('market.sell.editor.photoUploadFailed'), (e as Error).message, [
        { text: t('market.sell.editor.ok') },
      ]);
      return null;
    } finally {
      setUploading(false);
    }
  }, [signEvent, t]);

  return { uploading, pickAndUpload };
}
