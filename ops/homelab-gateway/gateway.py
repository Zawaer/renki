#!/usr/bin/env python3
"""Homelab gateway: the only thing a Renki session's SSH key can run.

Invoked as the forced command of an SSH key (via sudo, as the homelab user).
The session names a verb and an app; this file decides whether that is allowed
by /etc/homelab-gateway/policy.json and runs a fixed command list (never a
shell). See docs/homelab-gateway.md.
"""
import fnmatch
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

POLICY_PATH = "/etc/homelab-gateway/policy.json"
DISABLED_PATH = "/etc/homelab-gateway/DISABLED"
AUDIT_LOG = "/var/log/homelab-gateway.log"
JOBS_DIR = "/var/log/homelab-gateway-jobs"
APPROVAL_DIR = "/var/lib/homelab-gateway/approvals"
# Apps added with `add-app` (after phone approval). Written only by the gateway; the root-owned
# policy.json stays the base and always wins on a name clash.
ADDED_APPS_PATH = "/var/lib/homelab-gateway/added-apps.json"
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")
SINCE_RE = re.compile(r"^[0-9]{1,3}[smhd]$")
DB_IMAGE_RE = re.compile(r"postgres|postgis|mysql|mariadb|mongo|couchdb|redis|valkey|sqlite", re.I)

ID_RE = re.compile(r"^[0-9a-f]{10}$")


class Refused(Exception):
    pass


def load_policy(path=POLICY_PATH, added_path=None):
    with open(path) as f:
        policy = json.load(f)
    merge_added_apps(policy, read_added_apps(added_path or ADDED_APPS_PATH))
    return policy


def read_added_apps(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def merge_added_apps(policy, added):
    """Added apps are always plain `deploy` apps, re-checked on every load: a name the base policy
    already has, a folder that is protected or another app's, or anything odd is skipped."""
    for name, app in added.items():
        if not NAME_RE.match(name) or name in policy["apps"] or not isinstance(app, dict):
            continue
        d, services = app.get("dir"), app.get("services")
        if not isinstance(d, str) or not isinstance(services, list) or not all(isinstance(x, str) and NAME_RE.match(x) for x in services):
            continue
        try:
            check_app_dir(policy, d)
        except Refused:
            continue
        policy["apps"][name] = {"mode": "deploy", "dir": d, "git": bool(app.get("git")), "services": services, "added": True}


def cap(text, limit):
    data = text.encode("utf-8", "replace")
    if len(data) <= limit:
        return text
    return data[-limit:].decode("utf-8", "replace") + f"\n[output truncated to last {limit} bytes]\n"


def run(cmd, cwd=None, timeout=1800, env=None):
    """Run a fixed argument list. Never through a shell. `env` is added to the process environment."""
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, **env} if env else None)
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
    if app.get("added"):
        full = app_dir(policy, app)
        risks = compose_risks(policy, full, compose_config(full))
        if risks:
            return 2, out + "refused: the compose file now reaches outside its folder, so it wasn't deployed:\n  " + "\n  ".join(risks) + "\n"
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


# ---- phone approval (tier 2) ------------------------------------------------
#
# A deleting verb never runs on the session's say-so. The gateway:
#   1. checks the request against the policy and writes its OWN plain-English summary
#      (nothing the session wrote is shown to the user),
#   2. stores only the SHA-256 of a one-time token, and pushes the token to the paired
#      phone (the session never sees the push or the token),
#   3. waits for the phone to present that token to the approval service (--serve),
#      which records one decision atomically,
#   4. runs the command only on "approve", within the timeout, exactly once.
# A session can reach the approval service's port, but without the token it can only
# fail; five wrong tries deny the request.

def approval_cfg(policy):
    return policy.get("approval") or {}


def _rec_path(approval_dir, aid):
    return os.path.join(approval_dir, aid + ".json")


def _dec_path(approval_dir, aid):
    return os.path.join(approval_dir, aid + ".decision")


def _resend_path(approval_dir, aid):
    return os.path.join(approval_dir, aid + ".resend")


# A lost notification is the token lost: it exists nowhere else but in the waiting gateway's memory.
# So the phone can ask for every open request to be pushed again. Asking needs no token and only
# ever pushes to the paired phone, so a session asking gets nothing but an extra notification there;
# the gaps and the cap keep even that from becoming spam.
RESEND_GAP_SECONDS = 20
MAX_RESENDS = 5


def request_resend(approval_dir, now=None):
    """Flag every open request to be pushed to the phone again. Returns how many are open."""
    now = time.time() if now is None else now
    try:
        names = os.listdir(approval_dir)
    except FileNotFoundError:
        return 0
    n = 0
    for name in names:
        aid = name[:-5] if name.endswith(".json") else None
        if not aid or not ID_RE.match(aid):
            continue
        try:
            with open(_rec_path(approval_dir, aid)) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        if now > rec["expires"] or read_decision(approval_dir, aid) is not None:
            continue
        n += 1
        try:
            os.close(os.open(_resend_path(approval_dir, aid), os.O_WRONLY | os.O_CREAT, 0o600))
        except OSError:
            pass
    return n


def list_pending(approval_dir, now=None):
    """Requests still waiting for the phone: what Renki's tabs show. Never the token or its hash, so
    seeing this list (anyone on the Docker network can) is no step towards approving anything."""
    now = time.time() if now is None else now
    out = []
    try:
        names = os.listdir(approval_dir)
    except FileNotFoundError:
        return out
    for name in names:
        aid = name[:-5] if name.endswith(".json") else None
        if not aid or not ID_RE.match(aid):
            continue
        try:
            with open(_rec_path(approval_dir, aid)) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        if now > rec["expires"] or read_decision(approval_dir, aid) is not None:
            continue
        out.append({"id": aid, "verb": rec["verb"], "summary": rec["summary"], "created": rec["created"], "expires": rec["expires"]})
    return sorted(out, key=lambda r: r["created"])


def create_approval(approval_dir, verb, args, summary, ttl, now=None):
    now = time.time() if now is None else now
    os.makedirs(approval_dir, mode=0o700, exist_ok=True)
    aid, token = secrets.token_hex(5), secrets.token_urlsafe(32)
    rec = {"id": aid, "verb": verb, "args": args, "summary": summary, "created": now,
           "expires": now + ttl, "token_sha256": hashlib.sha256(token.encode()).hexdigest()}
    tmp = _rec_path(approval_dir, aid) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(rec, f)
    os.replace(tmp, _rec_path(approval_dir, aid))
    return aid, token


def read_decision(approval_dir, aid):
    try:
        with open(_dec_path(approval_dir, aid)) as f:
            return f.read().strip()
    except FileNotFoundError:
        return None


def write_decision(approval_dir, aid, decision):
    """First writer wins (O_EXCL); returns False if a decision already exists."""
    try:
        fd = os.open(_dec_path(approval_dir, aid), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w") as f:
        f.write(decision)
    return True


_bad_attempts = {}


def decide(approval_dir, aid, token, decision, now=None):
    """The approval service's whole job. Returns (http_status, body)."""
    now = time.time() if now is None else now
    if not ID_RE.match(aid or "") or decision not in ("approve", "deny") or not isinstance(token, str):
        return 400, {"error": "bad request"}
    try:
        with open(_rec_path(approval_dir, aid)) as f:
            rec = json.load(f)
    except (FileNotFoundError, ValueError):
        return 404, {"error": "unknown request"}
    if now > rec["expires"]:
        return 410, {"error": "expired"}
    if read_decision(approval_dir, aid) is not None:
        return 409, {"error": "already decided"}
    good = hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), rec["token_sha256"])
    if not good:
        _bad_attempts[aid] = _bad_attempts.get(aid, 0) + 1
        if _bad_attempts[aid] >= 5:
            write_decision(approval_dir, aid, "deny")
        return 403, {"error": "forbidden"}
    if not write_decision(approval_dir, aid, "approve" if decision == "approve" else "deny"):
        return 409, {"error": "already decided"}
    return 200, {"ok": True, "decision": decision, "summary": rec["summary"]}


def peek(approval_dir, aid, token, now=None):
    """What the phone shows before the user taps: only with the right token."""
    now = time.time() if now is None else now
    if not ID_RE.match(aid or ""):
        return 400, {"error": "bad request"}
    try:
        with open(_rec_path(approval_dir, aid)) as f:
            rec = json.load(f)
    except (FileNotFoundError, ValueError):
        return 404, {"error": "unknown request"}
    if not hmac.compare_digest(hashlib.sha256((token or "").encode()).hexdigest(), rec["token_sha256"]):
        return 403, {"error": "forbidden"}
    state = read_decision(approval_dir, aid) or ("expired" if now > rec["expires"] else "pending")
    return 200, {"summary": rec["summary"], "state": state, "expires": rec["expires"]}


def push_tokens_from_db(db_path):
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
        try:
            return [r[0] for r in con.execute("SELECT expo_token FROM push_tokens")]
        finally:
            con.close()
    except sqlite3.Error:
        return []


def send_push(tokens, title, body, data):
    if not tokens:
        return False
    msgs = [{"to": t, "title": title, "body": body, "data": data, "categoryId": "gateway-approval",
             "channelId": "input", "priority": "high", "sound": "default"} for t in tokens]
    req = urllib.request.Request(EXPO_PUSH_URL, data=json.dumps(msgs).encode(),
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return 200 <= r.status < 300
    except OSError:
        return False


def request_approval(policy, verb, args, summary, notify=None, approval_dir=None, sleep=time.sleep, now=time.time):
    """Block until the phone decides. Returns True only for an in-time approval."""
    cfg = approval_cfg(policy)
    approval_dir = approval_dir or APPROVAL_DIR
    ttl = int(cfg.get("timeout_seconds", 300))
    aid, token = create_approval(approval_dir, verb, args, summary, ttl, now())
    notify = notify or (lambda **kw: send_push(push_tokens_from_db(cfg.get("push_db", "")), kw["title"], kw["body"], kw["data"]))
    delivered = notify(title="Approve on the homelab?", body=summary,
                       data={"kind": "gateway-approval", "id": aid, "token": token, "url": cfg.get("url", "")})
    deadline = now() + ttl
    resends, last_sent = 0, now()
    while now() < deadline:
        d = read_decision(approval_dir, aid)
        if d is not None:
            return d == "approve"
        if os.path.exists(_resend_path(approval_dir, aid)):
            try:
                os.remove(_resend_path(approval_dir, aid))
            except OSError:
                pass
            if resends < MAX_RESENDS and now() - last_sent >= RESEND_GAP_SECONDS:
                # The same request and token again, so whichever copy the phone answers counts.
                delivered = notify(title="Approve on the homelab?", body=summary,
                                   data={"kind": "gateway-approval", "id": aid, "token": token, "url": cfg.get("url", "")}) or delivered
                resends, last_sent = resends + 1, now()
        sleep(1)
    write_decision(approval_dir, aid, "deny")  # nobody answered: closed for good
    if not delivered:
        raise Refused("no phone could be notified (is the Renki app registered for push?); denied")
    return False


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def tree_stats(path, cap_files=200000):
    files = size = 0
    if os.path.isfile(path) or os.path.islink(path):
        return 1, os.lstat(path).st_size
    for root, dirs, names in os.walk(path):
        for n in names:
            files += 1
            try:
                size += os.lstat(os.path.join(root, n)).st_size
            except OSError:
                pass
            if files >= cap_files:
                return files, size
    return files, size


def check_rm_path(policy, raw):
    if not raw or "\x00" in raw or not raw.startswith("/"):
        raise Refused("usage: rm-path <absolute path inside an app's own folder>")
    real = os.path.realpath(raw)
    if real != raw:
        raise Refused("path must be canonical (no symlinks, '..' or double slashes)")
    home = policy["run_as_home"]
    for pat in policy.get("protected_paths", []):
        if real == pat or real.startswith(pat.rstrip("/") + "/") or pat.startswith(real.rstrip("/") + "/"):
            raise Refused("that path is protected")
    owner = None
    for name, app in policy["apps"].items():
        root = os.path.join(home, app["dir"])
        if app["mode"] in ("deploy", "detached") and real.startswith(root + "/"):
            owner = (name, root)
    if owner is None:
        raise Refused("only paths inside a deployable app's own folder can be removed")
    if ".git" in real[len(owner[1]):].split("/"):
        raise Refused("will not remove anything inside .git")
    if not os.path.lexists(real):
        raise Refused("no such path")
    files, size = tree_stats(real)
    kind = "folder" if os.path.isdir(real) and not os.path.islink(real) else "file"
    return real, f"Delete {kind} {real} ({owner[0]}): {files} files, {human_size(size)}. This cannot be undone."


def v_rm_path(policy, args):
    if len(args) != 1:
        raise Refused("usage: rm-path <path>")
    real, summary = check_rm_path(policy, args[0])
    if not request_approval(policy, "rm-path", args, summary):
        return 3, "denied: not approved on the phone in time.\n"
    # re-check right before acting: the world may have changed while waiting
    real2, _ = check_rm_path(policy, args[0])
    rc, out = run(["rm", "-rf", "--one-file-system", "--", real2], timeout=600)
    return rc, f"approved; removed {real2}\n" + out


def v_remove_container(policy, args):
    if len(args) != 1 or not NAME_RE.match(args[0]):
        raise Refused("usage: remove-container <name>")
    name = args[0]
    if is_protected(policy, name):
        raise Refused("that container is protected")
    rc, out = run(["docker", "inspect", name, "--format",
                   "{{.State.Status}}|{{index .Config.Labels \"com.docker.compose.project\"}}|{{.Config.Image}}"], timeout=30)
    if rc != 0:
        raise Refused("no such container")
    status, _, rest = out.strip().partition("|")
    project, _, image = rest.partition("|")
    deployable = {os.path.basename(a["dir"]) for a in policy["apps"].values() if a["mode"] in ("deploy", "detached")}
    if project not in deployable:
        raise Refused("only containers of a deployable app can be removed")
    if status == "running":
        raise Refused("container is running; stop it by redeploying or ask the user (only stopped containers can be removed)")
    summary = f"Remove stopped container {name} ({image}). Its volumes and data are kept."
    if not request_approval(policy, "remove-container", args, summary):
        return 3, "denied: not approved on the phone in time.\n"
    return run(["docker", "rm", name], timeout=60)


REPO_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$")  # no leading dash: never mistaken for an option


def v_create_repo(policy, args):
    """Create an empty GitHub repo under the policy's owner, after approval on the phone.

    Needs a login that can create repos (the Renki session token cannot). That login lives in
    policy github.config_dir on the host, which the container never sees, and is used for this
    one fixed command."""
    usage = "usage: create-repo <name> [--public]   (private unless --public; letters, digits, . _ -)"
    rest = list(args)
    public = "--public" in rest
    if public:
        rest.remove("--public")
    if len(rest) != 1 or not REPO_NAME_RE.match(rest[0]) or rest[0].endswith(".git") or rest[0] in (".", ".."):
        raise Refused(usage)
    name = rest[0]
    gh = policy.get("github") or {}
    owner, cfg = gh.get("owner"), gh.get("config_dir")
    if not owner or not cfg:
        raise Refused("repo creation is not set up on this host")
    env = {"GH_CONFIG_DIR": cfg, "GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1"}
    rc, out = run(["gh", "api", f"repos/{owner}/{name}", "--silent"], timeout=30, env=env)
    if rc == 0:
        raise Refused(f"{owner}/{name} already exists")
    if "404" not in out:
        raise Refused("couldn't check GitHub with the gateway's login (is it signed in?)")
    kind = "PUBLIC" if public else "private"
    summary = f"Create a {kind} GitHub repo {owner}/{name} (empty)." + (" Anyone on the internet can see a public repo." if public else "")
    if not request_approval(policy, "create-repo", args, summary):
        return 3, "denied: not approved on the phone in time.\n"
    rc, out = run(["gh", "repo", "create", f"{owner}/{name}", "--public" if public else "--private"], timeout=60, env=env)
    return rc, out + (f"created https://github.com/{owner}/{name}\n" if rc == 0 else "")


# ---- adding apps and routes (tier 2) ---------------------------------------
#
# Both only ever widen what the gateway may touch by one named thing, and only after the phone says
# yes. An added app is a plain `deploy` app in its own folder directly under the home folder, and its
# compose file is checked for anything that would reach outside that folder (privileged, host
# network, docker.sock, binds elsewhere). The check runs again on every deploy of an added app, since
# a later `git pull` could change the compose file.

DIR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")
HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$")
COMPOSE_FILES = ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml")
SAFE_BIND_SOURCES = ("/etc/localtime", "/etc/timezone")


def check_app_dir(policy, d):
    """A new app's folder: one plain name directly under the home folder, not protected, not another app's."""
    if not isinstance(d, str) or not DIR_RE.match(d) or d in (".", ".."):
        raise Refused("the folder must be a plain name directly under the home folder")
    full = os.path.join(policy["run_as_home"], d)
    for pat in policy.get("protected_paths", []):
        if full == pat or full.startswith(pat.rstrip("/") + "/") or pat.startswith(full + "/"):
            raise Refused("that folder is protected")
    for other in policy["apps"].values():
        root = os.path.join(policy["run_as_home"], other["dir"])
        if full == root or root.startswith(full + "/") or full.startswith(root + "/"):
            raise Refused("that folder belongs to another app")
    if d.startswith("."):
        raise Refused("hidden folders can't be apps")
    return full


def compose_config(full):
    rc, out = run(["docker", "compose", "config", "--format", "json"], cwd=full, timeout=60)
    if rc != 0:
        raise Refused("docker compose config failed (is .env there?):\n" + out[-1500:])
    try:
        return json.loads(out[out.index("{"):])
    except ValueError:
        raise Refused("couldn't read the compose config")


def compose_risks(policy, full, config):
    """Everything in a compose config that reaches outside its own folder. Empty means fine."""
    risks, full = [], os.path.realpath(full)
    for sname, svc in (config.get("services") or {}).items():
        if svc.get("privileged"):
            risks.append(f"{sname}: privileged")
        for key in ("network_mode", "pid", "ipc", "userns_mode", "uts", "cgroup"):
            v = str(svc.get(key) or "")
            if v == "host" or v.startswith("container:"):
                risks.append(f"{sname}: {key} {v}")
        for key in ("cap_add", "devices", "security_opt", "device_cgroup_rules", "volumes_from"):
            if svc.get(key):
                risks.append(f"{sname}: {key}")
        cname = svc.get("container_name")
        if cname and is_protected(policy, cname):
            risks.append(f"{sname}: container_name {cname} is protected")
        for vol in svc.get("volumes") or []:
            if not isinstance(vol, dict):
                risks.append(f"{sname}: a volume compose didn't normalize")
                continue
            if vol.get("type") != "bind":
                continue  # named volumes and tmpfs stay inside Docker
            src = os.path.realpath(vol.get("source") or "/")
            if "docker.sock" in src:
                risks.append(f"{sname}: mounts the Docker socket")
            elif src in SAFE_BIND_SOURCES and vol.get("read_only"):
                continue
            elif src != full and not src.startswith(full + "/"):
                risks.append(f"{sname}: mounts {src}")
    return risks


def check_new_app(policy, name, d, services):
    if not NAME_RE.match(name or ""):
        raise Refused("bad app name")
    if name in policy["apps"]:
        raise Refused(f"'{name}' is already an app")
    full = check_app_dir(policy, d)
    if not os.path.isdir(full):
        raise Refused(f"~/{d} doesn't exist (pass --repo to clone it)")
    if not any(os.path.isfile(os.path.join(full, f)) for f in COMPOSE_FILES):
        raise Refused(f"no compose file in ~/{d}")
    config = compose_config(full)
    risks = compose_risks(policy, full, config)
    if risks:
        raise Refused("the compose file reaches outside its folder, so it can't be added this way:\n  " + "\n  ".join(risks))
    known = sorted((config.get("services") or {}).keys())
    services = services or known
    unknown = [x for x in services if x not in known]
    if unknown or not services:
        raise Refused("unknown services: " + ", ".join(unknown) + " (the compose file has: " + ", ".join(known) + ")")
    return full, services


def write_added_app(path, name, entry):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    added = read_added_apps(path)
    added[name] = entry
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(added, f, indent=2)
    os.replace(tmp, path)


def v_add_app(policy, args, added_path=None):
    """add-app <name> [--dir <folder>] [--repo <repo>] [--services a,b]

    Lets sessions deploy and restart one more app. --repo clones github.com/<owner>/<repo> into
    ~/<folder> first (owner from the policy, with the host's own git login)."""
    usage = "usage: add-app <name> [--dir <folder under ~, default name>] [--repo <GitHub repo to clone>] [--services a,b]"
    if not args or args[0].startswith("-"):
        raise Refused(usage)
    name, rest, opts = args[0], args[1:], {}
    while rest:
        if rest[0] in ("--dir", "--repo", "--services") and len(rest) >= 2 and rest[0] not in opts:
            opts[rest[0]] = rest[1]; rest = rest[2:]
        else:
            raise Refused(usage)
    d = opts.get("--dir", name)
    services = [x for x in opts.get("--services", "").split(",") if x]
    if any(not NAME_RE.match(x) for x in services):
        raise Refused(usage)
    if not NAME_RE.match(name):
        raise Refused("bad app name")
    if name in policy["apps"]:
        raise Refused(f"'{name}' is already an app")
    full = check_app_dir(policy, d)
    repo = opts.get("--repo")
    cloned = ""
    if repo is not None:
        owner = (policy.get("github") or {}).get("owner")
        if not owner or not REPO_NAME_RE.match(repo) or repo.endswith(".git"):
            raise Refused("--repo takes a repo name under " + str(owner))
        if os.path.exists(full):
            raise Refused(f"~/{d} already exists; leave out --repo to use it")
        url = f"https://github.com/{owner}/{repo}.git"
        rc, out = run(["git", "clone", "--", url, full], timeout=300)
        if rc != 0:
            raise Refused(f"git clone {url} failed:\n" + out[-1500:])
        cloned = f"$ git clone {url} ~/{d}\n" + out
    full, services = check_new_app(policy, name, d, services)
    git = os.path.isdir(os.path.join(full, ".git"))
    summary = (f"Let Claude deploy and restart a new app '{name}' in ~/{d} (services: {', '.join(services)})"
               + (", pulling from git first" if git else "") + ". Its compose file only uses its own folder.")
    if not request_approval(policy, "add-app", args, summary):
        return 3, cloned + "denied: not approved on the phone in time.\n"
    policy_now = load_policy() if added_path is None else policy
    check_new_app(policy_now, name, d, services)  # again: the folder may have changed while waiting
    write_added_app(added_path or ADDED_APPS_PATH, name, {"dir": d, "git": git, "services": services})
    return 0, cloned + f"approved; '{name}' is now an app. Deploy it with: deploy {name}\n"


def caddy_cfg(policy):
    c = policy.get("caddy") or {}
    return (os.path.join(policy["run_as_home"], c.get("file", "caddy/Caddyfile")),
            c.get("container", "caddy"), c.get("network", "homelab_net"))


def check_route(policy, host, upstream):
    if host.endswith(".internal"):
        host = host[:-len(".internal")]
    if not HOST_RE.match(host or ""):
        raise Refused("usage: add-route <name>[.internal] <container>:<port>")
    container, _, port = (upstream or "").rpartition(":")
    if not NAME_RE.match(container or "") or not port.isdigit() or not 0 < int(port) < 65536:
        raise Refused("usage: add-route <name>[.internal] <container>:<port>")
    if is_protected(policy, container):
        raise Refused("that container is protected")
    caddyfile, caddy, network = caddy_cfg(policy)
    rc, out = run(["docker", "inspect", container, "--format",
                   '{{index .Config.Labels "com.docker.compose.project"}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'], timeout=30)
    if rc != 0:
        raise Refused("no such container (deploy the app first)")
    project, _, nets = out.strip().partition("|")
    owner = [n for n, a in policy["apps"].items() if a["mode"] in ("deploy", "detached") and os.path.basename(a["dir"]) == project]
    if not owner:
        raise Refused("only containers of a deployable app can get a route")
    if network not in nets.split():
        raise Refused(f"{container} isn't on {network}, so Caddy can't reach it; add that network to its compose file")
    with open(caddyfile) as f:
        text = f.read()
    fqdn = host + ".internal"
    if re.search(r"(^|[\s,])" + re.escape(fqdn) + r"([\s,{]|$)", text, re.M):
        raise Refused(f"{fqdn} is already in the Caddyfile")
    return fqdn, container, int(port), owner[0], caddyfile, caddy, text


def v_add_route(policy, args):
    """add-route <name>[.internal] <container>:<port> - a Caddy site for one deployable app."""
    if len(args) != 2:
        raise Refused("usage: add-route <name>[.internal] <container>:<port>")
    fqdn, container, port, app, caddyfile, caddy, _ = check_route(policy, args[0], args[1])
    summary = f"Make https://{fqdn} open {container}:{port} (app {app}). Anyone on your tailnet can reach it."
    if not request_approval(policy, "add-route", args, summary):
        return 3, "denied: not approved on the phone in time.\n"
    fqdn, container, port, app, caddyfile, caddy, before = check_route(policy, args[0], args[1])
    block = f"\n# {app}, added by the homelab gateway (add-route)\n{fqdn} {{\n\treverse_proxy {container}:{port}\n\timport common\n}}\n"
    # In place, never a new file: Caddy's bind mount of a single file follows the inode.
    with open(caddyfile, "a") as f:
        f.write(block)
    rc, out = run(["docker", "exec", caddy, "caddy", "validate", "--config", "/etc/caddy/Caddyfile"], timeout=60)
    if rc != 0:
        with open(caddyfile, "r+") as f:
            f.write(before); f.truncate()
        return rc, out + "\nThe Caddyfile didn't validate with the new block, so it was put back.\n"
    rc, out2 = run(["docker", "exec", caddy, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], timeout=60)
    return rc, f"approved; https://{fqdn} -> {container}:{port}\n" + out2


class ApprovalHandler(BaseHTTPRequestHandler):
    approval_dir = APPROVAL_DIR

    def _reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _parts(self):
        m = re.fullmatch(r"/v1/approvals/([0-9a-f]{10})(?:\?.*)?", self.path)
        return m.group(1) if m else None

    def do_GET(self):
        if re.fullmatch(r"/v1/approvals/pending(?:\?.*)?", self.path):
            return self._reply(200, {"pending": list_pending(self.approval_dir)})
        aid = self._parts()
        token = (self.headers.get("x-approval-token") or "")
        self._reply(*(peek(self.approval_dir, aid, token) if aid else (404, {"error": "not found"})))

    def do_POST(self):
        if re.fullmatch(r"/v1/approvals/resend(?:\?.*)?", self.path):
            return self._reply(200, {"pending": request_resend(self.approval_dir)})
        aid = self._parts()
        if not aid:
            return self._reply(404, {"error": "not found"})
        try:
            n = min(int(self.headers.get("content-length") or 0), 4096)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._reply(400, {"error": "bad request"})
        self._reply(*decide(self.approval_dir, aid, body.get("token"), body.get("decision")))

    def log_message(self, fmt, *a):
        pass


def serve(policy):
    host, _, port = approval_cfg(policy).get("listen", "127.0.0.1:4530").rpartition(":")
    ThreadingHTTPServer((host, int(port)), ApprovalHandler).serve_forever()


VERBS = {
    "status": v_status, "logs": v_logs, "top": v_top, "backup-audit": v_backup_audit,
    "deploy": v_deploy, "restart": v_restart, "builder-prune": v_builder_prune,
    "caddy-reload": v_caddy_reload, "job": v_job,
    "rm-path": v_rm_path, "remove-container": v_remove_container, "create-repo": v_create_repo,
    "add-app": v_add_app, "add-route": v_add_route,
}
HELP = "verbs: " + ", ".join(sorted(VERBS)) + "  (rm-path, remove-container, create-repo, add-app and add-route wait for approval on the phone)"


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


def admin(argv):
    """Host-only fallback: `homelab-gateway --admin approve|deny <id>`; refused over SSH."""
    if "SSH_ORIGINAL_COMMAND" in os.environ or len(argv) != 2 or argv[0] not in ("approve", "deny") or not ID_RE.match(argv[1]):
        print("usage (on the host): --admin approve|deny <id>")
        return 2
    ok = write_decision(APPROVAL_DIR, argv[1], "approve" if argv[0] == "approve" else "deny")
    print("recorded" if ok else "already decided")
    return 0 if ok else 1


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--serve" and "SSH_ORIGINAL_COMMAND" not in os.environ:
        serve(load_policy())
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "--admin":
        return admin(sys.argv[2:])
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
