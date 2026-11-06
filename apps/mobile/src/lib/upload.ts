import type { UploadRef } from "@renki/protocol";
import * as FileSystem from "expo-file-system";

/**
 * Streams a file from the phone's storage to the daemon's POST /uploads, for
 * files sent by reference (see UploadRef in @renki/protocol), with progress.
 * expo-file-system's upload task reads the file natively, so nothing the size
 * of the file is ever held in JavaScript.
 */
export function uploadFile(
  uri: string,
  name: string,
  auth: { baseUrl: string; token: string },
  onProgress: (fraction: number) => void,
): { done: Promise<UploadRef>; cancel: () => void } {
  const task = FileSystem.createUploadTask(
    `${auth.baseUrl}/uploads?name=${encodeURIComponent(name)}`,
    uri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/octet-stream" },
    },
    ({ totalBytesSent, totalBytesExpectedToSend }) => {
      if (totalBytesExpectedToSend > 0) onProgress(totalBytesSent / totalBytesExpectedToSend);
    },
  );
  const done = task.uploadAsync().then((res) => {
    if (!res) throw new Error("cancelled");
    let body: { id?: string; name?: string; size?: number; message?: string } = {};
    try {
      body = JSON.parse(res.body);
    } catch {
      // not JSON: fall through to the status
    }
    if (res.status >= 200 && res.status < 300 && body.id && body.name && typeof body.size === "number") {
      return { id: body.id, name: body.name, size: body.size };
    }
    throw new Error(body.message ?? `upload failed (${res.status})`);
  });
  return { done, cancel: () => void task.cancelAsync().catch(() => {}) };
}

/** "12.3 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
