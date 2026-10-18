import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { MAC_VERBS, type MacVerb } from "@renki/protocol";
import { z } from "zod";

/**
 * ~/Library/Application Support/Renki/mac-node.json (or $RENKI_MAC_CONFIG).
 * Lives on the Mac only: nothing on the homelab can change which verbs run here.
 */
export const CONFIG_DIR = join(homedir(), "Library", "Application Support", "Renki");
export const CONFIG_PATH = process.env.RENKI_MAC_CONFIG ?? join(CONFIG_DIR, "mac-node.json");

const File = z.object({
  /** The daemon's base URL, as the web client uses it, e.g. https://renki.internal/api */
  url: z.string().url(),
  token: z.string().min(1),
  /** Shown to the daemon and in Claude's messages. */
  name: z.string().max(100).optional(),
  adb: z.string().optional(),
  /** Switch single verbs off, e.g. { "shell": false }. Unlisted verbs are on. */
  verbs: z.record(z.string(), z.boolean()).optional(),
});

export type Config = { url: string; token: string; name: string; adb: string; verbs: MacVerb[] };

export function loadConfig(path = CONFIG_PATH): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Can't read ${path}: ${err instanceof Error ? err.message : String(err)}. Run macos/setup.sh first.`);
  }
  const f = File.parse(raw);
  return {
    url: f.url.replace(/\/+$/, ""),
    token: f.token,
    name: f.name ?? hostname().replace(/\.local$/, ""),
    adb: f.adb ?? "/opt/homebrew/bin/adb",
    verbs: MAC_VERBS.filter((v) => f.verbs?.[v] !== false),
  };
}
