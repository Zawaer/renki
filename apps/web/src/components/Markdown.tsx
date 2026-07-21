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
    <code className="rounded-sm bg-(--crc-bg-elevated) px-1 py-0.5 font-(family-name:--crc-font-mono) text-[0.85em] text-(--crc-fg)" {...p} />
  ),
  // Fenced blocks: the descendant selectors neutralize the inline-code pill so
  // the code sits flush inside the block.
  pre: ({ node, ...p }) => (
    <pre
      className="overflow-x-auto rounded-sm border border-(--crc-border) bg-(--crc-bg-inset) p-3 font-(family-name:--crc-font-mono) text-xs text-(--crc-fg) [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
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

export const Markdown = memo(function Markdown({ content, muted = false }: { content: string; muted?: boolean }) {
  return (
    <div className={`space-y-2 wrap-break-word text-sm ${muted ? "text-(--crc-fg-muted)" : "text-(--crc-fg)"}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
