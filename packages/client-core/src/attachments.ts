import type { AttachmentMediaType } from "@renki/protocol";

export { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_PROMPT, type Attachment, type AttachmentMediaType } from "@renki/protocol";

/**
 * Extensions treated as plain text for attachment purposes even when the
 * platform reports no MIME type (common for these in both a browser file
 * picker and Expo's document picker) — broader than literal ".txt" so code/
 * config files work the same way Claude Code's own chat-box attach does.
 */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "tsv",
  "log",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "hpp",
  "cpp",
  "cc",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
]);

/**
 * Maps a picked file's reported name/MIME type to the wire `AttachmentMediaType`
 * Renki knows how to hand the model as a real content block, or null if it isn't
 * one of the supported kinds (image/PDF/text) — the caller should reject those
 * with a message to reference the file by absolute path instead.
 */
export function classifyAttachment(file: { name: string; type: string }): AttachmentMediaType | null {
  const type = file.type.toLowerCase();
  if (type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp") return type;
  if (type === "application/pdf") return "application/pdf";
  if (type.startsWith("text/")) return "text/plain";

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext) ? "text/plain" : null;
}

type AttachmentLike = { mediaType: string; data: string; ref?: string };

/**
 * Where to load an attachment's bytes from: inline base64 when the event
 * carried it, otherwise the daemon path a lazy replay referenced (see
 * AttachmentView). Headers for clients that can send them (React Native's
 * Image); `urlWithToken` for ones that can't (a browser <img>), which the
 * daemon accepts as `?token=` like any other request.
 */
export function attachmentSource(
  a: AttachmentLike,
  auth: { baseUrl: string; token: string },
): { uri: string; headers?: Record<string, string>; urlWithToken: string } {
  if (a.data || !a.ref) {
    const uri = `data:${a.mediaType};base64,${a.data}`;
    return { uri, urlWithToken: uri };
  }
  const uri = `${auth.baseUrl}${a.ref}`;
  return {
    uri,
    headers: { authorization: `Bearer ${auth.token}` },
    urlWithToken: `${uri}${uri.includes("?") ? "&" : "?"}token=${encodeURIComponent(auth.token)}`,
  };
}
