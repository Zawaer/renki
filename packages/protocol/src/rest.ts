import { z } from "zod";
import { Repo, Session } from "./domain.js";
import { SessionEvent } from "./events.js";

/**
 * REST management API DTOs (Step 2). REST handles the "control plane" — the
 * discrete, request/response operations (list repos, create/list/archive
 * sessions, fetch a full transcript). The live conversation itself flows over
 * WebSocket. Keeping these separate means the heavy real-time path never has to
 * carry CRUD semantics.
 */

export const ListReposResponse = z.object({
  repos: z.array(Repo),
});
export type ListReposResponse = z.infer<typeof ListReposResponse>;

export const CreateSessionRequest = z.object({
  repoId: z.string().min(1),
  baseBranch: z.string().min(1),
  /** New branch to create for this session's worktree. Omit to derive one. */
  newBranch: z.string().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CreateSessionResponse = z.object({
  session: Session,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const ListSessionsResponse = z.object({
  sessions: z.array(Session),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;

/** Full transcript for cold-loading a session outside the WS flow. */
export const GetTranscriptResponse = z.object({
  session: Session,
  events: z.array(SessionEvent),
});
export type GetTranscriptResponse = z.infer<typeof GetTranscriptResponse>;
