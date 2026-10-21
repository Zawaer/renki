import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MacArgs } from "@renki/protocol";
import { type Exec, type Result, capText, realExec } from "./adb.js";

/**
 * Dev boards on the Mac's USB serial ports (verbs serial_ports, serial_read,
 * esp_reset, esp_flash), through the ESP-IDF Python's pyserial and esptool.
 *
 * Every program here has a fixed argv: the port must be a USB serial device
 * that exists, offsets are hex, and flashed images are files the daemon
 * offered, downloaded to a fresh temp folder. Nothing a session sends becomes
 * a command, a path on the Mac or Python code.
 *
 * The monitor is kept running per port while lending is on, so output printed
 * between two reads (a board's update check minutes after boot) isn't lost.
 * It reconnects by itself: an ESP32-S3 on its native USB re-enumerates on
 * every reset. Reset and flash pause it, since they need the port to themselves.
 */

/** USB serial devices as macOS names them; Bluetooth and debug ports are left out. */
const USB_PORT = /^cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)[\w.-]*$/;

const BAUD = 115_200;
const KEEP_BYTES = 2 * 1024 * 1024;
const MAX_REPLY = 30_000;

/** Read a port forever, reopening it whenever it goes away. Opening must not reset the board, hence DTR/RTS off. */
const MONITOR_PY = `
import sys, time, serial
port, baud = sys.argv[1], int(sys.argv[2])
out = sys.stdout.buffer
while True:
    s = serial.Serial()
    try:
        s.port, s.baudrate, s.timeout = port, baud, 0.5
        s.dtr = False
        s.rts = False
        s.open()
        out.write(("\\n[monitor: connected to %s]\\n" % port).encode()); out.flush()
        while True:
            data = s.read(4096)
            if data:
                out.write(data); out.flush()
    except (serial.SerialException, OSError):
        try:
            s.close()
        except Exception:
            pass
        time.sleep(1)
`;

class Monitor {
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  /** Byte offset of chunks[0] in everything this monitor has read. */
  private start = 0;
  private total = 0;

  constructor(
    private readonly python: string,
    private readonly port: string,
  ) {}

  ensure(): void {
    if (this.proc) return;
    const proc = spawn(this.python, ["-u", "-c", MONITOR_PY, this.port, String(BAUD)], { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout!.on("data", (d: Buffer) => this.append(d));
    proc.stderr!.on("data", (d: Buffer) => this.append(Buffer.concat([Buffer.from("[monitor error] "), d])));
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  note(text: string): void {
    this.append(Buffer.from(`\n[${text}]\n`));
  }

  private append(d: Buffer): void {
    this.chunks.push(d);
    this.total += d.length;
    while (this.total - this.start > KEEP_BYTES && this.chunks.length > 1) this.start += this.chunks.shift()!.length;
  }

  /** Everything from byte `since` on, and where the next read should start. */
  read(since: number | undefined): { text: string; next: number; dropped: boolean } {
    const all = Buffer.concat(this.chunks);
    if (since === undefined) {
      // A first look: the most recent lines.
      return { text: all.toString("utf8").split("\n").slice(-200).join("\n"), next: this.total, dropped: false };
    }
    const from = Math.max(since, this.start) - this.start;
    return { text: all.subarray(Math.min(from, all.length)).toString("utf8"), next: this.total, dropped: since < this.start };
  }
}

export class Serial {
  private readonly monitors = new Map<string, Monitor>();
  private readonly exec: Exec;

  constructor(
    private readonly deps: {
      python: string;
      /** Download an offered file (esp_flash) to `dest`. */
      download: (fileId: string, dest: string) => Promise<void>;
      exec?: Exec;
      listDev?: () => string[];
    },
  ) {
    this.exec = deps.exec ?? realExec;
  }

  /** Parse-checked args in, never throws. */
  async run(verb: "serial_ports" | "serial_read" | "esp_reset" | "esp_flash", args: unknown): Promise<Result> {
    try {
      switch (verb) {
        case "serial_ports":
          return this.portsResult();
        case "serial_read":
          return this.read(args as MacArgs<"serial_read">);
        case "esp_reset":
          return await this.reset(args as MacArgs<"esp_reset">);
        case "esp_flash":
          return await this.flash(args as MacArgs<"esp_flash">);
      }
    } catch (err) {
      return { ok: false, text: `Failed on the Mac: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  stopAll(): void {
    for (const m of this.monitors.values()) m.stop();
    this.monitors.clear();
  }

  private ports(): string[] {
    const names = this.deps.listDev ? this.deps.listDev() : readdirSync("/dev");
    return names.filter((n) => USB_PORT.test(n)).map((n) => `/dev/${n}`).sort();
  }

  private portsResult(): Result {
    const ports = this.ports();
    return { ok: true, text: ports.length ? `USB serial ports on this Mac:\n${ports.join("\n")}` : "No USB serial device is plugged into this Mac." };
  }

  /** The port asked for (it must be a USB serial device that's there), or the only one. */
  private pick(port: string | undefined): string {
    const ports = this.ports();
    if (port) {
      if (!ports.includes(port)) throw new Error(`${port} isn't a USB serial device on this Mac right now. Ports: ${ports.join(", ") || "none"}.`);
      return port;
    }
    if (ports.length === 1) return ports[0]!;
    throw new Error(ports.length ? `More than one board is plugged in; pass port (${ports.join(", ")}).` : "No USB serial device is plugged into this Mac.");
  }

  private monitor(port: string): Monitor {
    let m = this.monitors.get(port);
    if (!m) {
      m = new Monitor(this.deps.python, port);
      this.monitors.set(port, m);
    }
    m.ensure();
    return m;
  }

  private read(args: MacArgs<"serial_read">): Result {
    const port = this.pick(args.port);
    const fresh = !this.monitors.has(port);
    const m = this.monitor(port);
    const r = m.read(args.since);
    let text = r.text;
    if (args.grep) {
      const needle = args.grep.toLowerCase();
      text = text.split("\n").filter((l) => l.toLowerCase().includes(needle)).join("\n");
    }
    const head = [
      fresh ? `Started monitoring ${port} at ${BAUD} baud; it keeps collecting while this Mac is lent, so read again with since=${r.next} for what's new.` : `${port}:`,
      r.dropped ? "(Older output was dropped: only the last 2 MB is kept.)" : "",
    ].filter(Boolean);
    return { ok: true, text: `${head.join("\n")}\n${capText(text.trim(), MAX_REPLY) || "(nothing new)"}\n\nnext: ${r.next}` };
  }

  private esptool(args: string[], timeoutMs: number) {
    return this.exec(this.deps.python, [join(dirname(this.deps.python), "esptool.py"), ...args], { timeoutMs });
  }

  /** Run with the port to itself: the monitor pauses and picks up again afterwards. */
  private async withPort<T>(port: string, what: string, fn: () => Promise<T>): Promise<T> {
    const m = this.monitors.get(port);
    m?.stop();
    m?.note(`monitor paused: ${what}`);
    try {
      return await fn();
    } finally {
      if (m) {
        m.note(`monitor resumed after ${what}`);
        m.ensure();
      }
    }
  }

  private async reset(args: MacArgs<"esp_reset">): Promise<Result> {
    const port = this.pick(args.port);
    const r = await this.withPort(port, "reset", () =>
      this.esptool(["--chip", "auto", "-p", port, "--before", "default_reset", "--after", "hard_reset", "chip_id"], 60_000),
    );
    const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
    return r.code === 0
      ? { ok: true, text: `Reset the board on ${port}. Read its boot with serial_read.\n${capText(out, 2000)}` }
      : { ok: false, text: `Reset failed on ${port}: ${capText(out, 4000)}` };
  }

  private async flash(args: MacArgs<"esp_flash">): Promise<Result> {
    const port = this.pick(args.port);
    const dir = await mkdtemp(join(tmpdir(), "renki-esp-"));
    try {
      const pairs: string[] = [];
      for (const [i, img] of args.images.entries()) {
        const file = join(dir, `image-${i}.bin`);
        await this.deps.download(img.fileId, file);
        pairs.push(img.offset, file);
      }
      const r = await this.withPort(port, "flashing", () =>
        this.esptool(
          ["--chip", "auto", "-p", port, "-b", "460800", "--before", "default_reset", "--after", "hard_reset", "write_flash", ...(args.erase ? ["-e"] : []), ...pairs],
          10 * 60_000,
        ),
      );
      const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
      const names = args.images.map((i) => `${i.name} at ${i.offset}`).join(", ");
      return r.code === 0
        ? { ok: true, text: `Flashed ${names} to ${port}${args.erase ? " (whole chip erased first)" : ""}, and reset it.\n${capText(out, 3000)}` }
        : { ok: false, text: `Flashing ${port} failed: ${capText(out, 6000)}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
