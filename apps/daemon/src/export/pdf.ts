import { marked } from "marked";
import { ExportError } from "./index.js";

/**
 * Markdown → PDF, through headless Chromium (Playwright). The Docker image
 * installs Chromium's headless shell for this; a daemon run directly on a Mac
 * falls back to the installed Chrome.
 *
 * The page is locked down, because a chat holds content nobody vetted — web
 * pages Claude fetched, command output: JavaScript is off and every request is
 * refused, so nothing in the transcript can run or reach the network while
 * it's laid out. Images arrive inline as data URIs, which need no request.
 */
export async function renderPdf(markdown: string, title: string): Promise<Buffer> {
  const html = pageHtml(await marked.parse(markdown, { gfm: true }), title);
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" })).catch((err: unknown) => {
    throw new ExportError(
      "pdf_unavailable",
      `PDF export needs Chromium on the daemon host, and none could start (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). Markdown export still works.`,
    );
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route: { abort: () => Promise<void> }) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Playwright is loaded lazily, so a daemon without it still starts and exports Markdown. */
async function loadChromium(): Promise<any> {
  const specifier = "playwright" as string;
  try {
    return (await import(specifier)).chromium;
  } catch {
    throw new ExportError("pdf_unavailable", "PDF export needs Playwright on the daemon host. Markdown export still works.");
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function pageHtml(body: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page { size: A4; }
  body { font: 10.5pt/1.55 -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #241a12; }
  h1 { font-size: 19pt; margin: 0 0 4pt; }
  h3 { font-size: 11pt; margin: 14pt 0 4pt; color: #7a4a14; }
  hr { border: 0; border-top: 1px solid #e7ded2; margin: 14pt 0; }
  p, ul, ol { margin: 5pt 0; }
  a { color: #8a5419; }
  code { font: 9pt/1.45 "SF Mono", Menlo, Consolas, monospace; background: #f6f1ea; padding: 0 3px; border-radius: 3px; }
  pre { background: #f6f1ea; border: 1px solid #ece3d6; border-radius: 6px; padding: 7pt 9pt; white-space: pre-wrap; word-break: break-word; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 6pt 0; padding: 2pt 10pt; border-left: 3px solid #e2d4c1; color: #6b5d50; }
  table { border-collapse: collapse; margin: 6pt 0; }
  th, td { border: 1px solid #e2d8cb; padding: 3pt 6pt; text-align: left; vertical-align: top; }
  img { max-width: 100%; max-height: 120mm; border-radius: 4px; }
  pre, blockquote, table, img { break-inside: avoid; }
  </style></head><body>${body}</body></html>`;
}
