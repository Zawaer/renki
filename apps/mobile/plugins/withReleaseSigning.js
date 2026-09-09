const { withAppBuildGradle } = require("@expo/config-plugins");

// Sign release builds with a real keystore instead of the debug one.
//
// Two reasons this is a config plugin rather than an edit to
// android/app/build.gradle: `expo prebuild --clean` regenerates that file (and
// deletes anything else under android/), so a hand-edit silently reverts to
// debug signing the next time the native project is rebuilt — and the failure
// is invisible until an update refuses to install over a published APK.
//
// Credentials come from the environment, never the repo. When they're absent
// the release build falls back to debug signing, so anyone cloning this can
// still produce a working APK without being handed a private key. Set:
//
//   RENKI_ANDROID_KEYSTORE           absolute path to the .keystore
//   RENKI_ANDROID_KEYSTORE_PASSWORD
//   RENKI_ANDROID_KEY_ALIAS
//   RENKI_ANDROID_KEY_PASSWORD
//
// Keep that keystore backed up: Android identifies an app by its signature, so
// losing it means no future build can ever update an install made with it.
const SIGNING_CONFIG = `
        release {
            if (System.getenv("RENKI_ANDROID_KEYSTORE")) {
                storeFile file(System.getenv("RENKI_ANDROID_KEYSTORE"))
                storePassword System.getenv("RENKI_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("RENKI_ANDROID_KEY_ALIAS")
                keyPassword System.getenv("RENKI_ANDROID_KEY_PASSWORD")
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;

    if (!gradle.includes('System.getenv("RENKI_ANDROID_KEYSTORE")')) {
      // Add a `release` signing config beside the generated `debug` one.
      gradle = gradle.replace(
        /(signingConfigs \{\n)/,
        `$1${SIGNING_CONFIG}\n`,
      );
      // Point the release build type at it, falling back to debug when unset.
      // The template puts comment lines between `release {` and the
      // signingConfig, so this can't anchor on a newline-plus-indent.
      gradle = gradle.replace(
        /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
        '$1signingConfig System.getenv("RENKI_ANDROID_KEYSTORE") ? signingConfigs.release : signingConfigs.debug',
      );
    }

    // Fail loudly rather than ship a "release" build signed with the debug
    // key. An upstream template change that breaks either patch is otherwise
    // invisible until an update won't install over a published APK.
    for (const needle of [
      'storeFile file(System.getenv("RENKI_ANDROID_KEYSTORE"))',
      'signingConfig System.getenv("RENKI_ANDROID_KEYSTORE") ?',
    ]) {
      if (!gradle.includes(needle)) {
        throw new Error(
          `withReleaseSigning: could not patch android/app/build.gradle (missing: ${needle}). ` +
            "The Expo template likely changed — fix the plugin rather than signing releases with the debug key.",
        );
      }
    }

    cfg.modResults.contents = gradle;
    return cfg;
  });
};
