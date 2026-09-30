import { CONVERSATION_CACHE_VERSION, type ConversationCache, type ConversationState } from "@renki/client-core";
import * as FileSystem from "expo-file-system";

/**
 * Conversations kept on the phone between visits, so a long chat opens from
 * disk at once and only the events since are fetched — a long session's full
 * history is many megabytes over the tailnet.
 *
 * In the OS cache directory: the system may clear it under storage pressure,
 * which only costs one full download. One folder per daemon (sessions from two
 * hosts never mix) and per CONVERSATION_CACHE_VERSION, so a folding change in
 * a new build ignores copies folded the old way. The oldest files beyond
 * MAX_SESSIONS are pruned after each write.
 */

const MAX_SESSIONS = 20;

/** A short, filesystem-safe name for a daemon URL. */
function hostKey(baseUrl: string): string {
  let h = 5381;
  for (let i = 0; i < baseUrl.length; i++) h = ((h << 5) + h + baseUrl.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function fileConversationCache(baseUrl: string): ConversationCache | undefined {
  if (!FileSystem.cacheDirectory) return undefined;
  const root = `${FileSystem.cacheDirectory}conversations/`;
  const dir = `${root}v${CONVERSATION_CACHE_VERSION}/${hostKey(baseUrl)}/`;
  // Copies from an older version are never read again; free the space.
  void FileSystem.readDirectoryAsync(root)
    .then((names) =>
      Promise.all(
        names
          .filter((n) => n !== `v${CONVERSATION_CACHE_VERSION}`)
          .map((n) => FileSystem.deleteAsync(`${root}${n}`, { idempotent: true })),
      ),
    )
    .catch(() => {});
  const fileOf = (sessionId: string) => `${dir}${encodeURIComponent(sessionId)}.json`;
  let ready: Promise<void> | null = null;
  const ensureDir = () =>
    (ready ??= FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {
      ready = null;
    }));

  async function prune(): Promise<void> {
    const names = await FileSystem.readDirectoryAsync(dir);
    if (names.length <= MAX_SESSIONS) return;
    const infos = await Promise.all(
      names.map(async (name) => {
        const info = await FileSystem.getInfoAsync(`${dir}${name}`);
        return { name, at: info.exists ? (info.modificationTime ?? 0) : 0 };
      }),
    );
    infos.sort((a, b) => a.at - b.at);
    for (const { name } of infos.slice(0, infos.length - MAX_SESSIONS)) {
      await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
    }
  }

  return {
    async load(sessionId) {
      const path = fileOf(sessionId);
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) return null;
      try {
        return JSON.parse(await FileSystem.readAsStringAsync(path)) as ConversationState;
      } catch {
        await FileSystem.deleteAsync(path, { idempotent: true });
        return null;
      }
    },
    async save(sessionId, state) {
      await ensureDir();
      await FileSystem.writeAsStringAsync(fileOf(sessionId), JSON.stringify(state));
      await prune().catch(() => {});
    },
    async remove(sessionId) {
      await FileSystem.deleteAsync(fileOf(sessionId), { idempotent: true });
    },
  };
}
