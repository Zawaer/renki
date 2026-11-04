/**
 * Which phone_shell commands only look, so they can run without asking.
 *
 * phone_shell hands its command to the phone's own `sh` (adb shell), so this
 * is strict: one plain command, no shell syntax at all (no ; & | ` $ ( ) < >
 * quotes, backslashes or newlines), and the command plus its first words must
 * be on the list below. Anything else asks the user, as before. Reading
 * battery stats, properties, settings, packages or files never changes the
 * phone; the few read commands that also have a writing form (dumpsys battery
 * set, wm size 1080x…) are cut down to their reading form.
 */

const SHELL_SYNTAX = /[;&|`$()<>'"\\\n\r*?[\]{}~#!]/;

/** Words that turn a dumpsys call into a change (dumpsys battery set/unplug/reset, batterystats --reset, deviceidle force-idle…). */
const DUMPSYS_WRITES = /^(set|reset|unplug|enable|disable|clear|kill|write|step|whitelist|tempwhitelist|except-idle-whitelist|sys-whitelist|force-.*|unforce|--reset|--enable|--disable|--write|--clear|--set.*|set-.*|reset-.*|--charged-reset|-c)$/i;

/** Commands that read whatever their arguments are. */
const ANY_ARGS = new Set([
  "getprop",
  "cat",
  "ls",
  "stat",
  "df",
  "du",
  "ps",
  "uptime",
  "date",
  "id",
  "whoami",
  "uname",
  "free",
  "wc",
  "head",
  "tail",
  "grep",
  "getenforce",
  "ip",
  "ifconfig",
  "netstat",
  "pidof",
  "which",
  "echo",
]);

/** Commands whose first argument must be one of these to only read. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  pm: new Set(["list", "path", "dump", "get-install-location", "has-feature"]),
  settings: new Set(["get", "list"]),
  content: new Set(["query"]),
  appops: new Set(["get", "query-op"]),
  wm: new Set(["size", "density"]), // only with no further words (see below)
  cmd: new Set(["package", "appops", "battery", "stats"]), // narrowed further below
  am: new Set(["get-current-user", "get-config", "stack", "get-standby-bucket"]),
  top: new Set(["-n", "-b"]),
};

export function phoneShellReadOnly(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || SHELL_SYNTAX.test(cmd)) return false;
  const words = cmd.split(/\s+/);
  const [head, ...rest] = words as [string, ...string[]];
  // `ip` and `ifconfig` can change interfaces too; only bare reads.
  if (head === "ip") return rest.length > 0 && ["addr", "a", "route", "r", "link", "neigh"].includes(rest[0]!) && (rest.length === 1 || rest[1] === "show");
  if (head === "ifconfig") return rest.length <= 1;
  if (head === "date") return rest.every((w) => w.startsWith("+") || w === "-u");
  if (head === "echo") return true;
  if (ANY_ARGS.has(head)) return true;
  if (head === "dumpsys") return !rest.some((w) => DUMPSYS_WRITES.test(w));
  const subs = SUBCOMMANDS[head];
  if (!subs || !rest.length || !subs.has(rest[0]!)) return false;
  switch (head) {
    case "wm":
      return rest.length === 1;
    case "top":
      return rest.includes("-n");
    case "am":
      return rest[0] !== "stack" || rest[1] === "list";
    case "cmd":
      // cmd package list …, cmd appops get …, cmd battery get …, cmd stats print-stats
      if (rest[0] === "package") return rest[1] === "list" || rest[1] === "dump";
      if (rest[0] === "appops") return rest[1] === "get" || rest[1] === "query-op";
      if (rest[0] === "battery") return rest[1] === "get";
      if (rest[0] === "stats") return rest[1] === "print-stats" || rest[1] === "print-uid-map";
      return false;
    default:
      return true;
  }
}
