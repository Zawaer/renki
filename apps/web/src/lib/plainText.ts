import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * A reply as plain text, for the copy button: what it reads as, not its
 * markdown source. Pasted into WhatsApp or a mail, "> " quote markers,
 * **bold** stars and table pipes are noise. Lists keep their bullets and
 * numbers, a link keeps its URL after the text, a table becomes one line per
 * row. The phone has the same thing (apps/mobile Markdown.tsx), on its own parser.
 */
export function markdownToPlainText(md: string): string {
  const tree: Root = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return blocks(tree.children, 0).replace(/\n{3,}/g, "\n\n").trim();
}

function blocks(nodes: Nodes[], depth: number, sep = "\n\n"): string {
  return nodes.map((n) => block(n, depth)).filter((s) => s !== "").join(sep);
}

function block(node: Nodes, depth: number): string {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return inline(node.children);
    case "blockquote":
      return blocks(node.children, depth);
    case "list": {
      const start = node.start ?? 1;
      const items = node.children.map((item, i) => {
        const marker = node.ordered ? `${start + i}. ` : "• ";
        // A tight list's items are one line each; a nested list goes on its own lines, indented.
        const body = item.children
          .map((c) => (c.type === "list" ? "\n" + block(c, depth + 1) : block(c, depth + 1)))
          .join(item.spread ? "\n\n" : "\n")
          .replace(/\n\n?\n/g, "\n");
        return "  ".repeat(depth) + marker + body;
      });
      return items.join(node.spread ? "\n\n" : "\n");
    }
    case "code":
    case "html":
      return node.value;
    case "table":
      return node.children.map((row) => row.children.map((cell) => inline(cell.children)).join(" · ")).join("\n");
    case "thematicBreak":
      return "———";
    default:
      return "children" in node ? blocks(node.children as Nodes[], depth) : "";
  }
}

function inline(nodes: Nodes[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
        case "inlineCode":
        case "html":
          return n.value;
        case "break":
          return "\n";
        case "image":
          return n.alt ?? "";
        case "link": {
          const text = inline(n.children);
          // A bare URL already is its text; anything else keeps the URL after it.
          return n.url === text || n.url.startsWith("#") ? text : `${text} (${n.url})`;
        }
        default:
          return "children" in n ? inline(n.children as Nodes[]) : "";
      }
    })
    .join("");
}
