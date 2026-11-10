import { registerRootComponent } from 'expo';
import { LogBox, Platform } from 'react-native';
import {
  registerWidgetConfigurationScreen,
  registerWidgetTaskHandler,
} from 'react-native-android-widget';
import { perfAnchor, perfLog, perfHeartbeatStart } from './src/utils/perfLog';
// Side-effect import: defines the background-sync task in the global scope
// so expo-background-task can invoke it after an OS-driven relaunch (#279).
import './src/services/backgroundTask';
// Side-effect import: registers the BackgroundDmTask headless JS task in the
// global scope so the native Android foreground service (and the BootReceiver
// after a reboot) can run it even when no React tree is mounted (#279).
import './src/services/backgroundDmHeadlessTask';
// Side-effect import: defines the Marmot push-wake task (MIP-05) in the
// global scope so an FCM message can run it with no React tree mounted.
import './src/services/marmotPushWake';
// Side-effect import: defines the live-location background task (#1300) so
// the OS can deliver location updates while a share runs in the background.
import './src/services/liveLocationTask';

// Anchor T0 at the FIRST line of JS execution (this module is the
// app's entry point per registerRootComponent below). Every later
// `perfLog(tag)` call reports `+Nms` relative to here, so a single
// `adb logcat | grep "[Perf]"` gives the entire cold-start timeline.
perfAnchor();
perfLog('index.ts module-eval');
// Start the JS-thread heartbeat so cold-start freezes show up as
// large `gap=Xms` values in the perf log, even when no user taps.
perfHeartbeatStart();

import App from './App';
perfLog('App.tsx imported');
// Facade warm-up entry point — invoked after registerRootComponent below to
// latch native-crypto routing (no-op unless EXPO_PUBLIC_NATIVE_CRYPTO is set
// OR the tester Settings pref is on, #1057).
import { setNativeCryptoEnabled, warmUpNativeCrypto } from './src/services/nostrCrypto';
import { loadNativeCryptoEnabled } from './src/services/nativeCryptoPreference';
import { prewarmLocalDb } from './src/services/localDb';
import { widgetTaskHandler } from './src/widgets/widgetTaskHandler';
import { WidgetConfigurationScreen } from './src/widgets/WidgetConfigurationScreen';

// Suppress the dev-tools / debugger warning banners. The "Open debugger
// to view warnings" overlay keeps intercepting taps + stealing focus on
// every fast-refresh, and the chrome-sandbox launch error is cosmetic on
// Linux (documented in TROUBLESHOOTING.adoc). Silence the LogBox entirely
// in __DEV__ for development ergonomics.
if (__DEV__) {
  LogBox.ignoreAllLogs(true);
}

// Dedupe @getalby/sdk's "NIP-04 encryption is about to be deprecated"
// warning. The SDK fires it once per nip04.encrypt / nip04.decrypt, so
// every kind-4 in the inbox-drain trips it. Each console.warn from JS is
// a native bridge round-trip in dev + serializer cost in release; on a
// busy inbox this stacks up to >100ms of bridge traffic during cold
// start, which adds to the "Send sheet feels frozen just after launch"
// symptom. Keep one log per session for visibility.
const NIP04_DEPRECATION_PREFIX = 'NIP-04 encryption is about to be deprecated';
const __originalConsoleWarn = console.warn.bind(console);
let __nip04WarnCount = 0;
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && first.startsWith(NIP04_DEPRECATION_PREFIX)) {
    __nip04WarnCount += 1;
    if (__nip04WarnCount === 1) {
      __originalConsoleWarn(`${first} (further instances suppressed)`);
    }
    return;
  }
  __originalConsoleWarn(...args);
};

// Start opening the encrypted local DB now (native, off the JS thread) so it
// overlaps the identity reads instead of starting at the first inbox read.
// No-op on an install without a DB key yet (see prewarmLocalDb).
prewarmLocalDb();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
perfLog('registerRootComponent called');
registerRootComponent(App);

// Android home-screen widget (#1849): the headless task that draws the widget
// and switches its wallet in place, and the configuration screen Android
// opens when a widget is added or reconfigured. Registered at module scope so
// Android can run them with no React tree mounted.
if (Platform.OS === 'android') {
  registerWidgetTaskHandler(widgetTaskHandler);
  registerWidgetConfigurationScreen(WidgetConfigurationScreen);
}

// Native crypto warm-up (#1046, #1057). Fire-and-forget so it never blocks
// startup. First hydrate the Settings pref (default on, #1727) and apply it to routing
// (setNativeCryptoEnabled: flags.native = env-flag || pref), THEN warm up —
// warmUp pays the one-time JNA + libnostr_sdk_ffi.so load off the JS thread and
// latches the facade's nativeReady flag. This is what makes native routing
// meaningful — until it resolves true, EVERY crypto op stays on the pure-JS
// path (nativeReady defaults false), so a linked-but-broken module can never
// route real crypto into a failing path. The pref is read ONCE here (not on the
// hot path) — one AsyncStorage read at launch regardless of the pref value —
// and the toggle only takes effect on the next launch (its "restart to apply"
// caption). warmUpNativeCrypto short-circuits to false when the user opted out,
// and only latches routing after a known-answer self-test passes.
void (async () => {
  try {
    setNativeCryptoEnabled(await loadNativeCryptoEnabled());
  } catch {
    // Pref read failed — leave flags.native at its env default and carry on.
  }
  void warmUpNativeCrypto();
})();

// Dev-only crypto benchmark for the #1046 native module bring-up. The
// EXPO_PUBLIC_* literal is inlined at bundle time, so in every normal build
// this whole block is dead code; the __DEV__ guard additionally makes it
// impossible to ship the bench in a release/preview build even if the env
// var leaks into one. The lazy import keeps the bench (and its
// @noble/nostr-tools vector setup) off the cold-start path, and the delay
// lets startup settle so timings aren't polluted by launch work.
if (__DEV__ && process.env.EXPO_PUBLIC_NATIVE_CRYPTO_BENCH === '1') {
  setTimeout(() => {
    import('./src/utils/nostrCryptoBench')
      .then((bench) => bench.runNostrCryptoBench())
      .catch((error) => console.log('[PerfBlock] cryptoBench failed to run:', error));
  }, 8000);
}

// Dev-only relay-engine benchmark (#1049): drains a synthetic 200-wrap
// backlog from the local bench relay (scripts/bench-engine-relay.mjs)
// through the JS unwrap path and the native engine. Same bundle-time
// inlining + __DEV__ + lazy-import guards as the crypto bench above.
if (__DEV__ && process.env.EXPO_PUBLIC_NATIVE_ENGINE_BENCH === '1') {
  setTimeout(() => {
    import('./src/utils/nativeEngineBench')
      .then((bench) => bench.runNativeEngineBench())
      .catch((error) => console.log('[PerfBlock] engineBench failed to run:', error));
  }, 8000);
}
