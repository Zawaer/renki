import { classifyAttachment, MAX_ATTACHMENT_BYTES, type Attachment } from "@renki/client-core";
import { MAX_UPLOAD_BYTES } from "@renki/protocol";
import * as DocumentPicker from "expo-document-picker";
import { randomUUID } from "expo-crypto";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

/** A picked attachment before it's sent — same wire shape as `Attachment` plus client-only bookkeeping. */
export type PendingAttachment = Attachment & { id: string };

/**
 * A picked file that goes by reference instead (see UploadRef in
 * @renki/protocol): too big to ride inline, or a kind the model doesn't take.
 * The composer streams it from disk to POST /uploads; it's never read into
 * memory here, so a 200 MB file is fine.
 */
export type PickedUpload = { upload: { uri: string; name: string; size: number | undefined } };
export type Picked = PendingAttachment | PickedUpload | { error: string };

async function toAttachment(uri: string, name: string, type: string, size: number | undefined): Promise<Picked> {
  const mediaType = classifyAttachment({ name, type });
  if (!mediaType || (typeof size === "number" && size > MAX_ATTACHMENT_BYTES)) {
    if (typeof size === "number" && size > MAX_UPLOAD_BYTES) {
      return { error: `${name}: too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB).` };
    }
    return { upload: { uri, name, size } };
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
export async function pickImageAttachments(remaining: number): Promise<Picked[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [{ error: "Photo library permission denied." }];

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: remaining,
    // Re-encoded at the web's shrink quality: a full-quality phone photo is
    // several MB and eats the per-message budget for little visible gain.
    // (Scaling down to MAX_IMAGE_EDGE as well needs an image module the
    // installed app doesn't have yet.)
    quality: 0.85,
  });
  if (result.canceled) return [];

  return Promise.all(
    result.assets.map((a) => toAttachment(a.uri, a.fileName ?? `photo-${Date.now()}.jpg`, a.mimeType ?? "image/jpeg", a.fileSize)),
  );
}

/**
 * Opens the system document picker (any file; images are better served by
 * pickImageAttachments' native photo picker). Small PDFs, text and zips are
 * read into wire-format base64; anything bigger or of another kind comes back
 * as an upload. Returns an empty array if the user cancels.
 */
export async function pickDocumentAttachments(remaining: number): Promise<Picked[]> {
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
