/**
 * Dead-simple leveled logger. Everything goes to STDERR on purpose: the CLI
 * harness streams Claude's response to STDOUT, and we never want log lines
 * interleaved into that stream (or into a future pipe consumer).
 */
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold: Level = (process.env.RENKI_LOG_LEVEL as Level) ?? "info";

function log(level: Level, msg: string, extra?: unknown) {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  if (extra !== undefined) {
    process.stderr.write(`${ts} ${tag} ${msg} ${JSON.stringify(extra)}\n`);
  } else {
    process.stderr.write(`${ts} ${tag} ${msg}\n`);
  }
}

export const logger = {
  debug: (msg: string, extra?: unknown) => log("debug", msg, extra),
  info: (msg: string, extra?: unknown) => log("info", msg, extra),
  warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
  error: (msg: string, extra?: unknown) => log("error", msg, extra),
};
