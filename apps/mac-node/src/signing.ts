import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Signing a job's APK with the user's own key, on the Mac (config `signApks`).
 *
 * The build runs in the VM with whatever key it has there (a release build
 * without one falls back to a public debug key); the agent then re-signs the
 * exported APK here, so the key and its passwords never enter the VM, where a
 * session's code could read them. apksigner replaces the existing signature.
 * Passwords reach it through its environment, never its argv (visible in ps).
 */

export type SigningProps = { storeFile: string; storePassword: string; keyAlias: string; keyPassword: string };

/** Java-style `key=value` lines, as Gradle's signing.properties uses. */
export function readSigningProps(path: string): SigningProps {
  const props: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue;
    const i = t.search(/[=:]/);
    if (i > 0) props[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  const { storeFile, storePassword, keyAlias } = props;
  if (!storeFile || !storePassword || !keyAlias) throw new Error(`${path} needs storeFile, storePassword and keyAlias`);
  return { storeFile, storePassword, keyAlias, keyPassword: props.keyPassword || storePassword };
}

function exec(bin: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env: { ...process.env, ...env }, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Sign `apk` in place; returns the signing certificate's SHA-256, or throws with why not. */
export async function signApk(apk: string, propsPath: string, bin: string | null): Promise<string> {
  if (!bin) throw new Error("apksigner wasn't found (install the Android SDK build-tools, or set apksigner in mac-node.json)");
  const p = readSigningProps(propsPath);
  const signed = await exec(
    bin,
    ["sign", "--ks", p.storeFile, "--ks-key-alias", p.keyAlias, "--ks-pass", "env:RENKI_KS_PASS", "--key-pass", "env:RENKI_KEY_PASS", apk],
    { RENKI_KS_PASS: p.storePassword, RENKI_KEY_PASS: p.keyPassword },
  );
  if (signed.code !== 0) throw new Error(signed.out.split("\n").slice(-3).join(" ") || `apksigner exited ${signed.code}`);
  const verified = await exec(bin, ["verify", "--print-certs", apk]);
  const digest = /certificate SHA-256 digest: ([0-9a-f]+)/i.exec(verified.out)?.[1];
  if (verified.code !== 0 || !digest) throw new Error(`the signed APK didn't verify: ${verified.out.split("\n").slice(-2).join(" ")}`);
  return digest;
}

/**
 * Sign an ESP-IDF app image in place with the user's secure boot v2 (RSA)
 * key, on the Mac (config `signEspImages`), then check the signature. The
 * VM builds it unsigned, so the key never enters the VM. espsecure runs from
 * the ESP-IDF Python with a fixed argv; the key's path is the only input
 * that isn't the image.
 */
export async function signEspImage(bin: string, keyPath: string, python: string | null): Promise<void> {
  if (!python) throw new Error("no ESP-IDF Python was found (install ESP-IDF, or set espPython in mac-node.json)");
  const espsecure = join(dirname(python), "espsecure.py");
  const signed = `${bin}.signed`;
  const s = await exec(python, [espsecure, "sign_data", "--version", "2", "--keyfile", keyPath, "--output", signed, bin]);
  if (s.code !== 0) throw new Error(s.out.split("\n").slice(-3).join(" ") || `espsecure exited ${s.code}`);
  const v = await exec(python, [espsecure, "verify_signature", "--version", "2", "--keyfile", keyPath, signed]);
  if (v.code !== 0) throw new Error(`the signed image didn't verify: ${v.out.split("\n").slice(-2).join(" ")}`);
  await rename(signed, bin);
}
