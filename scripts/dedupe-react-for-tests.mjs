#!/usr/bin/env node
/**
 * node-linker=hoisted (.npmrc, required for Expo/Metro to traverse
 * node_modules) makes pnpm create SEPARATE physical copies of react@19 for
 * react-dom and @testing-library/react (nested in their own node_modules),
 * instead of symlinking to apps/web's own copy — even though every copy
 * reports the exact same version. React's dispatcher lives on the module
 * object itself, so three separate files means three separate dispatchers:
 * any component using hooks crashes with "Cannot read properties of null
 * (reading 'useContext')" / "more than one copy of React" the instant
 * react-dom (or testing-library) touches a context/hook created via web's
 * own react.
 *
 * This never affects the shipped app — Vite's bundler resolves its own
 * consistent dependency graph for the browser build — it only breaks
 * Node-based tooling (Vitest) that loads react-dom directly. Fix: replace
 * those nested copies with symlinks to web's own react, so there's
 * genuinely one physical module everywhere it matters for testing.
 * Idempotent; safe to re-run on every install (registered as `postinstall`).
 */

import { existsSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalReact = resolve(rootDir, "apps/web/node_modules/react");

const nestedCopies = [
  resolve(rootDir, "node_modules/react-dom/node_modules/react"),
  resolve(rootDir, "node_modules/@testing-library/react/node_modules/react"),
  resolve(rootDir, "node_modules/react-router/node_modules/react"),
  resolve(rootDir, "node_modules/react-router-dom/node_modules/react"),
];

if (!existsSync(canonicalReact)) {
  // apps/web isn't installed in this environment (e.g. a mobile-only or
  // daemon-only install) — nothing to dedupe.
  process.exit(0);
}

for (const nested of nestedCopies) {
  if (!existsSync(nested)) continue;
  if (lstatSync(nested).isSymbolicLink()) continue; // already fixed

  rmSync(nested, { recursive: true, force: true });
  symlinkSync(relative(dirname(nested), canonicalReact), nested, "dir");
  console.log(`[dedupe-react-for-tests] relinked ${relative(rootDir, nested)} -> apps/web/node_modules/react`);
}
