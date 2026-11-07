import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { detectHardware, hardwareNote } from "../src/claude/hardware.js";

describe("hardware note", () => {
  it("describes the CPU, memory, GPU and disk", () => {
    const note = hardwareNote({ cpu: "AMD Ryzen 9 7945HX", threads: 32, memoryGb: 30, gpus: ["NVIDIA GeForce RTX 4070 Laptop GPU (8 GB)"], diskFreeGb: 1300 });
    expect(note).toContain("AMD Ryzen 9 7945HX, 32 threads, 30 GB RAM");
    expect(note).toContain("RTX 4070 Laptop GPU (8 GB), usable from here with CUDA");
    expect(note).toContain("1300 GB of disk");
  });

  it("says so when there's no GPU", () => {
    expect(hardwareNote({ cpu: "x", threads: 4, memoryGb: 8, gpus: [], diskFreeGb: null })).toContain("No GPU is available here.");
  });

  it("detects this machine without throwing", () => {
    const hw = detectHardware(tmpdir());
    expect(hw.threads).toBeGreaterThan(0);
    expect(hw.memoryGb).toBeGreaterThan(0);
  });
});
