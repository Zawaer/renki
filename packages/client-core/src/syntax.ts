/**
 * Tiny syntax tokenizers for the two things Renki actually shows as code: shell
 * commands a tool wants to run, and JSON tool payloads. Deliberately not a
 * general highlighter — no dependency, no language detection, no bundle cost.
 * Pure functions returning tokens so every client can colour them its own way
 * and the rules stay unit-testable.
 */

export type SyntaxKind =
  | "plain"
  | "command"
  | "argument"
  | "flag"
  | "string"
  | "operator"
  | "variable"
  | "comment"
  | "key"
  | "number"
  | "literal"
  | "punct";

export type SyntaxToken = { text: string; kind: SyntaxKind };

/** Characters that end a bare word in a shell command. */
const SHELL_BREAK = new Set([" ", "\t", "\n", "|", "&", ";", "<", ">", "(", ")", "'", '"', "#"]);
/** Operators after which the next word is a command name again (`git log | grep foo`). */
const RESTARTS_COMMAND = new Set(["|", "||", "&&", ";", "\n", "(", "$("]);

function push(out: SyntaxToken[], text: string, kind: SyntaxKind): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ text, kind });
}

/** `$VAR` and `${VAR}` — interpolated inside double quotes, literal inside single quotes. */
const VARIABLE_RE = /\$\{[^}]*\}|\$[A-Za-z0-9_]+/g;

/** Emit a double-quoted region, pulling out the variables the shell would expand inside it. */
function pushDoubleQuoted(out: SyntaxToken[], text: string): void {
  let last = 0;
  VARIABLE_RE.lastIndex = 0;
  for (let m = VARIABLE_RE.exec(text); m; m = VARIABLE_RE.exec(text)) {
    push(out, text.slice(last, m.index), "string");
    push(out, m[0], "variable");
    last = m.index + m[0].length;
  }
  push(out, text.slice(last), "string");
}

/**
 * Tokenize a shell command: the program name, its flags, quoted strings,
 * variables, operators and comments. Unterminated quotes are tolerated (the
 * rest of the line is the string) since these are live, partly-typed commands.
 */
export function tokenizeShell(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let i = 0;
  let expectCommand = true;

  while (i < src.length) {
    const c = src[i]!;

    if (c === " " || c === "\t") {
      push(out, c, "plain");
      i++;
      continue;
    }

    if (c === "\n") {
      push(out, c, "plain");
      expectCommand = true;
      i++;
      continue;
    }

    if (c === "#") {
      push(out, src.slice(i), "comment");
      break;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\" && quote === '"') j += 2;
        else if (src[j] === quote) {
          j++;
          break;
        } else j++;
      }
      if (quote === '"') pushDoubleQuoted(out, src.slice(i, j));
      else push(out, src.slice(i, j), "string");
      i = j;
      expectCommand = false;
      continue;
    }

    if (c === "$" && src[i + 1] === "(") {
      push(out, "$(", "operator");
      i += 2;
      expectCommand = true;
      continue;
    }

    if (c === "$") {
      let j = i + 1;
      if (src[j] === "{") {
        while (j < src.length && src[j] !== "}") j++;
        j++;
      } else {
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      }
      push(out, src.slice(i, j), "variable");
      i = j;
      expectCommand = false;
      continue;
    }

    if (c === "|" || c === "&" || c === ";" || c === "<" || c === ">" || c === "(" || c === ")") {
      let op = c;
      if ((c === "|" || c === "&" || c === ">") && src[i + 1] === c) op = c + c;
      push(out, op, "operator");
      i += op.length;
      if (RESTARTS_COMMAND.has(op)) expectCommand = true;
      continue;
    }

    let j = i;
    while (j < src.length && !SHELL_BREAK.has(src[j]!)) j++;
    const word = src.slice(i, j);
    if (word.startsWith("-")) push(out, word, "flag");
    else if (expectCommand) {
      push(out, word, "command");
      expectCommand = false;
    } else push(out, word, "argument");
    i = j;
  }

  return out;
}

/** Tokenize JSON for display: object keys, strings, numbers, literals, punctuation. */
export function tokenizeJson(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === '"') {
          j++;
          break;
        } else j++;
      }
      const text = src.slice(i, j);
      // A string followed by a colon is a key, whatever whitespace is between.
      let k = j;
      while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
      push(out, text, src[k] === ":" ? "key" : "string");
      i = j;
      continue;
    }

    if (/[-\d]/.test(c) && /[\d]/.test(src[i + 1] ?? c)) {
      let j = i;
      while (j < src.length && /[-+.eE\d]/.test(src[j]!)) j++;
      push(out, src.slice(i, j), "number");
      i = j;
      continue;
    }

    const literal = ["true", "false", "null"].find((w) => src.startsWith(w, i));
    if (literal) {
      push(out, literal, "literal");
      i += literal.length;
      continue;
    }

    if ("{}[],:".includes(c)) {
      push(out, c, "punct");
      i++;
      continue;
    }

    push(out, c, "plain");
    i++;
  }

  return out;
}
