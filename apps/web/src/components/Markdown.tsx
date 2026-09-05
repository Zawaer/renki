import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
 * (see `.crc-word` in index.css). Whitespace stays as plain text between the
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
          else next.push({ type: "element", tagName: "span", properties: { className: ["crc-word"] }, children: [{ type: "text", value: part }] });
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

const components: Components = {
  h1: ({ node, ...p }) => <h1 className="text-base font-semibold text-(--crc-fg)" {...p} />,
  h2: ({ node, ...p }) => <h2 className="text-sm font-semibold text-(--crc-fg)" {...p} />,
  h3: ({ node, ...p }) => <h3 className="text-sm font-semibold text-(--crc-fg)" {...p} />,
  h4: ({ node, ...p }) => <h4 className="text-sm font-semibold text-(--crc-fg)" {...p} />,
  p: ({ node, ...p }) => <p className="leading-relaxed" {...p} />,
  ul: ({ node, ...p }) => <ul className="list-disc space-y-1 pl-5 marker:text-(--crc-fg-muted)" {...p} />,
  ol: ({ node, ...p }) => <ol className="list-decimal space-y-1 pl-5 marker:text-(--crc-fg-muted)" {...p} />,
  li: ({ node, ...p }) => <li className="leading-relaxed [&>ul]:mt-1 [&>ol]:mt-1" {...p} />,
  a: ({ node, ...p }) => (
    <a className="text-(--crc-link) underline underline-offset-2 hover:opacity-80" target="_blank" rel="noreferrer" {...p} />
  ),
  strong: ({ node, ...p }) => <strong className="font-semibold text-(--crc-fg)" {...p} />,
  em: ({ node, ...p }) => <em className="italic" {...p} />,
  del: ({ node, ...p }) => <del className="text-(--crc-fg-muted) line-through" {...p} />,
  blockquote: ({ node, ...p }) => <blockquote className="border-l-2 border-(--crc-border) pl-3 text-(--crc-fg-muted)" {...p} />,
  hr: ({ node, ...p }) => <hr className="border-(--crc-border)" {...p} />,
  code: ({ node, ...p }) => (
    <code className="rounded-md bg-(--crc-bg-inset) px-1.5 py-0.5 font-(family-name:--crc-font-mono) text-[0.85em] text-(--crc-fg)" {...p} />
  ),
  // Fenced blocks: the descendant selectors neutralize the inline-code pill so
  // the code sits flush inside the block.
  pre: ({ node, ...p }) => (
    <pre
      className="overflow-x-auto rounded-xl border border-(--crc-border) bg-(--crc-bg-inset) p-3.5 font-(family-name:--crc-font-mono) text-xs leading-relaxed text-(--crc-fg) [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
      {...p}
    />
  ),
  table: ({ node, ...p }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...p} />
    </div>
  ),
  th: ({ node, ...p }) => <th className="border border-(--crc-border) px-2 py-1 text-left font-semibold text-(--crc-fg)" {...p} />,
  td: ({ node, ...p }) => <td className="border border-(--crc-border) px-2 py-1 align-top" {...p} />,
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
      className={`space-y-2.5 wrap-break-word text-[14px] leading-relaxed ${muted ? "text-(--crc-fg-muted)" : "text-(--crc-fg)"} ${
        streaming ? "crc-stream-md" : ""
      }`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={streaming ? [rehypeWrapWords] : []} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
