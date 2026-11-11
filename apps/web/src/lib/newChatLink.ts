import type { RepoChoice } from "@renki/client-core";

/**
 * A link that opens a new chat with a prompt filled in but not sent:
 *
 *     https://renki.internal/new?project=life#prompt=The%20backup%20check%20is%20red...
 *
 * Other tools (Life's Homelab page, "Fix with Renki") open it. The prompt sits
 * after `#` so it never reaches a server or proxy log, and it is only put in
 * the composer: nothing runs until the user reads it and presses send. That is
 * the whole safety story, so never send it automatically.
 */
export type NewChatLink = { project: string | null; prompt: string | null };

export function parseNewChatLink(pathname: string, search: string, hash: string): NewChatLink | null {
  if (pathname.replace(/\/+$/, "") !== "/new") return null;
  const project = new URLSearchParams(search).get("project")?.trim() || null;
  const prompt = new URLSearchParams(hash.replace(/^#/, "")).get("prompt");
  return { project, prompt: prompt && prompt.trim() ? prompt : null };
}

/** Whether a repo is the one a link names: its folder, id, owner/name or just name on GitHub. */
export function matchesProject(choice: RepoChoice, project: string): boolean {
  const want = project.trim().toLowerCase();
  const names = [choice.local?.id, choice.local?.name, choice.fullName, choice.fullName?.split("/").pop(), choice.local?.remote ?? undefined];
  return names.some((n) => n?.toLowerCase() === want);
}
