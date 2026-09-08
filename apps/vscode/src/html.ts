import { randomBytes } from "node:crypto";

/**
 * Pure HTML transform for the webview — no `vscode` dependency, so it's unit
 * testable on its own. panel.ts resolves the VS Code-specific bits
 * (asWebviewUri base, cspSource) and hands them here as plain strings.
 */
export type RenderInput = {
  rawHtml: string; // the built web index.html
  assetsBase: string; // webview URI base that ./assets resolves against
  cspSource: string; // webview.cspSource
  baseUrl: string; // daemon URL, for connect-src
  config: unknown; // window.__RENKI_CONFIG__ payload
};

export function renderWebviewHtml(input: RenderInput): string {
  const nonce = randomBytes(16).toString("hex");

  const csp = [
    "default-src 'none'",
    `img-src ${input.cspSource} https: data:`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${input.cspSource} 'unsafe-inline'`,
    `font-src ${input.cspSource}`,
    `connect-src ${connectSources(input.baseUrl)}`,
  ].join("; ");

  const inject =
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<script nonce="${nonce}">window.__RENKI_CONFIG__=${JSON.stringify(input.config)};</script>`;

  return input.rawHtml
    .replace(/(src|href)="\//g, `$1="${input.assetsBase}/`)
    .replace(/<script /g, `<script nonce="${nonce}" `)
    .replace("</head>", `${inject}</head>`);
}

/** The daemon's HTTP origin plus its ws/wss counterpart, for connect-src. */
export function connectSources(baseUrl: string): string {
  try {
    const origin = new URL(baseUrl).origin;
    return `${origin} ${origin.replace(/^http/, "ws")}`;
  } catch {
    return "'none'";
  }
}
