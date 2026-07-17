// Copy the built web bundle into the extension so the .vsix is self-contained.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
const dest = resolve(here, "../media/web");

if (!existsSync(webDist)) {
  console.error(`web bundle not found at ${webDist} — run \`pnpm --filter @crc/web build\` first`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(webDist, dest, { recursive: true });
console.log(`copied web bundle -> ${dest}`);
