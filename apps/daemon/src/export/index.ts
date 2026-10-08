import { applyEvents, initialConversation, restoreBlockGaps } from "@renki/client-core";
import type { AttachmentView, ExportOptions, Session, SessionEvent } from "@renki/protocol";
import { strToU8, zipSync } from "fflate";
import { type ExportMeta, renderMarkdown } from "./markdown.js";
import { renderPdf } from "./pdf.js";

/**
 * Export one chat as Markdown (a .md, or a .zip with its media) or PDF.
 * Built here rather than in each app so the web and the phone hand over the
 * same file, folded by the same reducer the apps render with.
 */
export type ExportFile = { filename: string; contentType: string; body: Buffer };

export class ExportError extends Error {
  constructor(
    readonly code: "pdf_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export async function exportChat(
  session: Session,
  events: SessionEvent[],
  opts: ExportOptions,
  now = Date.now(),
): Promise<ExportFile> {
  const conv = restoreBlockGaps(applyEvents(initialConversation(session.id), events));
  const timeZone = validZone(opts.timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const meta: ExportMeta = {
    title: session.title?.trim() || "Untitled chat",
    repoName: session.repoId ? session.repoName : null,
    branch: session.branch,
    createdAt: session.createdAt,
    exportedAt: now,
  };
  const base = `${slug(meta.title)}-${new Date(now).toISOString().slice(0, 10)}`;

  if (opts.format === "pdf") {
    // Everything inline: images as data URIs, so the PDF is one self-contained file.
    const md = renderMarkdown(conv, meta, opts, timeZone, (a) =>
      a.mediaType.startsWith("image/") && a.data ? `data:${a.mediaType};base64,${a.data}` : null,
    );
    return { filename: `${base}.pdf`, contentType: "application/pdf", body: await renderPdf(md, meta.title) };
  }

  // Markdown: media into a media/ folder beside it, numbered in reading order.
  const files = new Map<string, Uint8Array>();
  const seen = new Map<AttachmentView, string>();
  const md = renderMarkdown(conv, meta, opts, timeZone, (a) => {
    if (!a.data) return null;
    const known = seen.get(a);
    if (known) return known;
    const path = `media/${String(files.size + 1).padStart(3, "0")}-${safeName(a.name)}`;
    files.set(path, Buffer.from(a.data, "base64"));
    seen.set(a, path);
    return path;
  });
  if (files.size === 0) {
    return { filename: `${base}.md`, contentType: "text/markdown; charset=utf-8", body: Buffer.from(md, "utf8") };
  }
  const zip = zipSync({ [`${base}/${base}.md`]: strToU8(md), ...Object.fromEntries([...files].map(([p, data]) => [`${base}/${p}`, data])) });
  return { filename: `${base}.zip`, contentType: "application/zip", body: Buffer.from(zip) };
}

/** "Building hackathon team toolkit" → "building-hackathon-team-toolkit". */
export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "chat"
  );
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "file";
}

function validZone(zone: string | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}
