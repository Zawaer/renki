import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { renderWebviewHtml } from "./html";

export type InjectedConfig = {
  baseUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
};

/**
 * Load the built web bundle (apps/web -> media/web) as webview-safe HTML:
 * rewrite relative asset URLs to webview URIs, enforce a strict CSP scoped to
 * the daemon's origins, and inject window.__CRC_CONFIG__ so the SPA skips its
 * Setup screen. The string transforms live in ./html (pure + tested); this
 * function just resolves the VS Code-specific inputs.
 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  config: InjectedConfig,
): string {
  const webRoot = vscode.Uri.joinPath(extensionUri, "media", "web");
  return renderWebviewHtml({
    rawHtml: readFileSync(vscode.Uri.joinPath(webRoot, "index.html").fsPath, "utf8"),
    assetsBase: webview.asWebviewUri(webRoot).toString(),
    cspSource: webview.cspSource,
    baseUrl: config.baseUrl,
    config,
  });
}
