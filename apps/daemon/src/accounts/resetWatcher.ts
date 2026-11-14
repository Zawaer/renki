import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resetAdvice, type ResetAdvice } from "@renki/client-core";
import type { Account } from "@renki/protocol";
import { logger } from "../logger.js";

/**
 * What to push for an account's free limit resets, or null. Only the two
 * moments worth a buzz: one is about to expire, or you're at the weekly limit
 * with plenty of week left (a reset now pays best). The "later" and "wait"
 * advice stays on the card; it isn't news.
 */
export function resetPushFor(account: Pick<Account, "email" | "usage">, now = new Date()): { key: string; title: string; body: string; advice: ResetAdvice } | null {
  const advice = resetAdvice(account.usage, now);
  if (!advice || (advice.kind !== "expiring" && advice.kind !== "use_now")) return null;
  // One push per account per situation per day: tomorrow's expiry nag is new information, a repeat in the same day isn't.
  const day = now.toISOString().slice(0, 10);
  return {
    key: `${account.email.toLowerCase()}:${advice.kind}:${day}`,
    title: advice.kind === "expiring" ? "A free limit reset is about to expire" : "Use a free limit reset now?",
    body: `${account.email}: ${advice.text}`,
    advice,
  };
}

/**
 * Pushes the reset advice, each at most once per account per day, and
 * remembers what it sent in a small file so a redeploy doesn't repeat it.
 */
export class ResetWatcher {
  private sent: Record<string, number>;

  constructor(
    private readonly file: string,
    private readonly accounts: () => Promise<Pick<Account, "email" | "usage">[]>,
    private readonly push: (title: string, body: string) => Promise<void>,
  ) {
    this.sent = {};
    try {
      if (existsSync(file)) this.sent = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    } catch {
      // Unreadable: start clean; the worst case is one repeated push.
    }
  }

  async check(now = new Date()): Promise<number> {
    let count = 0;
    for (const account of await this.accounts()) {
      const p = resetPushFor(account, now);
      if (!p || this.sent[p.key]) continue;
      this.sent[p.key] = now.getTime();
      count++;
      await this.push(p.title, p.body);
    }
    const cutoff = now.getTime() - 7 * 86_400_000;
    for (const k of Object.keys(this.sent)) if ((this.sent[k] ?? 0) < cutoff) delete this.sent[k];
    try {
      writeFileSync(this.file, JSON.stringify(this.sent));
    } catch (err) {
      logger.warn("couldn't save reset notices", { err: String(err) });
    }
    return count;
  }
}
