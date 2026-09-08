// Metro config for a pnpm monorepo (per Expo's official guidance): watch the
// workspace root so changes in @renki/client-core / @renki/protocol are picked up,
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
// Side effect: Metro only ever checks the two nodeModulesPaths above, never a
// dependency's OWN nested node_modules (e.g. markdown-it/node_modules/entities,
// where pnpm correctly resolves markdown-it's real `entities: ~2.0.0` need) —
// so whatever version of a shared package like "entities" happens to land in
// the flat root node_modules (hoisted there for some OTHER, unrelated
// consumer) is the only one Metro can ever see, version mismatch or not. Fix
// for a package hit by this: add it as a direct dependency of @renki/mobile
// pinned to the version that package's actual consumer needs (see "entities"
// in package.json) — that gives pnpm a reason to place a correctly-versioned
// copy directly under apps/mobile/node_modules, which IS one of the two paths
// above.

module.exports = config;
