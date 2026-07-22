/** Typed, coded errors so the WS/REST layer (Step 2) can map them to responses. */
export type SessionErrorCode =
  | "session_not_found"
  | "repo_not_found"
  | "invalid_request"
  | "not_controller"
  | "session_busy"
  | "session_archived"
  | "queue_full"
  | "not_busy";

export class SessionError extends Error {
  constructor(
    public readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
