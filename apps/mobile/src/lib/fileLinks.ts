import { createContext, useContext } from "react";

/**
 * Where a Markdown link to a file in the session's working tree goes — the
 * phone's file sheet. Provided by SessionView around the transcript; with no
 * provider, file links are inert (tapping one does nothing rather than handing
 * a relative path to the browser).
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
