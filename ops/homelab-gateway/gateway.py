#!/usr/bin/env python3
"""Homelab gateway: the only thing a Renki session's SSH key can run.

Invoked as the forced command of an SSH key (via sudo, as the homelab user).
The session names a verb and an app; this file decides whether that is allowed
by /etc/homelab-gateway/policy.json and runs a fixed command list (never a
shell). See docs/homelab-gateway.md.
"""
import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys
import time
import uuid

POLICY_PATH = "/etc/homelab-gateway/policy.json"
DISABLED_PATH = "/etc/homelab-gateway/DISABLED"
AUDIT_LOG = "/var/log/homelab-gateway.log"
JOBS_DIR = "/var/log/homelab-gateway-jobs"

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")
SINCE_RE = re.compile(r"^[0-9]{1,3}[smhd]$")
DB_IMAGE_RE = re.compile(r"postgres|postgis|mysql|mariadb|mongo|couchdb|redis|valkey|sqlite", re.I)

TIER2 = {"rm-path", "remove-container"}


class Refused(Exception):
    pass


def load_policy(path=POLICY_PATH):
    with open(path) as f:
        return json.load(f)


def cap(text, limit):
    data = text.encode("utf-8", "replace")
    if len(data) <= limit:
        return text
    return data[-limit:].decode("utf-8", "replace") + f"\n[output truncated to last {limit} bytes]\n"


def run(cmd, cwd=None, timeout=1800):
    """Run a fixed argument list. Never through a shell."""
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def get_app(policy, name, modes):
    if not NAME_RE.match(name or ""):
        raise Refused("bad app name")
    app = policy["apps"].get(name)
    if app is None:
        raise Refused(f"unknown app '{name}'")
    if app["mode"] not in modes:
        raise Refused(f"app '{name}' is {app['mode']}; this verb needs one of: {', '.join(sorted(modes))}")
    return app


def app_dir(policy, app):
    return os.path.join(policy["run_as_home"], app["dir"])


def is_protected(policy, container):
    return any(fnmatch.fnmatch(container, pat) for pat in policy["protected_containers"])


def existing_containers():
    rc, out = run(["docker", "ps", "-a", "--format", "{{.Names}}"], timeout=30)
    return set(out.split()) if rc == 0 else set()


# ---- verbs -----------------------------------------------------------------

def v_status(policy, args):
    fmt = "table {{.Names}}\t{{.Status}}\t{{.Image}}"
    cmd = ["docker", "ps", "-a", "--format", fmt]
    if args:
        app = policy["apps"].get(args[0])
        if app is None:
            raise Refused(f"unknown app '{args[0]}'")
        cmd += ["--filter", "label=com.docker.compose.project=" + os.path.basename(app["dir"])]
    return run(cmd, timeout=30)


def v_logs(policy, args):
    if not args:
        raise Refused("usage: logs <container> [--since 1h] [--lines N]")
    name, rest = args[0], args[1:]
    if not NAME_RE.match(name) or name not in existing_containers():
        raise Refused("no such container")
    since, lines = None, 200
    i = 0
    while i < len(rest):
        if rest[i] == "--since" and i + 1 < len(rest) and SINCE_RE.match(rest[i + 1]):
            since = rest[i + 1]; i += 2
        elif rest[i] == "--lines" and i + 1 < len(rest) and rest[i + 1].isdigit():
            lines = min(int(rest[i + 1]), policy["limits"]["logs_max_lines"]); i += 2
        else:
            raise Refused("usage: logs <container> [--since 1h] [--lines N]")
    cmd = ["docker", "logs", "--tail", str(lines)]
    if since:
        cmd += ["--since", since]
    return run(cmd + [name], timeout=60)


def v_top(policy, args):
    parts = []
    for title, cmd in [
        ("uptime", ["uptime"]),
        ("disk", ["df", "-h", "/"]),
        ("docker disk", ["docker", "system", "df"]),
        ("containers", ["docker", "stats", "--no-stream", "--format",
                        "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"]),
        ("top processes", ["ps", "-eo", "pid,pcpu,pmem,comm", "--sort=-pcpu"]),
    ]:
        rc, out = run(cmd, timeout=60)
        if title == "top processes":
            out = "\n".join(out.splitlines()[:11]) + "\n"
        parts.append(f"== {title}\n{out}")
    return 0, "\n".join(parts)


def v_backup_audit(policy, args):
    roots = tuple(policy["backup_covered_roots"])
    rc, out = run(["docker", "ps", "-a", "--format", "{{.Names}}"], timeout=30)
    names = out.split()
    uncovered, dbs = [], []
    for n in names:
        rc, insp = run(["docker", "inspect", n, "--format",
                        "{{.Config.Image}}|{{range .Mounts}}{{.Source}};{{end}}"], timeout=30)
        image, _, mounts = insp.strip().partition("|")
        for src in [m for m in mounts.split(";") if m]:
            if src.startswith(("/sys", "/proc", "/etc/localtime", "/var/run/docker.sock")):
                continue
            if not src.startswith(roots):
                uncovered.append(f"{n}: {src}")
        if DB_IMAGE_RE.search(image):
            dbs.append(f"{n} ({image})")
    lines = ["Mounts outside the backed-up roots (" + ", ".join(roots) + "):"]
    lines += ["  " + u for u in uncovered] or ["  none"]
    lines += ["", "Database-like containers (need a dump, not a file copy, unless already in a plan):"]
    lines += ["  " + d for d in dbs] or ["  none"]
    return 0, "\n".join(lines) + "\n"


def compose(policy, app, *tail, timeout):
    return run(["docker", "compose"] + list(tail), cwd=app_dir(policy, app), timeout=timeout)


def do_deploy(policy, name):
    app = policy["apps"][name]
    t = policy["limits"]["command_timeout_seconds"]
    out = ""
    if app.get("git"):
        rc, o = run(["git", "pull", "--ff-only"], cwd=app_dir(policy, app), timeout=300)
        out += "$ git pull --ff-only\n" + o
        if rc != 0:
            return rc, out + "git pull failed; nothing was rebuilt.\n"
    rc, o = compose(policy, app, "up", "-d", "--build", *app.get("services", []), timeout=t)
    return rc, out + "$ docker compose up -d --build " + " ".join(app.get("services", [])) + "\n" + o


def v_deploy(policy, args):
    if len(args) != 1:
        raise Refused("usage: deploy <app>")
    app = get_app(policy, args[0], {"deploy", "detached"})
    if app["mode"] == "detached":
        job = uuid.uuid4().hex[:10]
        os.makedirs(JOBS_DIR, exist_ok=True)
        log = open(os.path.join(JOBS_DIR, job + ".log"), "w")
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--run-job", args[0]],
                         stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         start_new_session=True,
                         env={k: v for k, v in os.environ.items() if k != "SSH_ORIGINAL_COMMAND"})
        return 0, (f"Started detached deploy of {args[0]} (job {job}).\n"
                   f"This session may be interrupted when the daemon restarts; "
                   f"read the result later with: job {job}\n")
    return do_deploy(policy, args[0])


def v_restart(policy, args):
    if len(args) != 1:
        raise Refused("usage: restart <app>")
    app = get_app(policy, args[0], {"deploy"})
    return compose(policy, app, "restart", *app.get("services", []), timeout=300)


def v_builder_prune(policy, args):
    if args:
        raise Refused("usage: builder-prune")
    return run(["docker", "builder", "prune", "-f"], timeout=900)


def v_caddy_reload(policy, args):
    if args:
        raise Refused("usage: caddy-reload")
    rc, out = run(["docker", "exec", "caddy", "caddy", "validate", "--config", "/etc/caddy/Caddyfile"], timeout=60)
    if rc != 0:
        return rc, out + "Caddyfile did not validate; not reloaded.\n"
    rc2, out2 = run(["docker", "exec", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], timeout=60)
    return rc2, out + out2


def v_job(policy, args):
    if len(args) != 1 or not re.fullmatch(r"[0-9a-f]{10}", args[0]):
        raise Refused("usage: job <id>")
    try:
        with open(os.path.join(JOBS_DIR, args[0] + ".log")) as f:
            return 0, f.read()
    except FileNotFoundError:
        raise Refused("no such job")


VERBS = {
    "status": v_status, "logs": v_logs, "top": v_top, "backup-audit": v_backup_audit,
    "deploy": v_deploy, "restart": v_restart, "builder-prune": v_builder_prune,
    "caddy-reload": v_caddy_reload, "job": v_job,
}
HELP = "verbs: " + ", ".join(sorted(VERBS)) + "  (rm-path, remove-container need phone approval: not enabled yet)"


def audit(entry):
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass  # never let logging block a refusal


def handle(command, policy=None, disabled_path=DISABLED_PATH):
    """Returns (exit_code, text). Never raises for policy reasons."""
    started = time.time()
    entry = {"ts": started, "cmd": command, "from": os.environ.get("SSH_CONNECTION", "")}
    try:
        if os.path.exists(disabled_path):
            raise Refused("gateway disabled (kill switch is on)")
        argv = shlex.split(command or "")
        if not argv:
            raise Refused(HELP)
        verb, args = argv[0], argv[1:]
        if verb in TIER2:
            raise Refused(f"'{verb}' needs phone approval, which is not enabled yet")
        if verb not in VERBS:
            raise Refused(f"unknown verb '{verb}'. {HELP}")
        policy = policy or load_policy()
        rc, out = VERBS[verb](policy, args)
        result = "ok" if rc == 0 else f"exit {rc}"
        out = cap(out, policy["limits"]["output_max_bytes"])
    except Refused as e:
        rc, out, result = 2, f"refused: {e}\n", "refused"
    except subprocess.TimeoutExpired:
        rc, out, result = 124, "timed out\n", "timeout"
    except Exception as e:  # noqa: BLE001 - report, don't leak a traceback shape
        rc, out, result = 1, f"gateway error: {type(e).__name__}\n", "error"
    entry.update(result=result, rc=rc, secs=round(time.time() - started, 2))
    audit(entry)
    return rc, out


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--run-job" and "SSH_ORIGINAL_COMMAND" not in os.environ:
        rc, out = do_deploy(load_policy(), sys.argv[2])
        sys.stdout.write(out + f"\n[done, exit {rc}]\n")
        return rc
    command = os.environ.get("SSH_ORIGINAL_COMMAND")
    if command is None:  # run by hand for testing
        command = shlex.join(sys.argv[1:])
    rc, out = handle(command)
    sys.stdout.write(out)
    return rc


if __name__ == "__main__":
    sys.exit(main())
