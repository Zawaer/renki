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
  h1: ({ node, ...p }) => <h1 className="text-base font-semibold text-neutral-100" {...p} />,
  h2: ({ node, ...p }) => <h2 className="text-sm font-semibold text-neutral-100" {...p} />,
  h3: ({ node, ...p }) => <h3 className="text-sm font-semibold text-neutral-200" {...p} />,
  h4: ({ node, ...p }) => <h4 className="text-sm font-semibold text-neutral-300" {...p} />,
  p: ({ node, ...p }) => <p className="leading-relaxed" {...p} />,
  ul: ({ node, ...p }) => <ul className="list-disc space-y-1 pl-5 marker:text-neutral-500" {...p} />,
  ol: ({ node, ...p }) => <ol className="list-decimal space-y-1 pl-5 marker:text-neutral-500" {...p} />,
  li: ({ node, ...p }) => <li className="leading-relaxed [&>ul]:mt-1 [&>ol]:mt-1" {...p} />,
  a: ({ node, ...p }) => (
    <a className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300" target="_blank" rel="noreferrer" {...p} />
  ),
  strong: ({ node, ...p }) => <strong className="font-semibold text-neutral-100" {...p} />,
  em: ({ node, ...p }) => <em className="italic" {...p} />,
  del: ({ node, ...p }) => <del className="text-neutral-500 line-through" {...p} />,
  blockquote: ({ node, ...p }) => <blockquote className="border-l-2 border-neutral-700 pl-3 text-neutral-400" {...p} />,
  hr: ({ node, ...p }) => <hr className="border-neutral-800" {...p} />,
  code: ({ node, ...p }) => (
    <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[0.85em] text-neutral-200" {...p} />
  ),
  // Fenced blocks: the descendant selectors neutralize the inline-code pill so
  // the code sits flush inside the block.
  pre: ({ node, ...p }) => (
    <pre
      className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-neutral-300 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
      {...p}
    />
  ),
  table: ({ node, ...p }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...p} />
    </div>
  ),
  th: ({ node, ...p }) => <th className="border border-neutral-800 px-2 py-1 text-left font-semibold text-neutral-200" {...p} />,
  td: ({ node, ...p }) => <td className="border border-neutral-800 px-2 py-1 align-top" {...p} />,
};

export const Markdown = memo(function Markdown({ content, muted = false }: { content: string; muted?: boolean }) {
  return (
    <div className={`space-y-2 break-words text-sm ${muted ? "text-neutral-500" : "text-neutral-200"}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
