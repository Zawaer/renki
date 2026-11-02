/**
 * Tiny syntax tokenizers for the two things Renki actually shows as code: shell
 * commands a tool wants to run, and JSON tool payloads (and, on the phone, code
 * blocks and files in those two languages). Deliberately not a general
 * highlighter — no dependency, no content sniffing, no bundle cost.
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
      // To the end of the line: a script's next line is code again.
      const end = src.indexOf("\n", i);
      push(out, src.slice(i, end === -1 ? src.length : end), "comment");
      i = end === -1 ? src.length : end;
      continue;
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

export type SyntaxLanguage = "shell" | "json";

/** Fence info words (```bash) for each language; anything else stays plain. */
const LANGUAGE_NAMES: Record<string, SyntaxLanguage> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  json: "json",
  jsonc: "json",
  json5: "json",
};

/** File extensions for each language. `.jsonl` is one JSON value per line, which tokenizes the same. */
const LANGUAGE_EXTENSIONS: Record<string, SyntaxLanguage> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  json: "json",
  jsonc: "json",
  jsonl: "json",
};

/** The language a code fence's info string names (its first word: "bash title=x" is bash), or null. */
export function syntaxLanguageForFence(info: string | undefined): SyntaxLanguage | null {
  const word = (info ?? "").trim().split(/\s+/)[0]!.toLowerCase();
  return LANGUAGE_NAMES[word] ?? null;
}

/** The language a file's extension says it's in, or null. Dotfiles like `.bashrc` count as shell. */
export function syntaxLanguageForPath(path: string): SyntaxLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/^\.(bashrc|bash_profile|zshrc|zprofile|profile)$/.test(name)) return "shell";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (LANGUAGE_EXTENSIONS[name.slice(dot + 1)] ?? null) : null;
}

export function tokenize(src: string, language: SyntaxLanguage): SyntaxToken[] {
  return language === "shell" ? tokenizeShell(src) : tokenizeJson(src);
}

/**
 * Split tokens at newlines into one array per line, for line-numbered views
 * that tokenize a file once and render it a line at a time. Always returns
 * as many lines as `src.split("\n")` would.
 */
export function splitTokenLines(tokens: SyntaxToken[]): SyntaxToken[][] {
  const lines: SyntaxToken[][] = [[]];
  for (const t of tokens) {
    const parts = t.text.split("\n");
    parts.forEach((text, i) => {
      if (i > 0) lines.push([]);
      if (text) lines[lines.length - 1]!.push({ text, kind: t.kind });
    });
  }
  return lines;
}
