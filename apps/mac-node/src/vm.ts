import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunWrapper } from "./runner.js";

/**
 * The build VM: a dedicated Colima profile that build jobs run in, inside one
 * long-lived container (so Gradle's daemons stay warm between jobs).
 *
 * Containment, in order of strength:
 *   - a separate Linux kernel: the Mac's loopback services, files, keychain
 *     and this agent's token aren't in the VM at all;
 *   - no folders shared from the Mac (`--mount none`, checked before use);
 *   - the VM's firewall (applied here, as VM root) rejects anything from the
 *     build network to the Mac (the 192.168.5.x gateway, which would otherwise
 *     forward to the Mac's localhost), the LAN, the tailnet and the VM itself;
 *   - the container runs as an unprivileged user, with no capabilities and
 *     no-new-privileges.
 * Runner.checkFirewall probes all of this from inside before every job.
 *
 * The VM starts when the first job needs it and stops after IDLE_MS, or when
 * lending is switched off, so it costs no memory otherwise.
 */

export type VmConfig = { profile: string; cpus: number; memoryGb: number; diskGb: number; colima: string; docker: string };

const CONTAINER = "renki-runner";
const NETWORK = "renki-build";
const BRIDGE = "br-renki";
const VOLUME = "renki-home";
/** What the VM sees the Mac as; Lima forwards it to the Mac's own localhost. Must stay unreachable. */
export const MAC_FROM_VM = "192.168.5.2";
const IDLE_MS = 30 * 60_000;

/** Run as root in the VM. Idempotent: rebuilds the RENKI chain each time. */
const FIREWALL = `
set -e
iptables -N RENKI 2>/dev/null || iptables -F RENKI
iptables -A RENKI -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in 192.168.5.0/24 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4; do
  iptables -A RENKI -d "$net" -j REJECT
done
iptables -A RENKI -j RETURN
iptables -C DOCKER-USER -i ${BRIDGE} -j RENKI 2>/dev/null || iptables -I DOCKER-USER 1 -i ${BRIDGE} -j RENKI
iptables -C INPUT -i ${BRIDGE} -j REJECT 2>/dev/null || iptables -I INPUT 1 -i ${BRIDGE} -j REJECT
ip6tables -C FORWARD -i ${BRIDGE} -j DROP 2>/dev/null || ip6tables -I FORWARD 1 -i ${BRIDGE} -j DROP
ip6tables -C INPUT -i ${BRIDGE} -j DROP 2>/dev/null || ip6tables -I INPUT 1 -i ${BRIDGE} -j DROP
`;

type Out = { code: number; out: string };

function exec(file: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<Out> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` } });
    let out = "";
    const add = (d: Buffer) => (out = (out + d.toString()).slice(-50_000));
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("error", (e) => resolve({ code: 127, out: String(e) }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.stdin.end(opts.input ?? "");
  });
}

export class BuildVm {
  private ready: Promise<string | null> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private readonly context: string;

  constructor(
    private readonly cfg: VmConfig,
    /** Folder with the Dockerfile and renki-runner.mjs. */
    private readonly imageDir: string,
    private readonly log: (msg: string) => void,
  ) {
    this.context = `colima-${cfg.profile}`;
  }

  /** Make sure the VM, firewall, image and container are up. Null when ready, else why not (for Claude). */
  ensure(): Promise<string | null> {
    this.touch();
    if (!this.ready) {
      this.ready = this.bringUp().then((err) => {
        if (err) this.ready = null; // try again next time
        return err;
      });
    }
    return this.ready.then(async (err) => {
      if (err) return err;
      // Still running? (The VM may have been stopped behind our back.)
      const st = await this.docker(["inspect", "-f", "{{.State.Running}}", CONTAINER], 20_000);
      if (st.code === 0 && st.out.trim() === "true") return null;
      this.ready = null;
      return this.ensure();
    });
  }

  /** Run renki-runner.mjs in the container, as its unprivileged user. */
  readonly wrapper: RunWrapper = (args, opts = {}) =>
    new Promise((resolve) => {
      this.touch();
      const child = spawn(this.cfg.docker, ["--context", this.context, "exec", "-i", CONTAINER, "node", "/opt/renki/renki-runner.mjs", ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      let err = "";
      let written: Promise<void> = Promise.resolve();
      if (opts.stdoutTo) {
        const file = createWriteStream(opts.stdoutTo, { mode: 0o600 });
        written = new Promise((res) => file.on("close", () => res()).on("error", () => res()));
        child.stdout.pipe(file);
      } else child.stdout.on("data", (d: Buffer) => (opts.onOutput ? opts.onOutput(d) : out.push(d)));
      child.stderr.on("data", (d: Buffer) => {
        if (opts.onOutput) opts.onOutput(d);
        err = (err + d.toString()).slice(-20_000);
      });
      child.on("error", (e) => resolve({ code: 127, stdout: Buffer.alloc(0), stderr: String(e) }));
      child.on("close", (code) => void written.then(() => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err })));
      child.stdin.end(opts.stdin ?? Buffer.alloc(0));
    });

  /** Stop the VM (lending switched off, or idle). Everything in it stops with it. */
  async stop(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.ready = null;
    const st = await exec(this.cfg.colima, ["status", this.cfg.profile], { timeoutMs: 20_000 });
    if (st.code !== 0) return;
    this.log("stopping the build VM");
    await exec(this.cfg.colima, ["stop", this.cfg.profile], { timeoutMs: 120_000 });
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), IDLE_MS);
    this.idle.unref();
  }

  private docker(args: string[], timeoutMs: number, input?: string) {
    return exec(this.cfg.docker, ["--context", this.context, ...args], { timeoutMs, input });
  }

  private async bringUp(): Promise<string | null> {
    const { profile, colima } = this.cfg;
    // 1. The VM: created with no shared folders and no port forwarding.
    if ((await exec(colima, ["status", profile], { timeoutMs: 20_000 })).code !== 0) {
      this.log("starting the build VM");
      const created = existsSync(join(homedir(), ".colima", profile, "colima.yaml"));
      const flags = created
        ? []
        : ["--vm-type", "vz", "--vz-rosetta", "--cpus", String(this.cfg.cpus), "--memory", String(this.cfg.memoryGb), "--disk", String(this.cfg.diskGb), "--mount", "none", "--port-forwarder", "none"];
      const st = await exec(colima, ["start", profile, "--activate=false", ...flags], { timeoutMs: 10 * 60_000 });
      if (st.code !== 0) return `The build VM didn't start: ${st.out.trim().split("\n").slice(-3).join(" ")}`;
    }
    const mounts = await exec(colima, ["ssh", "-p", profile, "--", "sh", "-c", "mount | awk '$5 ~ /^(virtiofs|9p|fuse|fuse\\.sshfs|nfs|nfs4|cifs|smb3)$/ && !($1 == \"vz-rosetta\" && $3 == \"/mnt/lima-rosetta\")' || true"], { timeoutMs: 30_000 });
    if (mounts.code !== 0) return "Couldn't inspect the build VM.";
    // Only Apple's Rosetta runtime (vz-rosetta) may be shared in; it holds Apple's binaries, not your files.
    if (mounts.out.trim()) return `Refused: the build VM has folders from the Mac shared into it (${mounts.out.trim().split("\n")[0]}). It must have none.`;

    // 2. The build network and its firewall.
    if ((await this.docker(["network", "inspect", NETWORK], 20_000)).code !== 0) {
      const n = await this.docker(["network", "create", "--opt", `com.docker.network.bridge.name=${BRIDGE}`, NETWORK], 30_000);
      if (n.code !== 0) return `Couldn't create the build network: ${n.out.trim()}`;
    }
    const fw = await exec(colima, ["ssh", "-p", profile, "--", "sudo", "sh", "-s"], { input: FIREWALL, timeoutMs: 30_000 });
    if (fw.code !== 0) return `Couldn't set up the build VM's firewall: ${fw.out.trim()}`;

    // 3. The image, rebuilt whenever the Dockerfile or the wrapper changes.
    const hash = createHash("sha256")
      .update(readFileSync(join(this.imageDir, "Dockerfile")))
      .update(readFileSync(join(this.imageDir, "renki-runner.mjs")))
      .digest("hex")
      .slice(0, 12);
    const image = `renki-runner:${hash}`;
    if ((await this.docker(["image", "inspect", image], 20_000)).code !== 0) {
      this.log(`building the runner image ${image} (first time takes a few minutes)`);
      const b = await this.docker(["build", "-t", image, this.imageDir], 30 * 60_000);
      if (b.code !== 0) return `Building the runner image failed: ${b.out.trim().split("\n").slice(-8).join("\n")}`;
    }

    // 4. The container: recreated when the image changed. The home volume (SDK, caches, mirrors) persists.
    const current = await this.docker(["inspect", "-f", "{{.Config.Image}} {{.State.Running}}", CONTAINER], 20_000);
    if (current.code !== 0 || current.out.trim() !== `${image} true`) {
      await this.docker(["rm", "-f", CONTAINER], 60_000);
      const r = await this.docker(
        [
          "run", "-d", "--name", CONTAINER, "--hostname", CONTAINER,
          "--network", NETWORK,
          "--user", "1000:1000",
          "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges",
          "--pids-limit", "8192",
          "--memory", `${Math.max(2, this.cfg.memoryGb - 1)}g`,
          "-v", `${VOLUME}:/home/runner`,
          image,
        ],
        120_000,
      );
      if (r.code !== 0) return `Couldn't start the build container: ${r.out.trim()}`;
      const prep = await this.wrapper(["prepare"]);
      if (prep.code !== 0) return `Preparing the Android SDK failed: ${prep.stderr.trim()}`;
    }
    this.log("build VM ready");
    return null;
  }
}
