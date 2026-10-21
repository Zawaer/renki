import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { MacVerbArgs, type MacArgs, type MacImage, type MacVerb } from "@renki/protocol";

/**
 * What each verb actually runs on the Mac. This file is the wall between a
 * session on the homelab and this Mac:
 *
 * - every call's args are parsed again here with the shared schemas, so a
 *   daemon (or anything that took it over) can't send a shape we didn't plan for;
 * - `adb` is always started with an argv array, never through a Mac shell;
 * - only `adb devices/exec-out/logcat/shell/install` are ever invoked, so no
 *   verb can become `adb pull`, `push` or `forward` and touch the Mac itself.
 *
 * `shell` runs a command in the PHONE's shell, which is the point of it; the
 * daemon asks the user before each one.
 */

export type Exec = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; encoding?: "buffer" },
) => Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;

export type Result = { ok: boolean; text: string; image?: MacImage };

export type AdbDeps = {
  adb: string;
  exec?: Exec;
  /** Download an offered file (install) to `dest`. */
  download: (fileId: string, dest: string) => Promise<void>;
};

const MAX_TEXT = 100_000;

export const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        // A number is the exit code; a string (ENOENT…) means it never ran.
        const code = !e ? 0 : typeof e.code === "number" ? e.code : 1;
        const note = !e ? "" : e.killed ? `timed out after ${Math.round(opts.timeoutMs / 1000)}s\n` : typeof e.code === "string" ? `${e.message}\n` : "";
        resolve({ stdout: stdout ?? Buffer.alloc(0), stderr: Buffer.concat([Buffer.from(note), stderr ?? Buffer.alloc(0)]), code });
      },
    );
  });

/** Keep the end of long output: that's where errors and the newest log lines are. */
export function capText(s: string, max = MAX_TEXT): string {
  return s.length > max ? `…(${s.length - max} earlier characters cut)\n${s.slice(-max)}` : s;
}

/** Quote one word for the phone's /system/bin/sh (adb shell joins its args into one command line). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `adb devices` output -> serials that are ready ("device" state), and the rest with their state. */
export function parseDevices(out: string): { ready: string[]; other: Array<{ serial: string; state: string }> } {
  const ready: string[] = [];
  const other: Array<{ serial: string; state: string }> = [];
  for (const line of out.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial || !state) continue;
    if (state === "device") ready.push(serial);
    else other.push({ serial, state });
  }
  return { ready, other };
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The argv after `adb -s <serial>` for an input action. Everything numeric or pattern-checked; text is quoted. */
export function inputArgv(action: MacArgs<"input">["action"]): string[] {
  switch (action.kind) {
    case "tap":
      return ["shell", "input", "tap", String(action.x), String(action.y)];
    case "swipe":
      return ["shell", "input", "swipe", String(action.x1), String(action.y1), String(action.x2), String(action.y2), String(action.durationMs ?? 300)];
    case "key":
      return ["shell", "input", "keyevent", /^\d+$/.test(action.key) || action.key.startsWith("KEYCODE_") ? action.key : `KEYCODE_${action.key}`];
    case "text":
      // `input text` reads %s as a space; a literal space would end the argument.
      return ["shell", "input", "text", shQuote(action.text.replace(/ /g, "%s"))];
  }
}

export function logcatArgv(args: MacArgs<"logcat">): string[] {
  return ["logcat", "-d", "-v", "time", "-t", String(args.lines ?? 300), ...(args.tags?.length ? [...args.tags, "*:S"] : [])];
}

export class Adb {
  private readonly exec: Exec;

  constructor(private readonly deps: AdbDeps) {
    this.exec = deps.exec ?? realExec;
  }

  /** Parse and run one call. Never throws. */
  async run(verb: MacVerb, rawArgs: unknown): Promise<Result> {
    const parsed = MacVerbArgs[verb].safeParse(rawArgs);
    if (!parsed.success) return { ok: false, text: `Refused by the Mac: bad arguments for ${verb}. ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    try {
      switch (verb) {
        case "devices":
          return await this.devices();
        case "screenshot":
          return await this.screenshot(parsed.data as MacArgs<"screenshot">);
        case "logcat":
          return await this.logcat(parsed.data as MacArgs<"logcat">);
        case "input":
          return await this.input(parsed.data as MacArgs<"input">);
        case "shell":
          return await this.shell(parsed.data as MacArgs<"shell">);
        case "install":
          return await this.install(parsed.data as MacArgs<"install">);
        default:
          return { ok: false, text: `${verb} isn't an adb verb.` };
      }
    } catch (err) {
      return { ok: false, text: `Failed on the Mac: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private adb(args: string[], timeoutMs: number) {
    return this.exec(this.deps.adb, args, { timeoutMs });
  }

  private async devices(): Promise<Result> {
    const r = await this.adb(["devices", "-l"], 15_000);
    const out = r.stdout.toString();
    if (r.code !== 0) return { ok: false, text: `adb devices failed: ${r.stderr.toString() || out}` };
    const { ready, other } = parseDevices(out);
    const hints = other.map((d) =>
      d.state === "unauthorized"
        ? `${d.serial} is unauthorized: the user has to accept the "Allow USB debugging?" prompt on the phone.`
        : `${d.serial} is ${d.state}.`,
    );
    return { ok: true, text: [out.trim(), ready.length === 0 ? "No phone is ready." : "", ...hints].filter(Boolean).join("\n") };
  }

  /** The serial to talk to: the one asked for, else the only ready device. */
  private async serial(asked: string | undefined): Promise<string> {
    if (asked) return asked;
    const r = await this.adb(["devices"], 15_000);
    const { ready, other } = parseDevices(r.stdout.toString());
    if (ready.length === 1) return ready[0]!;
    if (ready.length > 1) throw new Error(`more than one phone is connected (${ready.join(", ")}); pass \`serial\`.`);
    const unauthorized = other.find((d) => d.state === "unauthorized");
    if (unauthorized) throw new Error(`the phone (${unauthorized.serial}) hasn't allowed USB debugging from this Mac yet; the user has to accept the prompt on the phone.`);
    throw new Error("no phone is connected to the Mac. Ask the user to plug it in (or pair wireless debugging) and unlock it.");
  }

  private async screenshot(args: MacArgs<"screenshot">): Promise<Result> {
    const s = await this.serial(args.serial);
    const r = await this.adb(["-s", s, "exec-out", "screencap", "-p"], 25_000);
    const size = pngSize(r.stdout);
    if (r.code !== 0 || !size) return { ok: false, text: `screencap failed: ${r.stderr.toString().trim() || "no image came back (is the screen on and unlocked?)"}` };

    // Scale down and recompress with macOS's own `sips`: a phone PNG is several MB.
    const dir = await mkdtemp(join(tmpdir(), "renki-shot-"));
    try {
      const png = join(dir, "screen.png");
      const jpg = join(dir, "screen.jpg");
      await writeFile(png, r.stdout);
      const sips = await this.exec("/usr/bin/sips", ["-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "70", png, "--out", jpg], { timeoutMs: 20_000 });
      const scaled = sips.code === 0;
      const data = scaled ? await readFile(jpg) : r.stdout;
      const longSide = Math.max(size.width, size.height);
      const factor = scaled && longSide > 1600 ? 1600 / longSide : 1;
      return {
        ok: true,
        text:
          `Screen of ${s}: ${size.width}x${size.height} pixels.` +
          (factor < 1 ? ` The image is scaled to ${Math.round(factor * 100)}%; divide its coordinates by ${factor.toFixed(4)} for phone_input.` : ""),
        image: { mediaType: scaled ? "image/jpeg" : "image/png", data: data.toString("base64") },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async logcat(args: MacArgs<"logcat">): Promise<Result> {
    const s = await this.serial(args.serial);
    const r = await this.adb(["-s", s, ...logcatArgv(args)], 25_000);
    if (r.code !== 0) return { ok: false, text: `logcat failed: ${r.stderr.toString()}` };
    let lines = r.stdout.toString().split("\n");
    if (args.grep) {
      const needle = args.grep.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(needle));
    }
    if (args.clear) await this.adb(["-s", s, "logcat", "-c"], 15_000);
    const text = lines.join("\n").trim();
    return { ok: true, text: text ? capText(text) : "(no matching log lines)" };
  }

  private async input(args: MacArgs<"input">): Promise<Result> {
    const s = await this.serial(args.serial);
    const r = await this.adb(["-s", s, ...inputArgv(args.action)], 15_000);
    const err = r.stderr.toString().trim() || (r.code !== 0 ? r.stdout.toString().trim() : "");
    return r.code === 0 && !err ? { ok: true, text: `Sent ${args.action.kind} to ${s}.` } : { ok: false, text: `input failed: ${err}` };
  }

  private async shell(args: MacArgs<"shell">): Promise<Result> {
    const s = await this.serial(args.serial);
    // One argument: adb hands it to the phone's sh as the whole command line.
    const r = await this.adb(["-s", s, "shell", args.command], 55_000);
    const out = [r.stdout.toString(), r.stderr.toString()].filter((x) => x.trim()).join("\n").trim();
    return { ok: r.code === 0, text: capText(`${out || "(no output)"}${r.code !== 0 ? `\n(exit code ${r.code})` : ""}`) };
  }

  private async install(args: MacArgs<"install">): Promise<Result> {
    const dir = await mkdtemp(join(tmpdir(), "renki-apk-"));
    try {
      const apk = join(dir, "app.apk");
      await this.deps.download(args.fileId, apk);
      return await this.installLocal(apk, args.name, args.serial, args.downgrade);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Install an APK already on this Mac (a build job's output). Never throws. */
  async installLocal(apk: string, name: string, serial?: string, downgrade?: boolean): Promise<Result> {
    try {
      const s = await this.serial(serial);
      const r = await this.adb(["-s", s, "install", "-r", ...(downgrade ? ["-d"] : []), apk], 5 * 60_000);
      const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
      const ok = r.code === 0 && /Success/.test(out);
      return { ok, text: ok ? `Installed ${name} on ${s}.` : `Install of ${name} failed: ${capText(out, 4000)}` };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Stream an HTTP response body to a file. */
export async function saveResponse(res: Response, dest: string): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}
