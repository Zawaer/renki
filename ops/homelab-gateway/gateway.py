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


def valid_binds(policy, raw):
    out = []
    for b in raw or []:
        src = b.get("source") if isinstance(b, dict) else None
        if isinstance(src, str) and src == os.path.realpath(src) and bind_refusal(policy, src) is None:
            out.append({"source": src, "rw": bool(b.get("rw"))})
    return out


def merge_added_apps(policy, added):
    """Added apps are always plain `deploy` apps, re-checked on every load: a name the base policy
    already has, a folder that is protected or another app's, or anything odd is skipped.
    "_binds" holds folders approved on the phone for apps of the base policy."""
    for name, raw in (added.get("_binds") or {}).items():
        app = policy["apps"].get(name)
        if app and app["mode"] == "deploy" and isinstance(raw, list):
            app["binds"] = valid_binds(policy, raw)
    for name, app in added.items():
        if name == "_binds":
            continue
        if not NAME_RE.match(name) or name in policy["apps"] or not isinstance(app, dict):
            continue
        d, services = app.get("dir"), app.get("services")
        if not isinstance(d, str) or not isinstance(services, list) or not all(isinstance(x, str) and NAME_RE.match(x) for x in services):
            continue
        try:
            check_app_dir(policy, d)
        except Refused:
            continue
        binds = valid_binds(policy, app.get("binds"))
        policy["apps"][name] = {"mode": "deploy", "dir": d, "git": bool(app.get("git")), "services": services,
                                "added": True, "binds": binds}


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
    # Every deployable app (not the detached ones: that's Renki, which asks before every deploy):
    # a session can commit to its repo, so what its compose file asks for is checked each time.
    if app["mode"] == "deploy":
        full = app_dir(policy, app)
        hard, binds = compose_findings(policy, full, compose_config(full), app.get("binds", []))
        refused = [f"mounts {short(policy, s)}: {bind_refusal(policy, s)}" for s, _ in binds if bind_refusal(policy, s)]
        if hard or refused:
            return 2, out + "refused: the compose file now does things an app may never do, so it wasn't deployed:\n  " + "\n  ".join(hard + refused) + "\n"
        if binds:
            # Folders outside its own: the user decides, once per folder, on the phone.
            summary = (f"{name}'s compose file now uses folders outside ~/{app['dir']}:\n"
                       + "\n".join(bind_label(policy, s, rw) for s, rw in binds)
                       + "\nAllow it, and deploy?")
            if not request_approval(policy, "deploy", [name], summary):
                return 3, out + "denied: the new folders weren't approved on the phone in time; nothing was rebuilt.\n"
            allow_binds(name, binds)
            out += "approved on the phone: " + ", ".join(short(policy, s) for s, _ in binds) + "\n"
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


def create_approval(approval_dir, verb, args, summary, ttl, now=None, password=False, pubkey=None):
    now = time.time() if now is None else now
    os.makedirs(approval_dir, mode=0o700, exist_ok=True)
    aid, token = secrets.token_hex(5), secrets.token_urlsafe(32)
    rec = {"id": aid, "verb": verb, "args": args, "summary": summary, "created": now,
           "expires": now + ttl, "token_sha256": hashlib.sha256(token.encode()).hexdigest()}
    if password:
        rec["password"] = True
    if pubkey:
        rec["pubkey"] = pubkey  # the browser encrypts a password typed on the Mac to this (see WebApprovals)
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


def _secret_path(approval_dir, aid):
    return os.path.join(approval_dir, aid + ".secret")


# A root command's approval carries the user's sudo password, typed on the phone. The phone never
# sends it in the clear: it XORs it with a one-time pad that came in the push (like the token, the
# pad exists only there and in the waiting gateway's memory). The approval service stores only that
# ciphertext, for the second or so until the gateway reads and deletes it.
PAD_BYTES = 128
SECRET_RE = re.compile(r"^[0-9a-f]{%d}$" % (PAD_BYTES * 2))


def seal_password(password, pad):
    """What the phone does (here for tests): password, zero-padded to the pad's length, XOR pad, hex."""
    data = password.encode("utf-8")
    if len(data) >= len(pad):
        raise ValueError("password too long")
    data += b"\x00" * (len(pad) - len(data))
    return bytes(a ^ b for a, b in zip(data, pad)).hex()


def open_password(secret_hex, pad):
    data = bytes(a ^ b for a, b in zip(bytes.fromhex(secret_hex), pad))
    return data.rstrip(b"\x00").decode("utf-8", "replace")


def take_secret(approval_dir, aid):
    """Read and delete the sealed password the phone sent with its approval (None if there is none)."""
    path = _secret_path(approval_dir, aid)
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def decide(approval_dir, aid, token, decision, now=None, secret=None):
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
    if decision == "approve" and rec.get("password"):
        if not isinstance(secret, str) or not SECRET_RE.match(secret):
            return 400, {"error": "password needed"}
        # Written before the decision, so the gateway finds it the moment it sees "approve".
        try:
            fd = os.open(_secret_path(approval_dir, aid), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return 409, {"error": "already decided"}
        with os.fdopen(fd, "w") as f:
            f.write(secret)
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
    return 200, {"summary": rec["summary"], "state": state, "expires": rec["expires"], "password": bool(rec.get("password"))}


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


def request_approval(policy, verb, args, summary, notify=None, approval_dir=None, sleep=time.sleep, now=time.time,
                     password=False, desktop=None):
    """Block until a decision. Returns True only for an in-time approval; with password=True, the
    password typed on the phone or the Mac (a str) instead of True.

    The phone is pushed at once, unless you're at the Mac (a Renki tab open there, and a Mac set up
    to approve with Touch ID): then the push waits DESKTOP_GRACE_SECONDS, and an approval given on
    the Mac meanwhile means the phone never buzzes. A chat faking "at the Mac" can only delay it."""
    cfg = approval_cfg(policy)
    approval_dir = approval_dir or APPROVAL_DIR
    ttl = int(cfg.get("timeout_seconds", 300))
    pad = secrets.token_bytes(PAD_BYTES) if password else None
    rsa_key = new_password_key() if password else None
    aid, token = create_approval(approval_dir, verb, args, summary, ttl, now(), password=password,
                                 pubkey=public_key_b64(rsa_key) if rsa_key else None)
    data = {"kind": "gateway-approval", "id": aid, "token": token, "url": cfg.get("url", "")}
    if pad:
        data["pad"] = pad.hex()
    notify = notify or (lambda **kw: send_push(push_tokens_from_db(cfg.get("push_db", "")), kw["title"], kw["body"], kw["data"]))
    at_desk = desktop() if desktop else desktop_present(approval_dir, now=now())
    push_at = now() + (DESKTOP_GRACE_SECONDS if at_desk else 0)
    delivered, pushed = False, False
    deadline = now() + ttl
    resends, last_sent = 0, now()
    while now() < deadline:
        if not pushed and now() >= push_at:
            delivered = notify(title="Approve on the homelab?", body=summary, data=data)
            pushed, last_sent = True, now()
        d = read_decision(approval_dir, aid)
        if d is not None:
            sealed = take_secret(approval_dir, aid)
            if d != "approve":
                return False
            if not password:
                return True
            if sealed and sealed.startswith("rsa:") and rsa_key:
                return open_rsa_password(sealed[4:], rsa_key)
            if not sealed or not SECRET_RE.match(sealed):
                raise Refused("approved without a password; nothing was run")
            return open_password(sealed, pad)
        if os.path.exists(_resend_path(approval_dir, aid)):
            try:
                os.remove(_resend_path(approval_dir, aid))
            except OSError:
                pass
            if pushed and resends < MAX_RESENDS and now() - last_sent >= RESEND_GAP_SECONDS:
                # The same request and token again, so whichever copy the phone answers counts.
                delivered = notify(title="Approve on the homelab?", body=summary, data=data) or delivered
                resends, last_sent = resends + 1, now()
            elif not pushed:
                push_at = now()  # "send to phone" from the Mac: don't wait out the grace
        sleep(1)
    write_decision(approval_dir, aid, "deny")  # nobody answered: closed for good
    if not delivered:
        raise Refused("no phone could be notified (is the Renki app registered for push?); denied")
    return False


# ---- approving on the Mac: Touch ID (WebAuthn passkeys) ---------------------
#
# The phone is trusted because the one-time token only reaches it. A browser tab has no such secret
# (anything Renki's page can do, a chat can do), so the Mac proves itself with a passkey instead:
# a key in the Mac's secure enclave that signs only after Touch ID. Devices are added with
# `sudo homelab-gateway --admin enroll <name>` on the host (root, so no chat can start it), which
# prints a link that is good for ten minutes and one device.
#
# The sudo password typed on the Mac goes straight to this service over HTTPS, encrypted in the
# browser (RSA-OAEP) to a key pair the waiting gateway made for this one request and keeps in memory.

APPROVERS_PATH = "/var/lib/homelab-gateway/approvers.json"
ENROLL_PATH = "/var/lib/homelab-gateway/enroll.json"
DESKTOP_SEEN = "desktop-seen"  # in the approval dir: touched while a Renki tab on a computer is open
DESKTOP_FRESH_SECONDS = 20
DESKTOP_GRACE_SECONDS = 30
ENROLL_TTL = 600
CHALLENGE_TTL = 180
B64URL_RE = re.compile(r"^[A-Za-z0-9_-]{1,4096}$")


def b64u(data):
    import base64
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text):
    import base64
    if not isinstance(text, str) or not B64URL_RE.match(text):
        raise ValueError("bad base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_password_key():
    try:
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        return None  # without it, root commands can only be approved on the phone
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def public_key_b64(key):
    from cryptography.hazmat.primitives import serialization
    import base64
    der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(der).decode()


def open_rsa_password(b64, key):
    import base64
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    try:
        plain = key.decrypt(base64.b64decode(b64), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    except Exception:  # noqa: BLE001
        raise Refused("couldn't read the password sent from the Mac; nothing was run")
    return plain.decode("utf-8", "replace")


def read_approvers(path=None):
    try:
        with open(path or APPROVERS_PATH) as f:
            data = json.load(f)
        return [a for a in data.get("devices", []) if isinstance(a, dict) and "id" in a and "pem" in a]
    except (OSError, ValueError, AttributeError):
        return []


def write_approvers(devices, path=None):
    path = path or APPROVERS_PATH
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"devices": devices}, f, indent=2)
    os.replace(tmp, path)


def mark_desktop(approval_dir, now=None):
    path = os.path.join(approval_dir, DESKTOP_SEEN)
    try:
        with open(path, "a"):
            pass
        t = time.time() if now is None else now
        os.utime(path, (t, t))
    except OSError:
        pass


def desktop_present(approval_dir, approvers_path=None, now=None):
    """A Renki tab on a computer reported in lately, and some device can approve with Touch ID."""
    now = time.time() if now is None else now
    try:
        fresh = now - os.path.getmtime(os.path.join(approval_dir, DESKTOP_SEEN)) <= DESKTOP_FRESH_SECONDS
    except OSError:
        return False
    return fresh and bool(read_approvers(approvers_path))


def rp_id(policy):
    url = approval_cfg(policy).get("url", "")
    return re.sub(r"^https://|/.*$", "", url)


def check_client_data(raw, kind, challenge, origin):
    cd = json.loads(raw.decode("utf-8"))
    if cd.get("type") != kind:
        raise Refused("wrong kind of passkey response")
    if cd.get("origin") != origin:
        raise Refused("passkey response from the wrong site")
    if cd.get("challenge") != challenge:
        raise Refused("passkey response for a different request")


def check_auth_data(auth, rpid, need_uv=True):
    if len(auth) < 37 or auth[:32] != hashlib.sha256(rpid.encode()).digest():
        raise Refused("passkey made for a different site")
    flags = auth[32]
    if not flags & 0x01 or (need_uv and not flags & 0x04):
        raise Refused("Touch ID (or the device password) is needed")


class WebApprovals:
    """The approval service's Touch ID side. Challenges live in this process's memory only."""

    def __init__(self, policy, approval_dir=None, approvers_path=None, enroll_path=None):
        self.policy = policy
        self.dir = approval_dir or APPROVAL_DIR
        self.approvers_path = approvers_path or APPROVERS_PATH
        self.enroll_path = enroll_path or ENROLL_PATH
        self.rpid = rp_id(policy)
        self.origin = "https://" + self.rpid
        self.challenges = {}  # challenge -> (purpose, expires)

    def _challenge(self, purpose, now):
        self.challenges = {c: v for c, v in self.challenges.items() if v[1] > now}
        c = b64u(secrets.token_bytes(32))
        self.challenges[c] = (purpose, now + CHALLENGE_TTL)
        return c

    def _use_challenge(self, c, purpose, now):
        v = self.challenges.pop(c, None)
        if not v or v[0] != purpose or v[1] < now:
            raise Refused("this page is out of date; reload it")

    # -- adding a device
    def _enroll_rec(self, code, now):
        try:
            with open(self.enroll_path) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            raise Refused("no device is being added; run the enroll command on the homelab")
        if now > rec.get("expires", 0) or not hmac.compare_digest(hashlib.sha256((code or "").encode()).hexdigest(), rec.get("code_sha256", "")):
            raise Refused("this link is wrong or has run out; run the enroll command again")
        return rec

    def enroll_options(self, body, now=None):
        now = time.time() if now is None else now
        rec = self._enroll_rec(body.get("code"), now)
        return {
            "challenge": self._challenge("enroll", now),
            "rp": {"id": self.rpid, "name": "Homelab approvals"},
            "user": {"id": b64u(hashlib.sha256(rec["name"].encode()).digest()[:16]), "name": rec["name"], "displayName": rec["name"]},
            "exclude": [a["id"] for a in read_approvers(self.approvers_path)],
        }

    def enroll_finish(self, body, now=None):
        """The browser's getPublicKey() (SPKI) and getAuthenticatorData(); attestation is not checked
        (the enroll link, which only root can make, is what proves the device is yours)."""
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        now = time.time() if now is None else now
        rec = self._enroll_rec(body.get("code"), now)
        cd = unb64u(body.get("clientDataJSON"))
        challenge = json.loads(cd.decode()).get("challenge", "")
        self._use_challenge(challenge, "enroll", now)
        check_client_data(cd, "webauthn.create", challenge, self.origin)
        check_auth_data(unb64u(body.get("authenticatorData")), self.rpid)
        key = serialization.load_der_public_key(unb64u(body.get("publicKey")))
        if not isinstance(key, ec.EllipticCurvePublicKey):
            raise Refused("only ES256 passkeys are supported")
        cred_id = body.get("id")
        unb64u(cred_id)
        pem = key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        devices = [a for a in read_approvers(self.approvers_path) if a["id"] != cred_id]
        devices.append({"id": cred_id, "pem": pem, "name": rec["name"], "added": now})
        write_approvers(devices, self.approvers_path)
        try:
            os.remove(self.enroll_path)  # one device per link
        except OSError:
            pass
        return {"ok": True, "name": rec["name"]}

    # -- approving
    def view(self, aid, now=None):
        now = time.time() if now is None else now
        if not ID_RE.match(aid or ""):
            raise Refused("bad request")
        try:
            with open(_rec_path(self.dir, aid)) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            return {"state": "gone"}
        state = read_decision(self.dir, aid) or ("expired" if now > rec["expires"] else "pending")
        return {
            "state": state, "summary": rec["summary"], "expires": rec["expires"], "password": bool(rec.get("password")),
            "pubkey": rec.get("pubkey"), "challenge": self._challenge("approve:" + aid, now) if state == "pending" else None,
            "devices": [a["id"] for a in read_approvers(self.approvers_path)],
        }

    def answer(self, aid, body, now=None):
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        now = time.time() if now is None else now
        if not ID_RE.match(aid or ""):
            raise Refused("bad request")
        decision = body.get("decision")
        if decision not in ("approve", "deny"):
            raise Refused("bad request")
        try:
            with open(_rec_path(self.dir, aid)) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            raise Refused("this request is no longer on the homelab")
        if now > rec["expires"]:
            raise Refused("too late: this request expired")
        if decision == "deny":
            # Saying no takes nothing: a chat denying its own request gains nothing.
            return {"ok": write_decision(self.dir, aid, "deny"), "decision": "deny"}
        cred = next((a for a in read_approvers(self.approvers_path) if a["id"] == body.get("id")), None)
        if not cred:
            raise Refused("this device isn't set up to approve; add it with the enroll command")
        cd, auth, sig = unb64u(body.get("clientDataJSON")), unb64u(body.get("authenticatorData")), unb64u(body.get("signature"))
        challenge = json.loads(cd.decode()).get("challenge", "")
        self._use_challenge(challenge, "approve:" + aid, now)
        check_client_data(cd, "webauthn.get", challenge, self.origin)
        check_auth_data(auth, self.rpid)
        key = serialization.load_pem_public_key(cred["pem"].encode())
        try:
            key.verify(sig, auth + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        except InvalidSignature:
            raise Refused("Touch ID signature didn't check out")
        if rec.get("password"):
            enc = body.get("password")
            if not isinstance(enc, str) or not re.fullmatch(r"[A-Za-z0-9+/=]{100,1000}", enc):
                raise Refused("password needed")
            try:
                fd = os.open(_secret_path(self.dir, aid), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                raise Refused("already answered")
            with os.fdopen(fd, "w") as f:
                f.write("rsa:" + enc)
        if not write_decision(self.dir, aid, "approve"):
            raise Refused("already answered")
        return {"ok": True, "decision": "approve"}


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


# Folders no app may mount, whatever the user approves: with these a container owns the machine,
# Renki, the gateway, or the keys. Everything else inside the home folder can be asked for.
NEVER_BIND = ("/etc", "/proc", "/sys", "/dev", "/root", "/boot", "/run", "/var/run", "/var/lib/docker",
              "/var/lib/homelab-gateway", "/usr", "/bin", "/sbin", "/lib")
NEVER_BIND_IN_HOME = (".ssh", ".homelab-gateway", ".config", ".claude", ".gnupg", ".docker", "renki")


def bind_refusal(policy, src):
    """Why `src` may never be mounted into an app, or None if the user may allow it."""
    home = os.path.realpath(policy["run_as_home"])
    if "docker.sock" in src:
        return "the Docker socket"
    if src == "/" or src == home:
        return "the whole disk or home folder"
    if any(src == p or src.startswith(p + "/") for p in NEVER_BIND):
        return "a system folder"
    if not src.startswith(home + "/"):
        return "outside the home folder"
    top = src[len(home) + 1:].split("/")[0]
    if top in NEVER_BIND_IN_HOME:
        return "keys or settings, or Renki's own data"
    return None


def bind_label(policy, src, rw):
    """How the phone names a folder an app wants: protected ones say so."""
    prot = any(src == p or src.startswith(p + "/") for p in (os.path.realpath(x) for x in policy.get("protected_paths", [])))
    return f"- {short(policy, src)} ({'can change files' if rw else 'read only'}{', on your protected list' if prot else ''})"


def short(policy, path):
    home = os.path.realpath(policy["run_as_home"])
    return "~" + path[len(home):] if path.startswith(home + "/") else path


def compose_findings(policy, full, config, allowed=()):
    """(hard, binds): what an app may never do, and folders outside its own it mounts that aren't
    allowed yet, as (source, writable). Both empty means it may deploy as it is."""
    hard, binds, full = [], {}, os.path.realpath(full)
    ok = {(b["source"], b["rw"]) for b in allowed}
    for sname, svc in (config.get("services") or {}).items():
        if svc.get("privileged"):
            hard.append(f"{sname}: privileged")
        for key in ("network_mode", "pid", "ipc", "userns_mode", "uts", "cgroup"):
            v = str(svc.get(key) or "")
            if v == "host" or v.startswith("container:"):
                hard.append(f"{sname}: {key} {v}")
        for key in ("cap_add", "devices", "security_opt", "device_cgroup_rules", "volumes_from"):
            if svc.get(key):
                hard.append(f"{sname}: {key}")
        cname = svc.get("container_name")
        if cname and is_protected(policy, cname):
            hard.append(f"{sname}: container_name {cname} is protected")
        for vol in svc.get("volumes") or []:
            if not isinstance(vol, dict):
                hard.append(f"{sname}: a volume compose didn't normalize")
                continue
            if vol.get("type") != "bind":
                continue  # named volumes and tmpfs stay inside Docker
            src = os.path.realpath(vol.get("source") or "/")
            rw = not vol.get("read_only")
            if "docker.sock" in src:
                hard.append(f"{sname}: mounts the Docker socket")
            elif src in SAFE_BIND_SOURCES and not rw:
                continue
            elif src == full or src.startswith(full + "/"):
                continue
            elif (src, rw) in ok or (src, True) in ok:
                continue  # allowed before (read-write covers read-only)
            else:
                binds[src] = binds.get(src, False) or rw
    return hard, sorted(binds.items())


def compose_risks(policy, full, config):
    """Everything in a compose config that reaches outside its own folder. Empty means fine."""
    hard, binds = compose_findings(policy, full, config)
    return hard + [f"mounts {src}" for src, _ in binds]


def allow_binds(name, binds, added_path=None):
    """Record folders the user approved for an added app; the gateway alone writes this file."""
    path = added_path or ADDED_APPS_PATH
    added = read_added_apps(path)
    entry = added.get(name)
    base = not isinstance(entry, dict)  # an app of the base policy: its folders live under "_binds"
    current = (added.get("_binds") or {}).get(name, []) if base else entry.get("binds") or []
    have = {b["source"]: bool(b.get("rw")) for b in current if isinstance(b, dict) and "source" in b}
    for src, rw in binds:
        have[src] = have.get(src, False) or rw
    merged = [{"source": s, "rw": rw} for s, rw in sorted(have.items())]
    if base:
        write_added_app(path, "_binds", {**(added.get("_binds") or {}), name: merged})
    else:
        entry["binds"] = merged
        write_added_app(path, name, entry)


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
    hard, binds = compose_findings(policy, full, config)
    refused = [f"mounts {short(policy, s)}: {bind_refusal(policy, s)}" for s, _ in binds if bind_refusal(policy, s)]
    if hard or refused:
        raise Refused("the compose file does things an app may never do, so it can't be added:\n  " + "\n  ".join(hard + refused))
    known = sorted((config.get("services") or {}).keys())
    services = services or known
    unknown = [x for x in services if x not in known]
    if unknown or not services:
        raise Refused("unknown services: " + ", ".join(unknown) + " (the compose file has: " + ", ".join(known) + ")")
    return full, services, binds


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
    full, services, binds = check_new_app(policy, name, d, services)
    git = os.path.isdir(os.path.join(full, ".git"))
    summary = (f"Let Claude deploy and restart a new app '{name}' in ~/{d} (services: {', '.join(services)})"
               + (", pulling from git first" if git else "") + ". "
               + ("Its compose file only uses its own folder." if not binds else
                  "It also uses:\n" + "\n".join(bind_label(policy, s, rw) for s, rw in binds)))
    if not request_approval(policy, "add-app", args, summary):
        return 3, cloned + "denied: not approved on the phone in time.\n"
    policy_now = load_policy() if added_path is None else policy
    check_new_app(policy_now, name, d, services)  # again: the folder may have changed while waiting
    write_added_app(added_path or ADDED_APPS_PATH, name, {"dir": d, "git": git, "services": services,
                                                          "binds": [{"source": s, "rw": rw} for s, rw in binds]})
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


# ---- host commands (sh, sudo, the time window) --------------------------------
#
# Everything above is a fixed verb. These run a command the session wrote, so the user reads the
# command itself on the phone before it runs: `sh` as the homelab user, `sudo` as root with the
# user's own password typed on the phone (sudo checks it; no sudoers rule is involved). A time
# window lets `sh` run without asking for a while, for a long job the user is watching. Sessions
# share one container and one key, so a window is open to every chat that has homelab access, and
# the approval says so. `sudo` asks every time, window or not.

WINDOW_PATH = "/var/lib/homelab-gateway/window.json"
WINDOW_DEFAULT_MIN, WINDOW_MAX_MIN = 30, 30
SH_MAX_CHARS = 4000
SH_TIMEOUT = 1500  # under the 30 min a session's Bash call can wait


def window_until(path=None, now=None):
    """When the open window closes (unix seconds), or None when there is none."""
    now = time.time() if now is None else now
    try:
        with open(path or WINDOW_PATH) as f:
            until = float(json.load(f).get("until", 0))
    except (OSError, ValueError, AttributeError, TypeError):
        return None
    return until if until > now else None


def open_window(minutes, path=None, now=None):
    now = time.time() if now is None else now
    until = now + minutes * 60
    path = path or WINDOW_PATH
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"until": until, "opened": now}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return until


def close_window(path=None):
    try:
        os.remove(path or WINDOW_PATH)
        return True
    except FileNotFoundError:
        return False


def check_command(cmd):
    cmd = (cmd or "").strip()
    if not cmd:
        raise Refused("usage: sh <command>  |  sudo <command>")
    if len(cmd) > SH_MAX_CHARS:
        raise Refused(f"command longer than {SH_MAX_CHARS} characters; put it in a script file and run that")
    if "\x00" in cmd:
        raise Refused("bad command")
    return cmd


def clock(ts):
    return time.strftime("%H:%M", time.localtime(ts))


def v_sh(policy, raw, window_path=None, approve=None):
    cmd = check_command(raw)
    approve = approve or request_approval
    until = window_until(window_path)
    if until is None:
        summary = f"Run on the homelab as {os.path.basename(policy['run_as_home'])}:\n{cmd}"
        if not approve(policy, "sh", [cmd], summary):
            return 3, "denied: not approved on the phone in time.\n"
        how = "approved"
    else:
        how = f"time window open until {clock(until)}"
    rc, out = run(["bash", "-lc", cmd], cwd=policy["run_as_home"], timeout=SH_TIMEOUT)
    return rc, f"[{how}; exit {rc}]\n" + out


def v_sudo(policy, raw, approve=None):
    cmd = check_command(raw)
    approve = approve or request_approval
    summary = f"Run as ROOT on the homelab:\n{cmd}\n\nEnter your sudo password to approve."
    password = approve(policy, "sudo", [cmd], summary, password=True)
    if not password:
        return 3, "denied: not approved on the phone in time.\n"
    # -k: use the password just given, never a cached sudo login, and leave none behind.
    # -S: read it from stdin (the command then gets EOF there). -p '': no prompt text in the output.
    p = subprocess.run(["sudo", "-k", "-S", "-p", "", "--", "bash", "-lc", cmd], cwd=policy["run_as_home"],
                       input=password + "\n", capture_output=True, text=True, timeout=SH_TIMEOUT)
    out = (p.stdout or "") + (p.stderr or "")
    if p.returncode != 0 and re.search(r"incorrect password|Sorry, try again|no password was provided", out):
        return p.returncode, "approved, but sudo didn't accept the password; nothing was run. Ask again.\n"
    return p.returncode, f"[approved, as root; exit {p.returncode}]\n" + out


def v_open_window(policy, args, window_path=None, approve=None):
    if len(args) > 1 or (args and not re.fullmatch(r"[0-9]{1,3}", args[0])):
        raise Refused(f"usage: open-window [minutes]  (default {WINDOW_DEFAULT_MIN}, at most {WINDOW_MAX_MIN})")
    minutes = int(args[0]) if args else WINDOW_DEFAULT_MIN
    if not 1 <= minutes <= WINDOW_MAX_MIN:
        raise Refused(f"between 1 and {WINDOW_MAX_MIN} minutes")
    approve = approve or request_approval
    user = os.path.basename(policy["run_as_home"])
    summary = (f"Let Renki run commands on the homelab as {user} without asking, for {minutes} minutes. "
               "Any chat with homelab access can use it. Root commands still need your password.")
    if not approve(policy, "open-window", [str(minutes)], summary):
        return 3, "denied: not approved on the phone in time.\n"
    until = open_window(minutes, window_path)
    return 0, f"approved; `homelab sh` runs without asking until {clock(until)}. End it early with `homelab close-window`.\n"


def v_close_window(policy, args, window_path=None):
    if args:
        raise Refused("usage: close-window")
    return 0, "window closed.\n" if close_window(window_path) else "no window was open.\n"


def v_window(policy, args, window_path=None):
    until = window_until(window_path)
    return 0, (f"open until {clock(until)}\n" if until else "closed: `homelab sh` asks on the phone each time.\n")


WEB_CSS = """
:root{color-scheme:light dark;--bg:#faf8f5;--fg:#1d1a17;--muted:#6f6760;--card:#fff;--border:#e6e0d8;--accent:#d97a3a;--accent-fg:#fff;--danger:#c83a37}
@media (prefers-color-scheme:dark){:root{--bg:#171310;--fg:#ede6de;--muted:#9c938a;--card:#211c18;--border:#352d27;--accent:#e8955a;--accent-fg:#1d1209;--danger:#ea6b62}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:560px}h1{font-size:18px;margin:0 0 4px}.muted{color:var(--muted);font-size:13px}
pre{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:16px 0}
.root{color:var(--danger)}input{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--fg);margin-bottom:12px}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:600;padding:11px;border-radius:999px;border:0;cursor:pointer}
.approve{background:var(--accent);color:var(--accent-fg)}.deny{background:var(--card);color:var(--fg);border:1px solid var(--border)}
button:disabled{opacity:.55;cursor:default}#msg{margin-top:14px;min-height:20px}
"""

WEB_JS = r"""
const $=s=>document.querySelector(s);const enc=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const dec=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const say=t=>{$('#msg').textContent=t};
async function api(path,body){const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
async function sealPassword(pw,pubkey){const k=await crypto.subtle.importKey('spki',Uint8Array.from(atob(pubkey),c=>c.charCodeAt(0)),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 const c=await crypto.subtle.encrypt({name:'RSA-OAEP'},k,new TextEncoder().encode(pw));return btoa(String.fromCharCode(...new Uint8Array(c)))}
async function approvePage(){
 const aid=location.pathname.split('/').pop();let v;
 try{v=await api('/v1/web/'+aid)}catch(e){say(e.message);return}
 if(v.state!=='pending'){$('#summary').textContent=v.summary||'';say(v.state==='approve'?'Already approved.':v.state==='deny'?'Already denied.':'This request has closed.');return}
 $('#summary').textContent=v.summary;if(v.password){$('#summary').classList.add('root');$('#pw').hidden=false;$('#pw').focus()}
 const left=()=>{const s=Math.max(0,Math.ceil(v.expires-Date.now()/1000));$('#left').textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')+' left, then it is denied.';if(!s){say('Ran out of time.');$('#a').disabled=$('#d').disabled=true}};left();setInterval(left,1000);
 $('#a').disabled=$('#d').disabled=false;
 if(!v.devices.length){$('#a').disabled=true;say('This Mac is not set up to approve yet. On the homelab, run: sudo homelab-gateway --admin enroll mac');}
 if(v.password&&!v.pubkey){$('#a').disabled=true;say('Approve this one on your phone.')}
 $('#d').onclick=async()=>{try{await api('/v1/web/'+aid,{decision:'deny'});say('Denied.');done()}catch(e){say(e.message)}};
 $('#a').onclick=async()=>{
  const pw=$('#pw').value;if(v.password&&!pw){say('Type your sudo password first.');return}
  $('#a').disabled=true;say('Waiting for Touch ID…');
  try{const cred=await navigator.credentials.get({publicKey:{challenge:dec(v.challenge),rpId:location.hostname,userVerification:'required',allowCredentials:v.devices.map(id=>({type:'public-key',id:dec(id)})),timeout:120000}});
   const r=cred.response;const body={decision:'approve',id:cred.id,clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.authenticatorData),signature:enc(r.signature)};
   if(v.password)body.password=await sealPassword(pw,v.pubkey);
   await api('/v1/web/'+aid,body);say('Approved.');done()}
  catch(e){say(e.name==='NotAllowedError'?'Touch ID was cancelled. Try again.':e.message);$('#a').disabled=false;try{v=await api('/v1/web/'+aid)}catch{}}};
}
function done(){$('#a').disabled=$('#d').disabled=true;$('#pw').value='';setTimeout(()=>window.close(),900)}
async function enrollPage(){
 const code=location.hash.slice(1);if(!code){say('Open the link the enroll command printed.');return}
 $('#a').disabled=false;
 $('#a').onclick=async()=>{$('#a').disabled=true;try{
  const o=await api('/v1/enroll/options',{code});
  const cred=await navigator.credentials.create({publicKey:{challenge:dec(o.challenge),rp:o.rp,user:{id:dec(o.user.id),name:o.user.name,displayName:o.user.displayName},
   pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'preferred'},
   excludeCredentials:o.exclude.map(id=>({type:'public-key',id:dec(id)})),attestation:'none',timeout:120000}});
  const r=cred.response;
  const j=await api('/v1/enroll/finish',{code,id:cred.id,clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.getAuthenticatorData()),publicKey:enc(r.getPublicKey())});
  say('Done: '+j.name+' can now approve homelab requests with Touch ID.')}catch(e){say(e.message);$('#a').disabled=false}}
}
(document.body.dataset.page==='enroll'?enrollPage:approvePage)();
"""


def web_page(kind):
    if kind == "enroll":
        body = ('<h1>Approve homelab requests with Touch ID</h1><p class="muted">Adds this device as an approver. '
                'The link works once, for ten minutes.</p><div class="row" style="margin-top:20px">'
                '<button id="a" class="approve" disabled>Set up Touch ID</button></div><input id="pw" hidden><button id="d" hidden></button>')
    else:
        body = ('<h1>Approve on the homelab?</h1><p class="muted">A Renki chat asked for this. <span id="left"></span></p>'
                '<pre id="summary">Loading…</pre><input id="pw" type="password" placeholder="Your sudo password" autocomplete="off" hidden>'
                '<div class="row"><button id="d" class="deny" disabled>Deny</button><button id="a" class="approve" disabled>Approve with Touch ID</button></div>')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Homelab approval</title><link rel="stylesheet" href="/web.css"></head><body data-page="{kind}"><main>{body}'
            f'<div id="msg" class="muted"></div></main><script src="/web.js"></script></body></html>')


class ApprovalHandler(BaseHTTPRequestHandler):
    approval_dir = APPROVAL_DIR
    window_path = WINDOW_PATH
    web = None  # WebApprovals, set by serve()

    def _reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _static(self, ctype, text):
        raw = text.encode()
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        # Only this site's own script, and never inside another page (no clickjacking from Renki's tab).
        self.send_header("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header("x-content-type-options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = min(int(self.headers.get("content-length") or 0), 16384)
        return json.loads(self.rfile.read(n) or b"{}")

    def _web(self, fn, *a):
        if self.web is None:
            return self._reply(404, {"error": "not set up"})
        try:
            return self._reply(200, fn(*a))
        except Refused as e:
            return self._reply(400, {"error": str(e)})
        except (ValueError, KeyError, TypeError):
            return self._reply(400, {"error": "bad request"})

    def _parts(self):
        m = re.fullmatch(r"/v1/approvals/([0-9a-f]{10})(?:\?.*)?", self.path)
        return m.group(1) if m else None

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/v1/approvals/pending":
            if "desktop=1" in self.path:
                mark_desktop(self.approval_dir)
            return self._reply(200, {"pending": list_pending(self.approval_dir), "window": window_until(self.window_path),
                                     "approvers": len(read_approvers(self.web.approvers_path)) if self.web else 0,
                                     "url": self.web.origin if self.web else None})
        if path == "/web.css":
            return self._static("text/css; charset=utf-8", WEB_CSS)
        if path == "/web.js":
            return self._static("text/javascript; charset=utf-8", WEB_JS)
        if path == "/enroll":
            return self._static("text/html; charset=utf-8", web_page("enroll"))
        m = re.fullmatch(r"/r/([0-9a-f]{10})", path)
        if m:
            return self._static("text/html; charset=utf-8", web_page("approve"))
        m = re.fullmatch(r"/v1/web/([0-9a-f]{10})", path)
        if m:
            return self._web(self.web.view, m.group(1)) if self.web else self._reply(404, {"error": "not set up"})
        aid = self._parts()
        token = (self.headers.get("x-approval-token") or "")
        self._reply(*(peek(self.approval_dir, aid, token) if aid else (404, {"error": "not found"})))

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/v1/approvals/resend":
            return self._reply(200, {"pending": request_resend(self.approval_dir)})
        if path == "/v1/window/close":
            # Closing only takes access away, so it needs no token (Renki's "End now" uses it).
            return self._reply(200, {"closed": close_window(self.window_path)})
        try:
            body = self._body()
        except ValueError:
            return self._reply(400, {"error": "bad request"})
        if not isinstance(body, dict):
            return self._reply(400, {"error": "bad request"})
        if self.web is not None:
            if path == "/v1/enroll/options":
                return self._web(self.web.enroll_options, body)
            if path == "/v1/enroll/finish":
                return self._web(self.web.enroll_finish, body)
            m = re.fullmatch(r"/v1/web/([0-9a-f]{10})", path)
            if m:
                return self._web(self.web.answer, m.group(1), body)
        aid = self._parts()
        if not aid:
            return self._reply(404, {"error": "not found"})
        self._reply(*decide(self.approval_dir, aid, body.get("token"), body.get("decision"), secret=body.get("secret")))

    def log_message(self, fmt, *a):
        pass


def serve(policy):
    host, _, port = approval_cfg(policy).get("listen", "127.0.0.1:4530").rpartition(":")
    try:
        import cryptography  # noqa: F401
        ApprovalHandler.web = WebApprovals(policy)
    except ImportError:
        ApprovalHandler.web = None  # Touch ID approvals need python3-cryptography; the phone still works
    ThreadingHTTPServer((host, int(port)), ApprovalHandler).serve_forever()


VERBS = {
    "status": v_status, "logs": v_logs, "top": v_top, "backup-audit": v_backup_audit,
    "deploy": v_deploy, "restart": v_restart, "builder-prune": v_builder_prune,
    "caddy-reload": v_caddy_reload, "job": v_job,
    "rm-path": v_rm_path, "remove-container": v_remove_container, "create-repo": v_create_repo,
    "add-app": v_add_app, "add-route": v_add_route,
    "open-window": v_open_window, "close-window": v_close_window, "window": v_window,
}
# Take the rest of the line as written, not split into words: ssh joins the client's arguments with
# spaces, so `homelab sh 'grep "a b" f'` arrives as `sh grep "a b" f`, and the remainder is the command.
RAW_VERBS = {"sh": v_sh, "sudo": v_sudo}
HELP = ("verbs: " + ", ".join(sorted([*VERBS, *RAW_VERBS])) + "  (rm-path, remove-container, create-repo, add-app, add-route, "
        "open-window and sudo wait for approval on the phone; sh does too unless a time window is open)")


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
        head, _, rest = (command or "").strip().partition(" ")
        if head in RAW_VERBS:
            policy = policy or load_policy()
            rc, out = RAW_VERBS[head](policy, rest)
        else:
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


def admin_enroll(name, policy=None, path=None, now=None):
    """`sudo homelab-gateway --admin enroll <name>`: a link that adds one device as a Touch ID approver.
    Root only: the homelab user (and so a command run in a time window) can't make one."""
    if os.geteuid() != 0:
        print("run it with sudo: sudo homelab-gateway --admin enroll <name>")
        return 2
    if not NAME_RE.match(name or ""):
        print("name: letters, digits, dots, dashes (e.g. mac)")
        return 2
    policy = policy or load_policy()
    now = time.time() if now is None else now
    code = secrets.token_urlsafe(24)
    path = path or ENROLL_PATH
    with open(path, "w") as f:
        json.dump({"name": name, "code_sha256": hashlib.sha256(code.encode()).hexdigest(), "expires": now + ENROLL_TTL}, f)
    home = os.stat(policy["run_as_home"])
    os.chown(path, home.st_uid, home.st_gid)  # the approval service (the homelab user) removes it once used
    os.chmod(path, 0o600)
    print(f"Open this on the device to add, within 10 minutes:\n  https://{rp_id(policy)}/enroll#{code}")
    return 0


def admin(argv):
    """Host-only fallback: `homelab-gateway --admin approve|deny <id>`; refused over SSH."""
    if "SSH_ORIGINAL_COMMAND" in os.environ:
        print("not over SSH")
        return 2
    if len(argv) == 2 and argv[0] == "enroll":
        return admin_enroll(argv[1])
    if len(argv) == 1 and argv[0] == "approvers":
        for a in read_approvers():
            print(a.get("name"), time.strftime("%Y-%m-%d", time.localtime(a.get("added", 0))), a["id"][:12])
        return 0
    if len(argv) == 2 and argv[0] == "remove-approver":
        devices = read_approvers()
        keep = [a for a in devices if a.get("name") != argv[1] and not a["id"].startswith(argv[1])]
        write_approvers(keep)
        d = os.stat(os.path.dirname(APPROVERS_PATH))
        os.chown(APPROVERS_PATH, d.st_uid, d.st_gid)  # the approval service must still read it
        print(f"removed {len(devices) - len(keep)}")
        return 0
    if len(argv) != 2 or argv[0] not in ("approve", "deny") or not ID_RE.match(argv[1]):
        print("usage (on the host): --admin approve|deny <id> | enroll <name> | approvers | remove-approver <name>")
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
