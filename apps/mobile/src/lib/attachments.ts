import { classifyAttachment, MAX_ATTACHMENT_BYTES, type Attachment } from "@renki/client-core";
import * as DocumentPicker from "expo-document-picker";
import { randomUUID } from "expo-crypto";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

/** A picked attachment before it's sent — same wire shape as `Attachment` plus client-only bookkeeping. */
export type PendingAttachment = Attachment & { id: string };

async function toAttachment(uri: string, name: string, type: string, size: number | undefined): Promise<PendingAttachment | { error: string }> {
  const mediaType = classifyAttachment({ name, type });
  if (!mediaType) return { error: `${name}: unsupported file type — reference it by its path in the prompt instead.` };
  if (typeof size === "number" && size > MAX_ATTACHMENT_BYTES) {
    return { error: `${name}: too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB).` };
  }
  try {
    const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return { id: randomUUID(), name, mediaType, data };
  } catch {
    return { error: `${name}: couldn't read file.` };
  }
}

/**
 * Opens the system photo picker (multi-select) and reads every picked image
 * into wire-format base64. Returns an empty array if the user cancels.
 */
export async function pickImageAttachments(remaining: number): Promise<Array<PendingAttachment | { error: string }>> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [{ error: "Photo library permission denied." }];

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: remaining,
    quality: 1,
  });
  if (result.canceled) return [];

  return Promise.all(
    result.assets.map((a) => toAttachment(a.uri, a.fileName ?? `photo-${Date.now()}.jpg`, a.mimeType ?? "image/jpeg", a.fileSize)),
  );
}

/**
 * Opens the system document picker (PDF/text; images are better served by
 * pickImageAttachments' native photo picker) and reads every picked file into
 * wire-format base64. Returns an empty array if the user cancels.
 */
export async function pickDocumentAttachments(remaining: number): Promise<Array<PendingAttachment | { error: string }>> {
  // Not filtered to a MIME allowlist: many code/config files report as
  // application/octet-stream on Android's system picker, which would hide
  // them from a stricter filter. classifyAttachment (via toAttachment, using
  // its extension fallback) is the real gate — same division of labor as
  // web's advisory <input accept> + readFileAsAttachment doing the real check.
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    multiple: true,
  });
  if (result.canceled) return [];

  return Promise.all(
    result.assets.slice(0, remaining).map((a) => toAttachment(a.uri, a.name, a.mimeType ?? "", a.size ?? undefined)),
  );
}
