import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude keeps a conversation's transcript under
 * ~/.claude/projects/<cwd with every non-alphanumeric turned into "-">/, and
 * `--resume` only looks in the folder for the CURRENT cwd. So a session whose
 * working directory changes has to take its transcript along, or the next turn
 * finds nothing to resume.
 */
function projectDir(cwd: string): string {
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * Copy (not move) a conversation's transcript, and its sidecar folder of
 * subagent transcripts if there is one, from one cwd's project folder to
 * another's. Copying leaves the original for as long as the old folder lives,
 * so a failure halfway can't lose it. Returns false when there was nothing to copy.
 */
export async function copyTranscript(claudeSessionId: string, fromCwd: string, toCwd: string): Promise<boolean> {
  const from = projectDir(fromCwd);
  const to = projectDir(toCwd);
  const file = `${claudeSessionId}.jsonl`;
  if (!existsSync(join(from, file))) return false;
  await mkdir(to, { recursive: true });
  await cp(join(from, file), join(to, file));
  if (existsSync(join(from, claudeSessionId))) {
    await cp(join(from, claudeSessionId), join(to, claudeSessionId), { recursive: true });
  }
  return true;
}
