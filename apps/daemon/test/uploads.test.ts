import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MAX_UPLOAD_BYTES } from "@renki/protocol";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { describeUpload } from "../src/claude/archives.js";
import { UploadTooLarge, Uploads, safeName } from "../src/uploads.js";

const dir = () => mkdtempSync(join(tmpdir(), "uploads-"));

describe("Uploads", () => {
  it("streams to disk, then moves into the chat when claimed, once", async () => {
    const u = new Uploads(dir());
    const ref = await u.save(Readable.from([Buffer.from("hello "), Buffer.from("world")]), "model.glb");
    expect(ref).toMatchObject({ name: "model.glb", size: 11 });
    const target = dir();
    const path = u.claim(ref, target)!;
    expect(path).toBe(join(target, ref.id, "model.glb"));
    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(u.claim(ref, target)).toBeNull(); // claimed already
    expect(u.claim({ ...ref, id: "u_../../etc" }, target)).toBeNull();
  });

  it("refuses a file over the limit and keeps nothing of it", async () => {
    const d = dir();
    const u = new Uploads(d);
    const big = Readable.from((function* () {
      for (let i = 0; i <= MAX_UPLOAD_BYTES / (1024 * 1024); i++) yield Buffer.alloc(1024 * 1024);
    })());
    await expect(u.save(big, "huge.bin")).rejects.toBeInstanceOf(UploadTooLarge);
    expect(existsSync(u.dir) ? readdirSync(u.dir) : []).toEqual([]);
  });

  it("sweeps uploads nobody sent", async () => {
    const u = new Uploads(dir());
    const ref = await u.save(Readable.from([Buffer.from("x")]), "a.txt");
    const old = new Date(Date.now() - 2 * 86400_000);
    utimesSync(join(u.dir, ref.id), old, old);
    u.sweep();
    expect(u.claim(ref, dir())).toBeNull();
  });

  it("keeps names to one safe path segment", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\\\x\\\\y.zip")).toBe("y.zip");
    expect(safeName("...hidden")).toBe("hidden");
    expect(safeName("")).toBe("file");
  });
});

describe("describeUpload", () => {
  it("says where a file is, and unpacks a zip next to it once", () => {
    const d = dir();
    expect(describeUpload("legion.glb", join(d, "legion.glb"), 5 * 1024 * 1024)).toBe(`[The user attached legion.glb (5.0 MB). It's at ${join(d, "legion.glb")}]`);
    const zip = join(d, "snap.zip");
    writeFileSync(zip, zipSync({ "model/scene.gltf": new TextEncoder().encode("{}"), "../evil": new Uint8Array([1]) }));
    const note = describeUpload("snap.zip", zip, 100);
    expect(note).toContain(`unpacked to ${join(d, "snap")}`);
    expect(note).toContain("model/scene.gltf");
    expect(existsSync(join(d, "snap", "model", "scene.gltf"))).toBe(true);
    expect(existsSync(join(d, "evil"))).toBe(false);
    expect(describeUpload("snap.zip", zip, 100)).toContain("already unpacked");
  });
});
