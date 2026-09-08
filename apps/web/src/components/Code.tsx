import { tokenizeJson, tokenizeShell, type SyntaxKind } from "@renki/client-core";
import { memo } from "react";
import { Collapsible } from "./ui.js";

/**
 * Syntax-coloured code for the two things a transcript actually shows: the
 * shell command a tool wants to run, and a JSON tool payload. Colours come
 * from the theme tokens, so this tracks light/dark and the VS Code host
 * automatically.
 */

const TONE: Record<SyntaxKind, string> = {
  command: "text-(--renki-link)",
  argument: "text-(--renki-success)",
  flag: "text-(--renki-fg)",
  string: "text-(--renki-success)",
  variable: "text-(--renki-warning)",
  operator: "text-(--renki-fg-muted)",
  comment: "text-(--renki-fg-muted) italic",
  key: "text-(--renki-link)",
  number: "text-(--renki-warning)",
  literal: "text-(--renki-warning)",
  punct: "text-(--renki-fg-muted)",
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
    <Collapsible text={command} collapseLines={14} copyLabel="Copy command">
      <pre className={`overflow-x-auto rounded-lg bg-(--renki-bg-inset)/70 px-3 py-2 font-mono leading-relaxed text-(--renki-fg) ${className}`}>
        <span className="mr-2 select-none text-(--renki-fg-muted)">$</span>
        <Tokens tokens={tokenizeShell(command)} />
      </pre>
    </Collapsible>
  );
});

/** A JSON payload (a tool's raw input when there's no nicer view for it). */
export const JsonCode = memo(function JsonCode({ json, className = "" }: { json: string; className?: string }) {
  return (
    <Collapsible text={json} collapseLines={14} copyLabel="Copy JSON">
      <pre className={`overflow-x-auto rounded-lg bg-(--renki-bg-inset)/70 px-3 py-2 font-mono leading-relaxed text-(--renki-fg) ${className}`}>
        <Tokens tokens={tokenizeJson(json)} />
      </pre>
    </Collapsible>
  );
});
