const { withAndroidColors, withAndroidStyles, AndroidConfig } = require("@expo/config-plugins");

// Matches apps/mobile/src/theme.ts's dark palette's `bg` — the base Expo
// Android template otherwise defaults the status bar, navigation bar, and
// splash screen background to white, flashing white before the JS UI (which
// is always dark; app.json forces userInterfaceStyle "dark") ever mounts,
// and showing a jarring black/white system-bar area around the app's own
// dark background afterward.
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
      ["android:navigationBarColor", DARK_BG],
      ["android:windowLightStatusBar", "false"],
      ["android:windowLightNavigationBar", "false"],
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
