import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { logger } from "../logger.js";

/**
 * The machine sessions run on, told to every session (see systemPrompt.ts) so
 * it plans compute from facts: a session once estimated hours of CPU work on
 * "a slow 4-core CPU" from a stale note, on a 32-thread Ryzen with an RTX 4070
 * it didn't know it had. Read once when the daemon starts; a GPU shows only
 * when the container has one (nvidia-smi is there and answers).
 */
export type Hardware = { cpu: string; threads: number; memoryGb: number; gpus: string[]; diskFreeGb: number | null };

export function detectHardware(dataDir: string): Hardware {
  const list = cpus();
  const cpu = (list[0]?.model ?? "unknown CPU").replace(/\s+/g, " ").trim();
  let gpus: string[] = [];
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    gpus = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, mib] = l.split(",").map((s) => s.trim());
        const gb = Number(mib) / 1024;
        return Number.isFinite(gb) && gb > 0 ? `${name} (${Math.round(gb)} GB)` : name!;
      });
  } catch {
    // No NVIDIA GPU visible to this container.
  }
  let diskFreeGb: number | null = null;
  try {
    const s = statfsSync(dataDir);
    diskFreeGb = Math.round((s.bavail * s.bsize) / 1024 ** 3);
  } catch {
    // Unknown.
  }
  const hw = { cpu, threads: list.length, memoryGb: Math.round(totalmem() / 1024 ** 3), gpus, diskFreeGb };
  logger.info("hardware", hw);
  return hw;
}

/** The section of the system prompt that describes it. */
export function hardwareNote(hw: Hardware): string {
  const gpu = hw.gpus.length
    ? `GPU: ${hw.gpus.join(", ")}, usable from here with CUDA (PyTorch's CUDA wheels work; check with \`nvidia-smi\`).`
    : "No GPU is available here.";
  const disk = hw.diskFreeGb !== null ? ` About ${hw.diskFreeGb} GB of disk was free when Renki started.` : "";
  return `

## This machine
You run on: ${hw.cpu}, ${hw.threads} threads, ${hw.memoryGb} GB RAM. ${gpu}${disk} Other sessions and the user's services share it, so leave headroom on long jobs. Plan compute from this, not from older notes.`;
}
