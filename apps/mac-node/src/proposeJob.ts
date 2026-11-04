import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { MacArgs } from "@renki/protocol";
import type { Result } from "./adb.js";

/**
 * propose_job: a session suggests a build job, and the user decides in a
 * native dialog on this Mac. Only "Add job" writes it to mac-node.json; the
 * file watcher in index.ts then picks it up and tells the daemon. The dialog
 * is the point: a Renki approval card is drawn by the homelab, so it can't be
 * what lets a command onto the Mac.
 *
 * Proposed jobs never get signApks/signEspImages (those hand the job's output
 * to a key on this Mac) and never replace a job that exists.
 */

export type Ask = (text: string) => Promise<boolean>;

export function dialogText(a: MacArgs<"propose_job">): string {
  return [
    `A Renki chat in "${a.project}" wants to add a build job "${a.job}".`,
    a.description ? `\n${a.description}` : "",
    `\nCommand${a.cwd ? ` (in ${a.cwd})` : ""}:\n${a.command}`,
    a.artifacts?.length ? `\nSends back: ${a.artifacts.join(", ")}` : "",
    a.installApk ? `\nCan install on the phone: ${a.installApk}` : "",
    "\nIt runs in the build VM, which can't see this Mac's files or your network.",
  ].join("");
}

/** A dialog on the Mac. Text goes in as an argument, never into the script. Gives up (= no) after 10 minutes. */
export const macDialog: Ask = (text) =>
  new Promise((resolve) => {
    const script = [
      "on run argv",
      'display dialog (item 1 of argv) with title "Renki: add a build job?" buttons {"Don\'t add", "Add job"} default button "Don\'t add" cancel button "Don\'t add" with icon caution giving up after 600',
      "return button returned of result",
      "end run",
    ];
    execFile("osascript", [...script.flatMap((l) => ["-e", l]), text], { timeout: 11 * 60_000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === "Add job");
    });
  });

export async function proposeJob(configPath: string, a: MacArgs<"propose_job">, ask: Ask = macDialog): Promise<Result> {
  const read = () => JSON.parse(readFileSync(configPath, "utf8")) as { jobs?: Record<string, Record<string, unknown>> };
  if (read().jobs?.[a.project]?.[a.job]) {
    return { ok: false, text: `"${a.job}" already exists for ${a.project}. Pick another name; changing an existing job is a hand edit on the Mac.` };
  }
  if (a.installApk && !(a.artifacts ?? []).includes(a.installApk)) {
    return { ok: false, text: "installApk must be one of the artifacts." };
  }
  if (!(await ask(dialogText(a)))) return { ok: false, text: "The user didn't add the job on the Mac." };

  const file = read(); // again: it may have been edited while the dialog was open
  file.jobs ??= {};
  file.jobs[a.project] ??= {};
  if (file.jobs[a.project]![a.job]) return { ok: false, text: `"${a.job}" was added meanwhile; nothing changed.` };
  file.jobs[a.project]![a.job] = {
    description: a.description,
    command: a.command,
    ...(a.cwd ? { cwd: a.cwd } : {}),
    timeoutMinutes: a.timeoutMinutes ?? 20,
    artifacts: a.artifacts ?? [],
    ...(a.installApk ? { installApk: a.installApk } : {}),
  };
  const backup = `${configPath}.bak-${new Date().toISOString().slice(0, 10)}`;
  if (!existsSync(backup)) copyFileSync(configPath, backup);
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, configPath);
  return { ok: true, text: `Added "${a.job}" for ${a.project}. It's in mac_build's list within a few seconds.` };
}
