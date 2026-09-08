const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

// Android trusts only system CAs per app by default since API 24 — a CA you
// install yourself in Settings (e.g. a homelab reverse proxy's private CA,
// such as Caddy's `tls internal`) isn't enough on its own. Self-hosted apps
// that expect a private CA (Immich's is one) opt into ALSO trusting
// user-added CAs via this exact network security config; without it, the
// daemon works fine in the phone's browser but fails in this app with
// something like "Network request failed".
//
// cleartextTrafficPermitted must be set explicitly here: once a
// networkSecurityConfig is present, Android ignores android:usesCleartextTraffic
// entirely (even the debug-variant manifest's own tools:replace override for
// it), and the attribute's own default is false on API 28+. Without this,
// plain http:// breaks completely — both the Metro dev server during
// development AND Renki's own supported http:// daemon URLs (e.g.
// http://127.0.0.1:4517 for a same-machine daemon) in production.
const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

module.exports = function withAndroidUserCaTrust(config) {
  config = withAndroidManifest(config, (config) => {
    config.modResults.manifest.application[0].$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return config;
  });

  return withDangerousMod(config, [
    "android",
    (config) => {
      const xmlDir = path.join(config.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "network_security_config.xml"), NETWORK_SECURITY_CONFIG);
      return config;
    },
  ]);
};
