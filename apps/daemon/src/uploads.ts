import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { MAX_UPLOAD_BYTES, UploadId, type UploadRef } from "@renki/protocol";
import { logger } from "./logger.js";

/**
 * Files sent by reference (see UploadRef in @renki/protocol): too big, or of a
 * kind, to ride inline in a message. POST /uploads streams one to
 * `<dataDir>/uploads/<id>/<name>`, before any chat may exist (the home screen
 * starts one with the message). Sending the message claims it: the file moves
 * into the chat's own attachments folder, which Claude can read and which goes
 * when the chat is deleted. Ones never claimed are swept after a day.
 */
export class UploadTooLarge extends Error {}

export class Uploads {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "uploads");
  }

  /** Streams `body` to disk. Throws UploadTooLarge (and keeps nothing) past MAX_UPLOAD_BYTES. */
  async save(body: Readable, rawName: string): Promise<UploadRef> {
    const id = `u_${randomBytes(12).toString("hex")}`;
    const name = safeName(rawName);
    const folder = join(this.dir, id);
    mkdirSync(folder, { recursive: true });
    let size = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) return done(new UploadTooLarge(`over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`));
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, count, createWriteStream(join(folder, name), { mode: 0o600 }));
    } catch (err) {
      rmSync(folder, { recursive: true, force: true });
      throw err;
    }
    logger.info("upload saved", { id, name, size });
    return { id, name, size };
  }

  /**
   * Moves an upload into `targetDir/<id>/<name>` and returns that path. Null when
   * it isn't there (never uploaded, swept, or claimed already) or doesn't match.
   */
  claim(ref: UploadRef, targetDir: string): string | null {
    if (!UploadId.safeParse(ref.id).success) return null;
    const from = join(this.dir, ref.id, safeName(ref.name));
    if (!existsSync(from)) return null;
    const folder = join(targetDir, ref.id);
    mkdirSync(folder, { recursive: true });
    const to = join(folder, safeName(ref.name));
    renameSync(from, to);
    rmSync(join(this.dir, ref.id), { recursive: true, force: true });
    return to;
  }

  /** Removes uploads nobody sent within `maxAgeMs`. */
  sweep(maxAgeMs = 24 * 60 * 60_000): void {
    if (!existsSync(this.dir)) return;
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of readdirSync(this.dir)) {
      const path = join(this.dir, entry);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
      } catch {
        // Gone meanwhile.
      }
    }
  }
}

/** A file name safe to use as one path segment, keeping the extension Claude reads it by. */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned || "file";
}

/** "12.3 MB" */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
