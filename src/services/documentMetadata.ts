import { requireOptionalNativeModule } from 'expo-modules-core';

let warnedMissingModule = false;

/** File.name is a URI basename in Expo 55, not Android's provider display name. */
export async function selectedDocumentName(file: { uri: string; name: string }): Promise<string> {
  if (!file.uri.startsWith('content://')) return file.name;
  const native = requireOptionalNativeModule<{
    displayNameAsync(uri: string): Promise<string | null>;
  }>('DocumentMetadata');
  if (!native) {
    if (__DEV__ && !warnedMissingModule) {
      warnedMissingModule = true;
      console.warn(
        '[DocumentMetadata] Native module unavailable; using File.name. Rebuild the dev client for provider display names.',
      );
    }
    return file.name;
  }
  const name = await native.displayNameAsync(file.uri);
  return name || file.name;
}
