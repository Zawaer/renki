import { execFile } from "node:child_process";
import type { RtkGainDay, RtkGainResponse, RtkGainSummary } from "@crc/protocol";

/** How many trailing days of `rtk gain --daily` to keep — matches rtk's own `--graph` window. */
const DAY_WINDOW = 30;

/**
 * Reads RTK's own `rtk gain --daily --format json` output — the same numbers
 * a user already gets running `rtk gain` on the daemon host themselves. CRC
 * doesn't compute any of this; it's read-only surfacing of RTK's local stats.
 * Only call this when `config.enableRtk` is on (see http.ts).
 */
export async function readRtkGain(bin: string): Promise<RtkGainResponse> {
  try {
    const raw = await run(bin, ["gain", "--daily", "--format", "json"]);
    return {
      enabled: true,
      available: true,
      error: null,
      summary: normalizeSummary(raw?.summary),
      daily: Array.isArray(raw?.daily) ? raw.daily.map(normalizeDay).slice(-DAY_WINDOW) : [],
    };
  } catch (err) {
    return {
      enabled: true,
      available: false,
      error: err instanceof Error ? err.message : String(err),
      summary: null,
      daily: [],
    };
  }
}

function run(bin: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin} ${args.join(" ")} failed: ${err.message} ${stderr ?? ""}`.trim()));
      try {
        resolve(JSON.parse(stdout.toString() || "{}"));
      } catch {
        reject(new Error(`${bin} ${args.join(" ")} returned non-JSON output`));
      }
    });
  });
}

function normalizeSummary(s: any): RtkGainSummary | null {
  if (!s) return null;
  return {
    totalCommands: Number(s.total_commands ?? 0),
    totalInputTokens: Number(s.total_input ?? 0),
    totalOutputTokens: Number(s.total_output ?? 0),
    totalSavedTokens: Number(s.total_saved ?? 0),
    avgSavingsPct: Number(s.avg_savings_pct ?? 0),
    totalTimeMs: Number(s.total_time_ms ?? 0),
    avgTimeMs: Number(s.avg_time_ms ?? 0),
  };
}

function normalizeDay(d: any): RtkGainDay {
  return {
    date: String(d?.date ?? ""),
    commands: Number(d?.commands ?? 0),
    inputTokens: Number(d?.input_tokens ?? 0),
    outputTokens: Number(d?.output_tokens ?? 0),
    savedTokens: Number(d?.saved_tokens ?? 0),
    savingsPct: Number(d?.savings_pct ?? 0),
    totalTimeMs: Number(d?.total_time_ms ?? 0),
    avgTimeMs: Number(d?.avg_time_ms ?? 0),
  };
}
