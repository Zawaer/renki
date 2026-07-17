// Bundle the extension host code to a single CommonJS file for VS Code.
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  // `vscode` is provided by the editor at runtime — never bundle it.
  external: ["vscode"],
  outfile: "dist/extension.js",
  sourcemap: true,
});
console.log("bundled extension -> dist/extension.js");
