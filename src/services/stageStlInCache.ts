import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';

export async function stageStlInCache(): Promise<File> {
  // Materialise the bundled asset to a real file URI, then copy into the
  // cache dir with a friendly name so OS pickers don't show the
  // require()-mangled asset filename.
  const asset = Asset.fromModule(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../assets/3d/piggy-bag-charm.stl'),
  );
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('STL asset has no localUri after download');
  const target = new File(Paths.cache, 'piggy-bag-charm.stl');
  if (target.exists) target.delete();
  const source = new File(asset.localUri);
  source.copySync(target);
  return target;
}
