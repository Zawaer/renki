import { eq } from "drizzle-orm";
import type { DB } from "../db/index.js";
import { pushTokens } from "../db/schema.js";

export type PushToken = { deviceId: string; expoToken: string; platform: string | null };

/** Persistence for per-device Expo push tokens. */
export class PushTokenStore {
  constructor(private readonly db: DB) {}

  /** Upsert a device's token; an empty token unregisters it. */
  set(deviceId: string, expoToken: string, platform?: string): void {
    if (!expoToken) {
      this.db.delete(pushTokens).where(eq(pushTokens.deviceId, deviceId)).run();
      return;
    }
    this.db
      .insert(pushTokens)
      .values({ deviceId, expoToken, platform: platform ?? null, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: pushTokens.deviceId,
        set: { expoToken, platform: platform ?? null, updatedAt: Date.now() },
      })
      .run();
  }

  get(deviceId: string): PushToken | null {
    const row = this.db.select().from(pushTokens).where(eq(pushTokens.deviceId, deviceId)).get();
    return row ? { deviceId: row.deviceId, expoToken: row.expoToken, platform: row.platform } : null;
  }
}
