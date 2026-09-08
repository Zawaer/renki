import { logger } from "../logger.js";

/**
 * Guided browser login: open a REAL browser on whatever host the daemon runs
 * on, let the user sign in, and read the resulting `sessionKey` cookie —
 * exactly what native usage trackers do, but driven by the daemon so it
 * works from the web/CLI/phone "sign in via browser" button. Only useful if
 * that host has a display; headless hosts should use the paste-a-key route
 * instead. Playwright is an OPTIONAL dependency, lazily imported here so the
 * daemon boots fine without it; we surface a clean "unavailable" instead of
 * crashing. We prefer your already-installed Chrome (`channel`) to avoid a
 * 150 MB Chromium download.
 *
 * The session cookie is httpOnly, so this browser-cookie route is the only way
 * to extract it automatically (a plain web page can't read it cross-origin).
 */
export class PlaywrightUnavailableError extends Error {
  constructor() {
    super(
      "Playwright isn't installed on the daemon host. Run `pnpm --filter @renki/daemon add playwright` " +
        "(it will reuse your installed Chrome), then retry.",
    );
    this.name = "PlaywrightUnavailableError";
  }
}

export type LoginOptions = {
  baseUrl: string;
  /** Browser channel to reuse (e.g. "chrome", "msedge"). Empty → bundled Chromium. */
  channel?: string;
  timeoutMs: number;
};

/**
 * Launches a headful browser, waits (up to `timeoutMs`) for the user to complete
 * login, and returns the `sk-ant-sid01-…` session cookie. Throws
 * PlaywrightUnavailableError if Playwright can't be loaded.
 */
export async function loginAndExtractSessionKey(opts: LoginOptions): Promise<string> {
  const chromium = await loadChromium();

  const browser = await chromium.launch({
    headless: false,
    ...(opts.channel ? { channel: opts.channel } : {}),
    // Strip the biggest automation tells so Cloudflare's passive bot check is
    // less likely to strand us on the "security verification" interstitial:
    // drop Chrome's `--enable-automation` switch and the `navigator.webdriver`
    // flag. This is best-effort — a managed Turnstile challenge can still block,
    // in which case the paste route (POST /accounts/usage-key) is the fallback.
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${opts.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    logger.info("usage login browser opened; waiting for sign-in");

    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      const sk = cookies.find((c: { name: string; value: string }) => c.name === "sessionKey");
      if (sk?.value?.startsWith("sk-ant-sid")) return sk.value;
      // The user closing the window shouldn't hang us until the timeout.
      if (browser.isConnected() === false) break;
      await page.waitForTimeout(1000).catch(() => {});
    }
    throw new Error("timed out waiting for claude.ai sign-in");
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Dynamic import isolated so a missing dependency becomes a typed error. The
 * specifier is a non-literal `string` on purpose: it stops tsc from trying to
 * resolve the OPTIONAL `playwright` types at build time (it isn't a hard dep).
 */
async function loadChromium(): Promise<any> {
  const specifier = "playwright" as string;
  try {
    const mod: any = await import(specifier);
    return mod.chromium;
  } catch {
    throw new PlaywrightUnavailableError();
  }
}
