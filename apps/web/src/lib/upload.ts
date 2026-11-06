import { MAX_UPLOAD_BYTES, type UploadRef } from "@renki/protocol";

/**
 * Sends one file to the daemon's POST /uploads, for files that can't ride
 * inline in a message (too big, or not an image/PDF/text/zip). The message
 * then names it by reference: see UploadRef in @renki/protocol. XHR rather
 * than fetch, for upload progress.
 */
export function uploadFile(
  file: File,
  auth: { baseUrl: string; token: string },
  onProgress: (fraction: number) => void,
): { done: Promise<UploadRef>; cancel: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<UploadRef>((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) return reject(new Error(`over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`));
    xhr.open("POST", `${auth.baseUrl}/uploads?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("authorization", `Bearer ${auth.token}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { id?: string; name?: string; size?: number; message?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: fall through to the status
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.id && body.name && typeof body.size === "number") {
        resolve({ id: body.id, name: body.name, size: body.size });
      } else reject(new Error(body.message ?? `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("couldn't reach Renki"));
    xhr.onabort = () => reject(new Error("cancelled"));
    xhr.send(file);
  });
  return { done, cancel: () => xhr.abort() };
}

/** "12.3 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
