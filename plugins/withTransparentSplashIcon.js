const { withAndroidStyles } = require('expo/config-plugins');

/**
 * Android 12+ launch screen: plain brand pink, no icon.
 *
 * Android 12's SplashScreen API can't show a full-screen image — only a
 * centred icon on a background — and when the launch theme names no icon it
 * falls back to the launcher icon, which shows as a big app icon in the
 * middle of the screen on a cold start. The graffiti pig is drawn by
 * `BootSplash` as soon as JS mounts, so here the system splash is just the
 * same pink with a transparent icon, and the pig appears on it.
 */
const SPLASH_THEME = 'Theme.App.SplashScreen';
const ITEMS = {
  windowSplashScreenBackground: '@color/splashscreen_background',
  windowSplashScreenAnimatedIcon: '@android:color/transparent',
  windowSplashScreenIconBackgroundColor: '@color/splashscreen_background',
};

module.exports = function withTransparentSplashIcon(config) {
  return withAndroidStyles(config, (config) => {
    const theme = config.modResults.resources.style?.find((s) => s.$.name === SPLASH_THEME);
    if (!theme) return config;
    theme.item = (theme.item ?? []).filter((i) => !(i.$.name in ITEMS));
    for (const [name, value] of Object.entries(ITEMS)) {
      theme.item.push({ _: value, $: { name, 'tools:targetApi': '31' } });
    }
    return config;
  });
};
