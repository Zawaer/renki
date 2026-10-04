import { createContext, useContext } from "react";

/**
 * Where a Markdown link to a file in the session's working tree goes. Provided
 * by SessionView around the transcript (open it in the Files panel) and by the
 * Files panel's own Markdown viewer (links relative to the file being viewed).
 * With no provider — or no handler — file links render as inert text.
 */
export type FileLinkTarget = {
  /** The session's absolute worktree root, when known; relative links match without it. */
  worktreePath: string | null;
  /** Worktree-relative directory relative links resolve against ("" = root). */
  fromDir?: string;
  onOpenFile: (path: string, line?: number) => void;
};

export const FileLinkContext = createContext<FileLinkTarget | null>(null);

export function useFileLinkTarget(): FileLinkTarget | null {
  return useContext(FileLinkContext);
}
