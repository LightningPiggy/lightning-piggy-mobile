// Native autolinking overrides.
//
// @secondts/bark-react-native (the experimental Ark wallet, see BARK_PLAN.md)
// ships prebuilt Rust libraries for every ABI. Link them only into builds
// made with EXPO_PUBLIC_ENABLE_ARK=1, so regular builds keep their current
// size. The JS side loads the module lazily and treats a missing native
// module as "Ark unavailable" (src/services/arkService.ts).
//
// Android: expo-modules-autolinking merges this override into the package's
// own `platforms.android` config, and that merge drops a `null`, so point
// `sourceDir` at a folder that does not exist instead (no Gradle file found
// → not linked). iOS has no package-level config, so `null` works there.
// Check with: npx expo-modules-autolinking react-native-config -p android --json
const arkEnabled = process.env.EXPO_PUBLIC_ENABLE_ARK === '1';

module.exports = {
  dependencies: arkEnabled
    ? {}
    : {
        '@secondts/bark-react-native': {
          platforms: { android: { sourceDir: 'ark-disabled' }, ios: null },
        },
      },
};
