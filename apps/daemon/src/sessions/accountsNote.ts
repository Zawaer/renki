/**
 * Sessions run on whichever account the rotator has active, and nothing in
 * their context says there's more than one. So when a subagent came back with
 * "You've hit your limit · resets 7:50pm", the session told the user to wait
 * for the reset, and that any agent it started would hit the same wall, while
 * the rotator had already moved to an account with plenty left. Tell each
 * session once, the way timeZoneNote does, and only when it's true: rotation
 * on and more than one account to rotate between.
 */
export function accountsNote(rotatingAccounts: number): string | null {
  if (rotatingAccounts < 2) return null;
  const note =
    `Renki runs you on one of ${rotatingAccounts} Claude accounts and switches to another when the active one reaches its usage limit. ` +
    "A usage limit message, from you or from a subagent, only means the account in use at that moment ran out. " +
    "Don't tell the user to wait for that reset, and don't assume new agents would hit the same limit: retry the work or start the agent again. " +
    "If every account is out, your own turn stops on the limit and Renki resumes it when one frees up.";
  return `<renki-context>${note}</renki-context>\n\n`;
}
