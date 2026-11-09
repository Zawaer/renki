import { Children, cloneElement, type ComponentProps, isValidElement, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Collapsible } from "./ui.js";
import { isUiFence, parseFileLink, parseUiBlock, type UiBlock } from "@renki/client-core";
import { GenUi, GenUiPending } from "./GenUi.js";
import { useFileLinkTarget } from "../lib/fileLinks.js";

/**
 * Renders assistant text as GitHub-flavored Markdown, themed to match the dark
 * UI. react-markdown does NOT render raw HTML by default, so this is XSS-safe
 * without a sanitizer. Memoized on `content` so streaming re-renders of other
 * blocks don't re-parse this one on every token.
 *
 * We map each element to Tailwind classes rather than pull in the typography
 * plugin — full control over the theme, and the base reset strips default
 * margins so inter-block spacing comes from the wrapper's `space-y-*`.
 */

/**
 * Wrap every word in a span so a streaming reply can fade in word by word
 * (see `.renki-word` in index.css). Whitespace stays as plain text between the
 * spans, so wrapping and selection behave exactly as before, and anything
 * inside `code`/`pre` is left alone — splitting code would fight its own
 * whitespace handling. Only applied while a reply streams: once it settles the
 * spans go away, so a finished transcript stays plain text (lighter DOM, and
 * ordinary text queries still see whole sentences).
 */
function rehypeWrapWords() {
  type Node = { type: string; tagName?: string; value?: string; children?: Node[]; properties?: Record<string, unknown> };
  const walk = (node: Node, inCode: boolean): void => {
    if (!node.children) return;
    const next: Node[] = [];
    for (const child of node.children) {
      if (child.type === "text" && !inCode && child.value) {
        for (const part of child.value.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) next.push({ type: "text", value: part });
          else next.push({ type: "element", tagName: "span", properties: { className: ["renki-word"] }, children: [{ type: "text", value: part }] });
        }
        continue;
      }
      walk(child, inCode || (child.type === "element" && (child.tagName === "code" || child.tagName === "pre")));
      next.push(child);
    }
    node.children = next;
  };
  return (tree: Node) => walk(tree, false);
}

/**
 * The raw text inside a hast node — what a copy button should copy.
 *
 * Taken from the source tree rather than the rendered children because those
 * are React elements by then (a `code` element wrapping spans), and
 * reconstructing a string from them is guesswork about whitespace.
 */
function hastText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | undefined;
  if (!n) return "";
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(hastText).join("");
}

/**
 * Every link in rendered Markdown goes through here — the one place to
 * intercept particular hrefs (say, local file paths) before they fall through
 * to opening in a new tab.
 */
function MarkdownLink(p: ComponentProps<"a">) {
  const fileTarget = useFileLinkTarget();
  // A link to a file in the session's working tree (`[notes.md](notes.md)`,
  // `src/foo.ts#L42`, an absolute path inside the worktree) opens in the Files
  // panel. Without a panel to open it in, it stays inert text — following it
  // would only load a broken page relative to the web app's own URL.
  const file = parseFileLink(p.href, fileTarget?.worktreePath ?? null, fileTarget?.fromDir);
  if (file && fileTarget) {
    const { onOpenFile } = fileTarget;
    return (
      <a
        {...p}
        className="cursor-pointer text-(--renki-link) underline underline-offset-2 hover:opacity-80"
        title={file.line ? `Open ${file.path} at line ${file.line}` : `Open ${file.path}`}
        onClick={(e) => {
          e.preventDefault();
          onOpenFile(file.path, file.line);
        }}
        // Middle-click would open the raw relative href in a new tab — a broken page.
        onAuxClick={(e) => e.preventDefault()}
      />
    );
  }
  const href = p.href ?? "";
  const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//");
  if (file || (href && !isUrl)) {
    return <span title={href}>{p.children}</span>;
  }
  return <a className="text-(--renki-link) underline underline-offset-2 hover:opacity-80" target="_blank" rel="noreferrer" {...p} />;
}

/** Hands each list item its marker ("•", "3.") as a prop, so the item can print it as text. */
function withMarkers(children: ReactNode, marker: (index: number) => string): ReactNode {
  let i = 0;
  return Children.map(children, (child) =>
    isValidElement(child) ? cloneElement(child as ReactElement<{ "data-marker"?: string }>, { "data-marker": marker(i++) }) : child,
  );
}

// Headings a step above body size, with more room above than below, so a
// long reply's sections show at a glance instead of reading as one block.
// (The top margin beats the container's space-y, which sits in :where().)
function CodeBlock({ node, ...p }: ComponentProps<"pre"> & { node?: unknown }) {
  return (
    <Collapsible text={hastText(node)} copyLabel="Copy code">
      <pre
        className="overflow-x-auto rounded-xl border border-(--renki-border) bg-(--renki-bg-inset) p-3.5 font-(family-name:--renki-font-mono) text-xs leading-relaxed text-(--renki-fg) [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
        {...p}
      />
    </Collapsible>
  );
}

/** A ```renki-ui block's component, or null when this code block isn't one (or doesn't parse). */
function uiBlockOf(node: unknown): UiBlock | null {
  if (!isUiNode(node)) return null;
  return parseUiBlock(hastText(node));
}

function isUiNode(node: unknown): boolean {
  const code = (node as { children?: { tagName?: string; properties?: { className?: unknown } }[] } | undefined)?.children?.[0];
  const classes = code?.tagName === "code" ? code.properties?.className : undefined;
  return Array.isArray(classes) && classes.some((c) => typeof c === "string" && isUiFence(c.replace(/^language-/, "")));
}

const components: Components = {
  h1: ({ node, ...p }) => <h1 className="mt-6 text-[18px] leading-snug font-semibold text-(--renki-fg) first:mt-0" {...p} />,
  h2: ({ node, ...p }) => <h2 className="mt-6 text-[16.5px] leading-snug font-semibold text-(--renki-fg) first:mt-0" {...p} />,
  h3: ({ node, ...p }) => <h3 className="mt-5 text-[15.5px] leading-snug font-semibold text-(--renki-fg) first:mt-0" {...p} />,
  h4: ({ node, ...p }) => <h4 className="mt-4 text-sm font-semibold text-(--renki-fg) first:mt-0" {...p} />,
  p: ({ node, ...p }) => <p className="leading-relaxed" {...p} />,
  // Bullets and numbers are real text rather than CSS markers, so selecting a
  // list and copying it keeps them: a ::marker never reaches the clipboard,
  // and a numbered list pasted elsewhere came out as unnumbered lines.
  ul: ({ node, children, ...p }) => (
    <ul className="space-y-1.5" {...p}>
      {withMarkers(children, () => "•")}
    </ul>
  ),
  ol: ({ node, children, start, ...p }) => (
    <ol className="space-y-1.5" start={start} {...p}>
      {withMarkers(children, (i) => `${(start ?? 1) + i}.`)}
    </ol>
  ),
  li: ({ node, children, ...p }) => {
    const marker = (p as { "data-marker"?: string })["data-marker"];
    return (
      <li className="pl-5 leading-relaxed [&>ol]:mt-1 [&>p:first-of-type]:inline [&>ul]:mt-1" {...p}>
        <span className="-ml-5 inline-block w-5 whitespace-pre text-(--renki-fg-muted) tabular-nums">{`${marker} `}</span>
        {children}
      </li>
    );
  },
  a: ({ node, ...p }) => <MarkdownLink {...p} />,
  strong: ({ node, ...p }) => <strong className="font-semibold text-(--renki-fg)" {...p} />,
  em: ({ node, ...p }) => <em className="italic" {...p} />,
  del: ({ node, ...p }) => <del className="text-(--renki-fg-muted) line-through" {...p} />,
  blockquote: ({ node, ...p }) => <blockquote className="border-l-2 border-(--renki-border) pl-3 text-(--renki-fg-muted)" {...p} />,
  hr: ({ node, ...p }) => <hr className="border-(--renki-border)" {...p} />,
  code: ({ node, ...p }) => (
    <code className="rounded-md bg-(--renki-bg-inset) px-1.5 py-0.5 font-(family-name:--renki-font-mono) text-[0.85em] text-(--renki-fg)" {...p} />
  ),
  // Fenced blocks: copyable, and clipped when long enough to bury the rest of
  // the reply. The descendant selectors neutralize the inline-code pill so the
  // code sits flush inside the block.
  pre: ({ node, ...p }) => {
    const ui = uiBlockOf(node);
    if (ui) return <GenUi block={ui} />;
    return <CodeBlock node={node} {...p} />;
  },
  // Tables like the Claude app's: a rounded frame, a semibold header, only
  // horizontal rules between rows (each body cell's top border), body-size
  // text. The frame scrolls sideways rather than crushing columns: cells keep
  // a minimum width, so a wide table overflows instead of wrapping to slivers.
  table: ({ node, ...p }) => (
    <div className="overflow-x-auto rounded-[10px] border border-(--renki-border)">
      <table className="w-full border-collapse text-left" {...p} />
    </div>
  ),
  th: ({ node, ...p }) => <th className="min-w-28 px-3 py-2 text-left align-top font-semibold text-(--renki-fg)" {...p} />,
  td: ({ node, ...p }) => <td className="min-w-28 border-t border-(--renki-border) px-3 py-2 align-top" {...p} />,
};

export const Markdown = memo(function Markdown({
  content,
  muted = false,
  streaming = false,
}: {
  content: string;
  muted?: boolean;
  /** While true, each newly rendered node eases in as the reply arrives. */
  streaming?: boolean;
}) {
  return (
    <div
      className={`space-y-3 wrap-break-word text-[14px] leading-relaxed ${muted ? "text-(--renki-fg-muted)" : "text-(--renki-fg)"} ${
        streaming ? "renki-stream-md" : ""
      }`}
    >
      {streaming ? (
        streamingChunks(content).map((chunk, i) => <StreamingChunk key={i} content={chunk} />)
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      )}
    </div>
  );
});

const wrapWordsPlugins = [rehypeWrapWords];

/**
 * While a reply streams, a UI block that doesn't parse yet is most likely
 * still arriving: show a placeholder rather than half a JSON object.
 */
const streamingComponents: Components = {
  ...components,
  pre: ({ node, ...p }) => {
    if (!isUiNode(node)) return <CodeBlock node={node} {...p} />;
    const ui = parseUiBlock(hastText(node));
    return ui ? <GenUi block={ui} /> : <GenUiPending />;
  },
};

/** One finished paragraph (or list, table, code block) of a streaming reply; parsed once. */
const StreamingChunk = memo(function StreamingChunk({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={wrapWordsPlugins} components={streamingComponents}>
      {content}
    </ReactMarkdown>
  );
});

/**
 * A streaming reply split at its blank lines, so each new token re-parses only
 * the paragraph still being written rather than the whole reply (on a long
 * one, that parse on every update was enough to make the page lag).
 *
 * Never splits inside a fenced code block, or before an indented line, which
 * continues the list item or block above it. A list with blank lines between
 * its items briefly renders as several lists; once the reply settles, the
 * whole text is parsed as one.
 */
function streamingChunks(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null;
    }
    current.push(line);
    const next = lines[i + 1];
    if (fence === null && line.trim() === "" && next !== undefined && next.trim() !== "" && !/^\s/.test(next)) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }
  chunks.push(current.join("\n"));
  return chunks;
}
