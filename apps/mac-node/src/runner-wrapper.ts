/**
 * renki-runner.mjs: what the Mac agent runs inside the build container
 * (runner-image/Dockerfile), as its unprivileged user. Baked into the image,
 * root-owned, so a build can't change it.
 *
 *   prepare                         seed the Android SDK in the home volume, accept its licences
 *   probe <host> <port> <homelabHost> <homelabPort>   check the firewall really contains the container (JSON on stdout)
 *   diff <project>                  stdin: manifest JSON; stdout: paths to fetch
 *   apply <project>                 stdin: manifest JSON line, then file frames; mirrors them in
 *   run <project> <cwd> <timeoutSec> <command>   run a job's command (from the user's own Mac config)
 *   export <project> <path>         stream one file of the mirror to stdout
 *
 * Data only ever leaves through stdout, never through shared files: a build
 * can't plant a symlink that makes the agent (the real user) read something.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Entry = { p: string; h: string; x: boolean };

const HOME = homedir();
const WORK = join(HOME, "work");
const MANIFESTS = join(HOME, ".manifests");

function fail(msg: string): never {
  process.stderr.write(`renki-runner: ${msg}\n`);
  process.exit(2);
}

function projectRoot(name: string | undefined): string {
  if (!name || !/^[\w][\w.-]{0,79}$/.test(name)) fail("bad project name");
  return join(WORK, name);
}

function checkRel(rel: string): string[] {
  const segs = rel.split("/");
  if (rel.startsWith("/") || rel.includes("\0") || segs.some((s) => s === "" || s === "." || s === "..")) fail(`bad path ${JSON.stringify(rel)}`);
  return segs;
}

/**
 * root/rel, refusing any symlink on the way. `forWrite` makes missing parents
 * and accepts a symlink as the last part, since the caller renames over it
 * (which replaces the link itself, never what it points to).
 */
function safePath(root: string, rel: string, forWrite = false): string {
  const createDirs = forWrite;
  const segs = checkRel(rel);
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      if (i < segs.length - 1) {
        if (!createDirs) return join(root, rel);
        mkdirSync(cur);
        continue;
      }
      return cur;
    }
    if (st.isSymbolicLink()) {
      if (forWrite && i === segs.length - 1) return cur;
      fail(`${rel} goes through a symlink`);
    }
    if (i < segs.length - 1 && !st.isDirectory()) {
      if (!createDirs) fail(`${rel}: ${segs.slice(0, i + 1).join("/")} is not a folder`);
      unlinkSync(cur); // a file where a folder now belongs
      mkdirSync(cur);
    }
  }
  return cur;
}

function sha1File(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function parseManifest(json: string): Entry[] {
  const m = JSON.parse(json) as unknown;
  if (!Array.isArray(m)) fail("manifest is not a list");
  for (const e of m as Entry[]) {
    if (typeof e?.p !== "string" || typeof e.h !== "string" || !/^[0-9a-f]{40}$/.test(e.h)) fail("bad manifest entry");
    checkRel(e.p);
  }
  return m as Entry[];
}

async function diff(project: string | undefined): Promise<void> {
  const root = projectRoot(project);
  const manifest = parseManifest((await readStdin()).toString());
  const need = manifest.filter((e) => {
    const full = join(root, e.p);
    return sha1File(full) !== e.h || ((lstatSync(full).mode & 0o111) !== 0) !== e.x;
  });
  process.stdout.write(JSON.stringify(need.map((e) => e.p)));
}

async function apply(projectName: string | undefined): Promise<void> {
  const root = projectRoot(projectName);
  mkdirSync(root, { recursive: true });
  mkdirSync(MANIFESTS, { recursive: true });
  const input = await readStdin();
  let nl = input.indexOf(0x0a);
  if (nl < 0) fail("no manifest line");
  const manifest = parseManifest(input.subarray(0, nl).toString());
  const byPath = new Map(manifest.map((e) => [e.p, e]));

  let pos = nl + 1;
  let written = 0;
  while (pos < input.length) {
    nl = input.indexOf(0x0a, pos);
    if (nl < 0) fail("truncated frame header");
    const head = JSON.parse(input.subarray(pos, nl).toString()) as { p: string; n: number };
    pos = nl + 1;
    const entry = byPath.get(head.p);
    if (!entry) fail(`${head.p} isn't in the manifest`);
    if (head.n < 0) fail(`${head.p} disappeared on the homelab while syncing; run the job again`);
    const data = input.subarray(pos, pos + head.n);
    pos += head.n;
    if (data.length !== head.n || createHash("sha1").update(data).digest("hex") !== entry.h) {
      fail(`${head.p} changed on the homelab while syncing; run the job again`);
    }
    const dest = safePath(root, head.p, true);
    const tmp = join(dirname(dest), `.renki-tmp-${process.pid}-${written}`);
    writeFileSync(tmp, data, { mode: entry.x ? 0o755 : 0o644 });
    renameSync(tmp, dest); // replaces a symlink itself, never its target
    chmodSync(dest, entry.x ? 0o755 : 0o644);
    written++;
  }

  // Files the previous sync placed that are gone from the tree now.
  const prevPath = join(MANIFESTS, `${projectName}.json`);
  if (existsSync(prevPath)) {
    for (const e of parseManifest(readFileSync(prevPath, "utf8"))) {
      if (byPath.has(e.p)) continue;
      try {
        const full = safePath(root, e.p);
        if (lstatSync(full).isFile()) unlinkSync(full);
      } catch {
        /* already gone */
      }
    }
  }
  writeFileSync(prevPath, JSON.stringify(manifest));
  process.stdout.write(JSON.stringify({ written }));
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {
    HOME,
    USER: process.env.USER ?? "renki-runner",
    LOGNAME: process.env.USER ?? "renki-runner",
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    TMPDIR: join(HOME, "tmp") + "/",
    CI: "1",
  };
  mkdirSync(env.TMPDIR!, { recursive: true });
  // The image's settings (JAVA_HOME, ANDROID_HOME…), root-owned.
  const file = "/etc/renki-runner-env";
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) env[m[1]!] = m[2]!;
    }
  }
  if (env.ANDROID_HOME) env.PATH = `${env.ANDROID_HOME}/cmdline-tools/latest/bin:${env.ANDROID_HOME}/platform-tools:${env.PATH}`;
  return env;
}

function run(projectName: string | undefined, cwdRel: string | undefined, timeoutArg: string | undefined, command: string | undefined): void {
  const root = projectRoot(projectName);
  if (!command) fail("no command");
  const cwd = cwdRel && cwdRel !== "." ? safePath(root, cwdRel) : root;
  if (!existsSync(cwd)) fail(`${cwdRel} doesn't exist in the mirror`);
  const timeoutSec = Math.min(Math.max(Number(timeoutArg) || 600, 10), 3600);
  // The job gets no stdin: ours is the agent's lifeline (see below).
  const child = spawn("/bin/bash", ["-c", command], { cwd, env: loadEnv(), stdio: ["ignore", "inherit", "inherit"], detached: true });
  const stop = (why: string) => {
    process.stderr.write(`\nrenki-runner: ${why}; stopping the job\n`);
    try {
      process.kill(-child.pid!, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 10_000).unref();
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(() => stop(`timed out after ${timeoutSec}s`), timeoutSec * 1000);
  // The agent holds stdin open while it still wants the job; EOF means stop
  // (Renki stopped waiting for it, or the agent itself is gone).
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => stop("the Mac agent stopped waiting"));
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    process.exit(code ?? (signal ? 124 : 1));
  });
}

function exportFile(projectName: string | undefined, rel: string | undefined): void {
  const root = projectRoot(projectName);
  if (!rel) fail("no path");
  const full = safePath(root, rel);
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail(`${rel} doesn't exist (did the job produce it?)`);
  }
  if (!fstatSync(fd).isFile()) fail(`${rel} isn't a file`);
  createReadStream("", { fd }).pipe(process.stdout);
}

/**
 * Can the container reach a service on the Mac (the agent listens on the
 * Mac's loopback; `otherHost` is how the VM would reach it) or the homelab?
 * Both must be refused. Its own loopback and the internet must work.
 */
async function probe(otherHost: string | undefined, portArg: string | undefined, host: string | undefined, hostPortArg: string | undefined): Promise<void> {
  const tryConnect = (h: string, p: number) =>
    new Promise<"connected" | "refused">((resolve) => {
      const s = connect({ host: h, port: p, timeout: 3000 });
      s.once("connect", () => (s.destroy(), resolve("connected")));
      s.once("timeout", () => (s.destroy(), resolve("refused")));
      s.once("error", () => resolve("refused"));
    });
  // Its own loopback services must keep working (Gradle and Kotlin daemons).
  const own = await new Promise<"connected" | "refused">((resolve) => {
    const srv = createServer((c) => c.destroy()).listen(0, "127.0.0.1", async () => {
      const port = (srv.address() as { port: number }).port;
      const r = await tryConnect("127.0.0.1", port);
      srv.close();
      resolve(r);
    });
  });
  const other = await tryConnect(otherHost ?? "127.0.0.1", Number(portArg));
  const homelab = host ? await tryConnect(host, Number(hostPortArg) || 443) : "refused";
  const internet = await tryConnect("1.1.1.1", 443);
  process.stdout.write(JSON.stringify({ own, other, homelab, internet }));
}

/** First start of a fresh home volume: put the SDK tools in place and accept the licences, so Gradle can fetch what it needs. */
function prepare(): void {
  const env = loadEnv();
  const sdk = env.ANDROID_HOME;
  if (!sdk) fail("no ANDROID_HOME in the image");
  const tools = join(sdk, "cmdline-tools", "latest");
  if (!existsSync(tools)) {
    mkdirSync(join(sdk, "cmdline-tools"), { recursive: true });
    const cp = spawnSync("cp", ["-R", "/opt/android-cmdline-tools/latest", tools], { stdio: "inherit" });
    if (cp.status !== 0) fail("couldn't seed the Android SDK");
  }
  const lic = spawnSync("bash", ["-c", "yes | sdkmanager --licenses >/dev/null 2>&1; true"], { env, stdio: "inherit" });
  if (lic.status !== 0) fail("couldn't accept the SDK licences");
  // Gradle init scripts from the image (e.g. React Native's Hermes compiler on arm64 Linux).
  const initDir = join(env.GRADLE_USER_HOME ?? join(HOME, ".gradle"), "init.d");
  mkdirSync(initDir, { recursive: true });
  const cp = spawnSync("cp", ["-f", "/opt/renki/init.d/renki-linux-arm64.gradle", initDir], { stdio: "inherit" });
  if (cp.status !== 0) fail("couldn't install the Gradle init scripts");
  process.stdout.write("{}");
}


const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "prepare":
    prepare();
    break;
  case "probe":
    await probe(args[0], args[1], args[2], args[3]);
    break;
  case "diff":
    await diff(args[0]);
    break;
  case "apply":
    await apply(args[0]);
    break;
  case "run":
    run(args[0], args[1], args[2], args[3]);
    break;
  case "export":
    exportFile(args[0], args[1]);
    break;
  default:
    fail("unknown command");
}
