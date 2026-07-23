const { withAndroidColors, withAndroidStyles, AndroidConfig } = require("@expo/config-plugins");

// Matches apps/mobile/src/theme.ts's dark palette's `bg`. Covers only what
// Expo has no first-class app.json key for — the navigation bar's color/style
// IS a first-class key (see app.json's top-level `androidNavigationBar`,
// which Expo's own built-in "unversioned" prebuild plugin bakes into
// styles.xml the same way this file does by hand, so it doesn't need to be
// duplicated here). The status bar has no equivalent build-time key: Expo's
// `androidStatusBar` config is only consumed by splash-screen code and the
// expo-status-bar JS module at runtime, never written into the native
// AppTheme's `android:statusBarColor` — so without this plugin, the status
// bar (and the root window background, and the splash background) would
// default back to the base Expo Android template's white, flashing white
// before the JS UI (which is always dark; app.json forces userInterfaceStyle
// "dark") ever mounts, and during any later native repaint (e.g. the
// keyboard show/hide resize).
const DARK_BG = "#191918";

module.exports = function withAndroidDarkChrome(config) {
  config = withAndroidColors(config, (config) => {
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: "splashscreen_background",
      value: DARK_BG,
    });
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: "colorPrimaryDark",
      value: DARK_BG,
    });
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: "crc_window_background",
      value: DARK_BG,
    });
    return config;
  });

  config = withAndroidStyles(config, (config) => {
    const parent = AndroidConfig.Styles.getAppThemeGroup();
    for (const [name, value] of [
      ["android:statusBarColor", DARK_BG],
      ["android:windowLightStatusBar", "false"],
      // The default AppCompat.Light windowBackground is white — visible as a
      // flash any time the native window briefly repaints before RN's own
      // (dark) content does, e.g. the keyboard show/hide resize.
      ["android:windowBackground", "@color/crc_window_background"],
    ]) {
      config.modResults = AndroidConfig.Styles.assignStylesValue(config.modResults, {
        add: true,
        value,
        name,
        parent,
      });
    }
    return config;
  });

  return config;
};
