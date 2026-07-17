import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { buildWebviewHtml } from "./panel";

/**
 * The extension is intentionally thin. All UI is the shared web app running in
 * a webview; the only VS Code-specific code is:
 *   - reading connection config (daemon URL from settings, token from
 *     SecretStorage — never plaintext in settings.json),
 *   - hosting the web bundle in a panel,
 *   - and a postMessage bridge for editor actions (open file).
 */
let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("crc.setToken", () => setToken(context)),
    vscode.commands.registerCommand("crc.open", () => openPanel(context)),
  );
}

export function deactivate(): void {
  panel?.dispose();
}

async function setToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    prompt: "CRC daemon auth token (stored in VS Code SecretStorage)",
    password: true,
    ignoreFocusOut: true,
  });
  if (token) {
    await context.secrets.store("crc.token", token);
    vscode.window.showInformationMessage("CRC auth token saved.");
  }
}

async function openPanel(context: vscode.ExtensionContext): Promise<void> {
  const daemonUrl = vscode.workspace.getConfiguration("crc").get<string>("daemonUrl")?.trim();
  if (!daemonUrl) {
    const pick = await vscode.window.showErrorMessage(
      "Set crc.daemonUrl in Settings first.",
      "Open Settings",
    );
    if (pick) vscode.commands.executeCommand("workbench.action.openSettings", "crc.daemonUrl");
    return;
  }

  const token = await context.secrets.get("crc.token");
  if (!token) {
    const pick = await vscode.window.showErrorMessage("No CRC token set.", "Set Token");
    if (pick) await setToken(context);
    return;
  }

  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel("crc.panel", "Claude Remote Control", vscode.ViewColumn.Beside, {
    enableScripts: true,
    // Keep the WebSocket + state alive when the tab is hidden — no reconnect
    // churn just because you switched editor tabs.
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  });

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    baseUrl: daemonUrl,
    token,
    deviceId: deviceId(context),
    deviceName: "VS Code",
  });

  panel.webview.onDidReceiveMessage((msg) => handleMessage(msg), undefined, context.subscriptions);
  panel.onDidDispose(() => {
    panel = undefined;
  });
}

function handleMessage(msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type?: string; path?: string };
  if (m.type === "openFile" && typeof m.path === "string") {
    vscode.workspace.openTextDocument(m.path).then(
      (doc) => vscode.window.showTextDocument(doc, { preview: false }),
      (err) => vscode.window.showErrorMessage(`Couldn't open ${m.path}: ${String(err)}`),
    );
  }
}

/** Stable per-install device id so the take-control lock recognizes this editor. */
function deviceId(context: vscode.ExtensionContext): string {
  const existing = context.globalState.get<string>("crc.deviceId");
  if (existing) return existing;
  const id = `vscode_${randomUUID()}`;
  void context.globalState.update("crc.deviceId", id);
  return id;
}
