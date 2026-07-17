// Metro config for a pnpm monorepo (per Expo's official guidance): watch the
// workspace root so changes in @crc/client-core / @crc/protocol are picked up,
// and resolve modules from both the app and the root node_modules.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// pnpm uses symlinks; keep resolution from wandering up the tree unpredictably.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
