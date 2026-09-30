// Layered over app.json. Its one job: point Android at a Firebase config when
// there is one, since Android can't get a push token without it (see
// SETUP.md → Push notifications on the phone). Without the file the app
// builds exactly as before, just without push.
//
// Local builds read ./google-services.json (gitignored). EAS builds can't see
// a gitignored file, so there it comes from a file environment variable:
//   eas env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json
const { existsSync } = require("node:fs");
const { join } = require("node:path");

module.exports = ({ config }) => {
  const fromEnv = process.env.GOOGLE_SERVICES_JSON;
  const local = join(__dirname, "google-services.json");
  const googleServicesFile = fromEnv || (existsSync(local) ? "./google-services.json" : undefined);
  if (!googleServicesFile) return config;
  return { ...config, android: { ...config.android, googleServicesFile } };
};
