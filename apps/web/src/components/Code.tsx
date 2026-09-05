import { tokenizeJson, tokenizeShell, type SyntaxKind } from "@crc/client-core";
import { memo } from "react";

/**
 * Syntax-coloured code for the two things a transcript actually shows: the
 * shell command a tool wants to run, and a JSON tool payload. Colours come
 * from the theme tokens, so this tracks light/dark and the VS Code host
 * automatically.
 */

const TONE: Record<SyntaxKind, string> = {
  command: "text-(--crc-link)",
  argument: "text-(--crc-success)",
  flag: "text-(--crc-fg)",
  string: "text-(--crc-success)",
  variable: "text-(--crc-warning)",
  operator: "text-(--crc-fg-muted)",
  comment: "text-(--crc-fg-muted) italic",
  key: "text-(--crc-link)",
  number: "text-(--crc-warning)",
  literal: "text-(--crc-warning)",
  punct: "text-(--crc-fg-muted)",
  plain: "",
};

function Tokens({ tokens }: { tokens: { text: string; kind: SyntaxKind }[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={TONE[t.kind]}>
          {t.text}
        </span>
      ))}
    </>
  );
}

/** A shell command, with the `$` prompt marker the way a terminal shows it. */
export const ShellCode = memo(function ShellCode({ command, className = "" }: { command: string; className?: string }) {
  return (
    <pre className={`overflow-x-auto rounded-lg bg-(--crc-bg-inset)/70 px-3 py-2 font-mono leading-relaxed text-(--crc-fg) ${className}`}>
      <span className="mr-2 select-none text-(--crc-fg-muted)">$</span>
      <Tokens tokens={tokenizeShell(command)} />
    </pre>
  );
});

/** A JSON payload (a tool's raw input when there's no nicer view for it). */
export const JsonCode = memo(function JsonCode({ json, className = "" }: { json: string; className?: string }) {
  return (
    <pre className={`overflow-x-auto rounded-lg bg-(--crc-bg-inset)/70 px-3 py-2 font-mono leading-relaxed text-(--crc-fg) ${className}`}>
      <Tokens tokens={tokenizeJson(json)} />
    </pre>
  );
});
