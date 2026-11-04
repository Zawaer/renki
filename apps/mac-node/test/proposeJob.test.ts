import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dialogText, proposeJob } from "../src/proposeJob.js";

function config() {
  const path = join(mkdtempSync(join(tmpdir(), "mac-")), "mac-node.json");
  writeFileSync(path, JSON.stringify({ url: "https://x/api", token: "t", jobs: { matka: { old: { command: "true", signApks: "/k" } } } }));
  return path;
}
const job = { project: "life-api", job: "phone-apk", description: "Release APK", command: "cd phone && ./gradlew assembleRelease", artifacts: ["phone/app.apk"], installApk: "phone/app.apk" };

describe("proposeJob", () => {
  it("adds nothing unless the user clicks Add on the Mac", async () => {
    const path = config();
    const before = readFileSync(path, "utf8");
    expect(await proposeJob(path, job, async () => false)).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("shows the exact command, and writes the job without any signing", async () => {
    const path = config();
    let shown = "";
    const r = await proposeJob(path, job, async (t) => ((shown = t), true));
    expect(r.ok).toBe(true);
    expect(shown).toContain(job.command);
    const jobs = JSON.parse(readFileSync(path, "utf8")).jobs;
    expect(jobs["life-api"]["phone-apk"]).toEqual({ description: "Release APK", command: job.command, timeoutMinutes: 20, artifacts: ["phone/app.apk"], installApk: "phone/app.apk" });
    expect(jobs.matka.old.signApks).toBe("/k");
  });

  it("never replaces an existing job, and wants installApk among the artifacts", async () => {
    const path = config();
    const never = async () => {
      throw new Error("must not ask");
    };
    expect(await proposeJob(path, { ...job, project: "matka", job: "old" }, never)).toMatchObject({ ok: false });
    expect(await proposeJob(path, { ...job, installApk: "other.apk" }, never)).toMatchObject({ ok: false });
  });

  it("says where the job runs", () => {
    expect(dialogText(job)).toContain("build VM");
  });
});
