/**
 * Host bridge. The web app is the standalone reference client, but it can also
 * be embedded in a host (the VS Code webview today, conceivably others later).
 * This module is the ONLY seam between "plain website" and "embedded":
 *
 *  - A host injects connection config as `window.__CRC_CONFIG__` before our
 *    bundle runs, so we skip the Setup screen and use what the host provides.
 *  - In a VS Code webview, `acquireVsCodeApi()` exists; we use it to post
 *    host-specific actions (like "open this file in the editor") back out.
 *
 * In a normal browser neither exists, so everything here degrades to no-ops and
 * the app behaves exactly as the standalone client.
 */
import type { AppConfig } from "./config.js";

declare global {
  interface Window {
    __CRC_CONFIG__?: Partial<AppConfig>;
  }
  // Injected by VS Code into webviews. Returns a postMessage bridge (once only).
  function acquireVsCodeApi(): { postMessage(msg: unknown): void } | undefined;
}

let vscodeApi: { postMessage(msg: unknown): void } | null | undefined;

function host(): { postMessage(msg: unknown): void } | null {
  if (vscodeApi === undefined) {
    vscodeApi = typeof acquireVsCodeApi === "function" ? (acquireVsCodeApi() ?? null) : null;
  }
  return vscodeApi ?? null;
}

/** Config the host injected, if it's complete. Null in a plain browser. */
export function injectedConfig(): AppConfig | null {
  const c = window.__CRC_CONFIG__;
  if (c && c.baseUrl && c.token && c.deviceId) {
    return { deviceName: "VS Code", ...c } as AppConfig;
  }
  return null;
}

/** True when running inside a host that can handle actions like openFile. */
export function isHosted(): boolean {
  return host() !== null;
}

/** Ask the host to open a file in its editor (no-op in a plain browser). */
export function hostOpenFile(path: string): void {
  host()?.postMessage({ type: "openFile", path });
}
