import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/adb.js";
import { Serial } from "../src/serial.js";

function setup(dev = ["cu.usbmodem14101", "cu.Bluetooth-Incoming-Port", "cu.debug-console", "tty.usbmodem14101"]) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), code: 0 };
  };
  const serial = new Serial({
    python: "/esp/env/bin/python",
    download: async (_id, dest) => writeFileSync(dest, "img"),
    exec,
    listDev: () => dev,
  });
  return { serial, calls };
}

describe("Serial", () => {
  it("lists only USB serial devices", async () => {
    const { serial } = setup();
    const r = await serial.run("serial_ports", {});
    expect(r.text).toContain("/dev/cu.usbmodem14101");
    expect(r.text).not.toContain("Bluetooth");
    expect(r.text).not.toContain("debug-console");
  });

  it("refuses a port that isn't a plugged-in USB serial device", async () => {
    const { serial, calls } = setup();
    const r = await serial.run("esp_reset", { port: "/dev/cu.Bluetooth-Incoming-Port" });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("resets with a fixed esptool argv, picking the only board", async () => {
    const { serial, calls } = setup();
    const r = await serial.run("esp_reset", {});
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      ["/esp/env/bin/python", "/esp/env/bin/esptool.py", "--chip", "auto", "-p", "/dev/cu.usbmodem14101", "--before", "default_reset", "--after", "hard_reset", "chip_id"],
    ]);
  });

  it("flashes downloaded images at their offsets", async () => {
    const { serial, calls } = setup();
    const r = await serial.run("esp_flash", {
      images: [
        { offset: "0x0", fileId: "f".repeat(16), name: "bootloader.bin" },
        { offset: "0x20000", fileId: "g".repeat(16), name: "app.bin" },
      ],
      erase: true,
    });
    expect(r.ok).toBe(true);
    const argv = calls[0]!;
    expect(argv.slice(0, 13)).toEqual([
      "/esp/env/bin/python", "/esp/env/bin/esptool.py", "--chip", "auto", "-p", "/dev/cu.usbmodem14101", "-b", "460800",
      "--before", "default_reset", "--after", "hard_reset", "write_flash",
    ]);
    expect(argv[13]).toBe("-e");
    expect(argv[14]).toBe("0x0");
    expect(argv[16]).toBe("0x20000");
    expect(argv[15]).toMatch(/image-0\.bin$/);
  });

  it("asks which board when several are plugged in", async () => {
    const { serial } = setup(["cu.usbmodem1", "cu.usbserial-0001"]);
    const r = await serial.run("esp_reset", {});
    expect(r.ok).toBe(false);
    expect(r.text).toContain("pass port");
  });
});
