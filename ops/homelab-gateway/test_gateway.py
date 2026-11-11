import json, os, tempfile, unittest
from unittest import mock
import gateway

POLICY = json.load(open(os.path.join(os.path.dirname(__file__), "policy.json")))


class Fake:
    """Records every command the gateway would have run."""
    def __init__(self, containers=("talkoot", "immich_server")):
        self.calls, self.containers = [], containers

    def __call__(self, cmd, cwd=None, timeout=1800, env=None):
        self.calls.append((cmd, cwd))
        self.envs = getattr(self, "envs", []) + [env]
        if cmd[:3] == ["docker", "ps", "-a"] and "{{.Names}}" in cmd[-1]:
            return 0, "\n".join(self.containers) + "\n"
        if cmd[:3] == ["docker", "compose", "config"]:
            return 0, '{"services": {}}'
        return 0, "ok\n"


class GatewayTest(unittest.TestCase):
    def go(self, command, fake=None, disabled=False):
        fake = fake or Fake()
        tmp = tempfile.mkdtemp()
        with mock.patch.object(gateway, "run", fake), \
             mock.patch.object(gateway, "AUDIT_LOG", os.path.join(tmp, "audit.log")), \
             mock.patch.object(gateway, "JOBS_DIR", os.path.join(tmp, "jobs")):
            dis = os.path.join(tmp, "DISABLED")
            if disabled:
                open(dis, "w").close()
            rc, out = gateway.handle(command, POLICY, disabled_path=dis)
        return rc, out, fake, os.path.join(tmp, "audit.log")

    def test_kill_switch_refuses_everything(self):
        rc, out, fake, _ = self.go("status", disabled=True)
        self.assertEqual(rc, 2); self.assertIn("kill switch", out); self.assertEqual(fake.calls, [])

    def test_unknown_verb_and_shell_metacharacters(self):
        for c in ["rm -rf /", "status; rm -rf /", "docker run x", "bash", ""]:
            rc, out, fake, _ = self.go(c)
            self.assertEqual(rc, 2, c)
            self.assertEqual(fake.calls, [], c)

    def test_deploy_allowed_app_runs_fixed_commands(self):
        rc, out, fake, _ = self.go("deploy talkoot")
        self.assertEqual(rc, 0)
        cmds = [c for c, _ in fake.calls]
        self.assertEqual(cmds[0], ["git", "pull", "--ff-only"])
        self.assertEqual(cmds[1][:3], ["docker", "compose", "config"])  # what it asks for, checked first
        self.assertEqual(cmds[2], ["docker", "compose", "up", "-d", "--build", "talkoot", "scout"])
        self.assertEqual(fake.calls[2][1], "/home/zawaer/talkoot")

    def test_deploy_without_git_skips_pull(self):
        rc, out, fake, _ = self.go("deploy scout-tool")
        self.assertEqual([c[0][:3] for c in fake.calls], [["docker", "compose", "config"], ["docker", "compose", "up"]])

    def test_read_only_and_unknown_apps_cannot_deploy_or_restart(self):
        for c in ["deploy immich", "restart dawarich", "deploy caddy", "deploy nonsense", "deploy ../etc", "deploy talkoot extra"]:
            rc, out, fake, _ = self.go(c)
            self.assertEqual(rc, 2, c); self.assertEqual(fake.calls, [], c)

    def test_detached_app_is_not_run_inline(self):
        with mock.patch.object(gateway.subprocess, "Popen") as popen:
            rc, out, fake, _ = self.go("deploy renki")
        self.assertEqual(rc, 0); self.assertIn("detached", out); popen.assert_called_once()
        self.assertEqual(fake.calls, [])
        self.assertNotIn("SSH_ORIGINAL_COMMAND", popen.call_args.kwargs["env"])

    def test_restart_rejects_detached(self):
        rc, out, fake, _ = self.go("restart renki")
        self.assertEqual(rc, 2); self.assertEqual(fake.calls, [])

    def test_logs_validates_container_and_options(self):
        rc, out, fake, _ = self.go("logs talkoot --since 1h --lines 99999")
        self.assertEqual(rc, 0)
        self.assertIn(["docker", "logs", "--tail", "2000", "--since", "1h", "talkoot"], [c for c, _ in fake.calls])
        for c in ["logs nonexistent", "logs talkoot --since 1y", "logs talkoot --follow", "logs ../x", "logs"]:
            rc, *_ = self.go(c); self.assertEqual(rc, 2, c)

    def test_builder_prune_is_cache_only(self):
        rc, out, fake, _ = self.go("builder-prune")
        self.assertEqual([c for c, _ in fake.calls], [["docker", "builder", "prune", "-f"]])
        self.assertEqual(self.go("builder-prune --all")[0], 2)

    def test_caddy_reload_validates_first(self):
        rc, out, fake, _ = self.go("caddy-reload")
        subs = [c[4] for c, _ in fake.calls]
        self.assertEqual(subs, ["validate", "reload"])

    def test_protected_pattern_matching(self):
        for name in ["immich_server", "dawarich_db", "caddy", "renki-daemon", "beszel-agent"]:
            self.assertTrue(gateway.is_protected(POLICY, name), name)
        self.assertFalse(gateway.is_protected(POLICY, "talkoot"))

    def test_audit_log_records_allowed_and_refused(self):
        _, _, _, log = self.go("deploy immich")
        self.go("status")
        lines = [json.loads(l) for l in open(log)]
        self.assertEqual(lines[0]["result"], "refused")
        self.assertEqual(lines[0]["cmd"], "deploy immich")

    def test_output_is_capped(self):
        self.assertLess(len(gateway.cap("x" * 1_000_000, 1000)), 1100)


class ApprovalTest(unittest.TestCase):
    def setUp(self):
        self.dir = os.path.realpath(tempfile.mkdtemp())
        self.home = os.path.realpath(tempfile.mkdtemp())  # macOS temp dirs sit behind a symlink
        os.makedirs(os.path.join(self.home, "talkoot/data/cache"))
        open(os.path.join(self.home, "talkoot/data/cache/a.bin"), "w").write("x" * 2048)
        os.makedirs(os.path.join(self.home, "immich/library"))
        os.makedirs(os.path.join(self.home, "talkoot/.git"))
        self.policy = json.loads(json.dumps(POLICY))
        self.policy["run_as_home"] = self.home
        self.policy["protected_paths"] = [os.path.join(self.home, "immich"), os.path.join(self.home, "talkoot/data/keep")]
        self.policy["approval"] = {"timeout_seconds": 3, "url": "https://x", "push_db": ""}

    def cap_notify(self):
        got = {}
        def notify(**kw):
            got.update(kw); return True
        return got, notify

    # --- the approval service
    def test_only_the_right_token_approves(self):
        aid, token = gateway.create_approval(self.dir, "rm-path", ["/x"], "s", 60)
        self.assertEqual(gateway.decide(self.dir, aid, "wrong", "approve")[0], 403)
        self.assertIsNone(gateway.read_decision(self.dir, aid))
        code, body = gateway.decide(self.dir, aid, token, "approve")
        self.assertEqual(code, 200)
        self.assertEqual(gateway.read_decision(self.dir, aid), "approve")

    def test_decision_is_single_use(self):
        aid, token = gateway.create_approval(self.dir, "rm-path", ["/x"], "s", 60)
        self.assertEqual(gateway.decide(self.dir, aid, token, "deny")[0], 200)
        self.assertEqual(gateway.decide(self.dir, aid, token, "approve")[0], 409)
        self.assertEqual(gateway.read_decision(self.dir, aid), "deny")

    def test_expired_request_cannot_be_approved(self):
        aid, token = gateway.create_approval(self.dir, "rm-path", ["/x"], "s", 10, now=1000)
        self.assertEqual(gateway.decide(self.dir, aid, token, "approve", now=1011)[0], 410)
        self.assertIsNone(gateway.read_decision(self.dir, aid))

    def test_five_wrong_tokens_deny_the_request(self):
        aid, token = gateway.create_approval(self.dir, "rm-path", ["/x"], "s", 60)
        gateway._bad_attempts.clear()
        for _ in range(5):
            gateway.decide(self.dir, aid, "guess", "approve")
        self.assertEqual(gateway.read_decision(self.dir, aid), "deny")
        self.assertEqual(gateway.decide(self.dir, aid, token, "approve")[0], 409)

    def test_token_is_not_stored_and_files_are_private(self):
        aid, token = gateway.create_approval(self.dir, "rm-path", ["/x"], "s", 60)
        raw = open(os.path.join(self.dir, aid + ".json")).read()
        self.assertNotIn(token, raw)
        self.assertEqual(oct(os.stat(os.path.join(self.dir, aid + ".json")).st_mode & 0o777), "0o600")

    def test_malformed_requests(self):
        for aid, tok, dec in [("../etc", "t", "approve"), ("a" * 10, "t", "approve"), ("0" * 10, None, "approve"), ("0" * 10, "t", "maybe")]:
            self.assertIn(gateway.decide(self.dir, aid, tok, dec)[0], (400, 404))

    # --- request_approval
    def test_waits_then_returns_true_on_approval_and_pushes_token_to_phone_only(self):
        got, notify = self.cap_notify()
        def sleeper(_):
            gateway.decide(self.dir, got["data"]["id"], got["data"]["token"], "approve")
        ok = gateway.request_approval(self.policy, "rm-path", ["/x"], "Delete x", notify=notify, approval_dir=self.dir, sleep=sleeper)
        self.assertTrue(ok)
        self.assertEqual(got["body"], "Delete x")

    def test_timeout_denies_and_closes_the_request(self):
        got, notify = self.cap_notify()
        t = [0]
        ok = gateway.request_approval(self.policy, "rm-path", ["/x"], "s", notify=notify, approval_dir=self.dir,
                                      sleep=lambda _: t.__setitem__(0, t[0] + 1), now=lambda: t[0])
        self.assertFalse(ok)
        self.assertEqual(gateway.read_decision(self.dir, got["data"]["id"]), "deny")
        self.assertNotEqual(gateway.decide(self.dir, got["data"]["id"], got["data"]["token"], "approve")[0], 200)

    def test_no_phone_to_notify_is_a_refusal(self):
        t = [0]
        with self.assertRaises(gateway.Refused):
            gateway.request_approval(self.policy, "rm-path", ["/x"], "s", notify=lambda **kw: False, approval_dir=self.dir,
                                     sleep=lambda _: t.__setitem__(0, t[0] + 1), now=lambda: t[0])

    # --- resending a lost notification
    def test_resend_pushes_the_same_request_again_within_limits(self):
        sent = []
        t = [0]
        def notify(**kw):
            sent.append(kw["data"]); return True
        def sleeper(_):
            t[0] += 1
            # Ask on every tick: only one push per gap gets through, and never more than the cap.
            gateway.request_resend(self.dir, now=t[0])
        policy = dict(self.policy, approval=dict(self.policy["approval"], timeout_seconds=500))
        ok = gateway.request_approval(policy, "rm-path", ["/x"], "s", notify=notify, approval_dir=self.dir, sleep=sleeper, now=lambda: t[0])
        self.assertFalse(ok)
        self.assertEqual(len(sent), 1 + gateway.MAX_RESENDS)
        self.assertTrue(all(d == sent[0] for d in sent))  # same id and token every time

    def test_resend_only_flags_open_requests(self):
        open_id, _ = gateway.create_approval(self.dir, "rm-path", ["/x"], "s", 60, now=1000)
        done_id, tok = gateway.create_approval(self.dir, "rm-path", ["/y"], "s", 60, now=1000)
        gateway.decide(self.dir, done_id, tok, "deny", now=1001)
        old_id, _ = gateway.create_approval(self.dir, "rm-path", ["/z"], "s", 5, now=1000)
        self.assertEqual(gateway.request_resend(self.dir, now=1010), 1)
        self.assertTrue(os.path.exists(os.path.join(self.dir, open_id + ".resend")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, done_id + ".resend")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, old_id + ".resend")))

    # --- rm-path rules
    def test_rm_path_rules(self):
        h = self.home
        ok = os.path.join(h, "talkoot/data/cache")
        real, summary = gateway.check_rm_path(self.policy, ok)
        self.assertEqual(real, ok); self.assertIn("1 files", summary); self.assertIn("talkoot", summary)
        for bad in [os.path.join(h, "immich/library"), os.path.join(h, "talkoot"), h, "/etc/passwd", "relative/p",
                    os.path.join(h, "talkoot/.git"), os.path.join(h, "talkoot/data/../data/cache"),
                    os.path.join(h, "talkoot/data/keep"), os.path.join(h, "nope"), os.path.join(h, "talkoot/data/missing")]:
            with self.assertRaises(gateway.Refused, msg=bad):
                gateway.check_rm_path(self.policy, bad)

    def test_rm_path_refuses_symlink_escape(self):
        link = os.path.join(self.home, "talkoot/data/escape")
        os.symlink(os.path.join(self.home, "immich/library"), link)
        for p in [link, link + "/x"]:
            with self.assertRaises(gateway.Refused):
                gateway.check_rm_path(self.policy, p)

    def test_rm_path_does_not_run_without_approval(self):
        fake = Fake()
        target = os.path.join(self.home, "talkoot/data/cache")
        with mock.patch.object(gateway, "run", fake), mock.patch.object(gateway, "request_approval", return_value=False):
            rc, out = gateway.v_rm_path(self.policy, [target])
        self.assertEqual(rc, 3); self.assertEqual(fake.calls, []); self.assertTrue(os.path.exists(target))

    def test_rm_path_runs_fixed_command_after_approval(self):
        fake = Fake()
        target = os.path.join(self.home, "talkoot/data/cache")
        with mock.patch.object(gateway, "run", fake), mock.patch.object(gateway, "request_approval", return_value=True):
            rc, out = gateway.v_rm_path(self.policy, [target])
        self.assertEqual(fake.calls[0][0], ["rm", "-rf", "--one-file-system", "--", target])

    # --- remove-container rules
    def test_remove_container_rules(self):
        def runner(status, project):
            def f(cmd, cwd=None, timeout=1800):
                return 0, f"{status}|{project}|img:1\n" if cmd[1] == "inspect" else (0, "ok")
            return f
        for name, status, project in [("immich_server", "exited", "immich"), ("talkoot", "running", "talkoot"),
                                      ("foo", "exited", "unrelated"), ("renki-daemon", "exited", "renki")]:
            with mock.patch.object(gateway, "run", runner(status, project)), \
                 mock.patch.object(gateway, "request_approval", side_effect=AssertionError("must not ask")):
                with self.assertRaises(gateway.Refused, msg=name):
                    gateway.v_remove_container(self.policy, [name])
        calls = []
        def rec(cmd, cwd=None, timeout=1800):
            calls.append(cmd)
            return (0, "exited|talkoot|img:1\n") if cmd[1] == "inspect" else (0, "ok")
        with mock.patch.object(gateway, "run", rec), mock.patch.object(gateway, "request_approval", return_value=True):
            gateway.v_remove_container(self.policy, ["talkoot-old"])
        self.assertEqual(calls[-1], ["docker", "rm", "talkoot-old"])  # no -v: volumes are kept

    # --- create-repo
    def _gh(self, exists=False, signed_in=True):
        calls = []

        def run(cmd, cwd=None, timeout=1800, env=None):
            calls.append((cmd, env))
            if cmd[:2] == ["gh", "api"]:
                if not signed_in:
                    return 1, "gh: authentication required"
                return (0, "") if exists else (1, "gh: Not Found (HTTP 404)")
            return 0, "https://github.com/Zawaer/x\n"

        return calls, run

    def test_create_repo_rejects_bad_names_and_unset_config(self):
        for bad in ["", "../x", "a b", "-rf", "--public", ".git", "x.git", "a/b", "x;y", "a" * 101]:
            with mock.patch.object(gateway, "run", self._gh()[1]), \
                 mock.patch.object(gateway, "request_approval", side_effect=AssertionError("must not ask")):
                with self.assertRaises(gateway.Refused, msg=bad):
                    gateway.v_create_repo(self.policy, [bad] if bad else [])
        policy = json.loads(json.dumps(self.policy)); policy.pop("github", None)
        with self.assertRaises(gateway.Refused):
            gateway.v_create_repo(policy, ["fine-name"])

    def test_create_repo_refuses_an_existing_repo_and_a_broken_login(self):
        for exists, signed_in in [(True, True), (False, False)]:
            calls, run_ = self._gh(exists=exists, signed_in=signed_in)
            with mock.patch.object(gateway, "run", run_), \
                 mock.patch.object(gateway, "request_approval", side_effect=AssertionError("must not ask")):
                with self.assertRaises(gateway.Refused):
                    gateway.v_create_repo(self.policy, ["taken"])
            self.assertTrue(all(c[0][:2] == ["gh", "api"] for c in calls))  # nothing was created

    def test_create_repo_does_nothing_without_approval(self):
        calls, run_ = self._gh()
        with mock.patch.object(gateway, "run", run_), mock.patch.object(gateway, "request_approval", return_value=False):
            rc, out = gateway.v_create_repo(self.policy, ["new-thing"])
        self.assertEqual(rc, 3)
        self.assertFalse(any(c[0][:3] == ["gh", "repo", "create"] for c in calls))

    def test_create_repo_private_by_default_with_the_gateways_own_login(self):
        calls, run_ = self._gh()
        asked = {}
        def approve(policy, verb, args, summary, **kw):
            asked["summary"] = summary; return True
        with mock.patch.object(gateway, "run", run_), mock.patch.object(gateway, "request_approval", side_effect=approve):
            rc, out = gateway.v_create_repo(self.policy, ["new-thing"])
        self.assertEqual(rc, 0)
        create = [c for c in calls if c[0][:3] == ["gh", "repo", "create"]][0]
        self.assertEqual(create[0], ["gh", "repo", "create", "Zawaer/new-thing", "--private"])
        self.assertEqual(create[1]["GH_CONFIG_DIR"], "/var/lib/homelab-gateway/gh")
        self.assertIn("private GitHub repo Zawaer/new-thing", asked["summary"])
        self.assertNotIn("PUBLIC", asked["summary"])

    def test_create_repo_public_is_loud_in_what_the_user_is_asked(self):
        calls, run_ = self._gh()
        asked = {}
        def approve(policy, verb, args, summary, **kw):
            asked["summary"] = summary; return True
        with mock.patch.object(gateway, "run", run_), mock.patch.object(gateway, "request_approval", side_effect=approve):
            gateway.v_create_repo(self.policy, ["--public", "open-thing"])
        self.assertIn("PUBLIC", asked["summary"])
        self.assertIn("Anyone on the internet", asked["summary"])
        self.assertEqual([c for c in calls if c[0][:3] == ["gh", "repo", "create"]][0][0][-1], "--public")

    def test_http_service_end_to_end(self):
        import threading, urllib.request, urllib.error
        aid, token = gateway.create_approval(self.dir, "rm-path", ["/x"], "Delete x", 60)
        handler = type("H", (gateway.ApprovalHandler,), {"approval_dir": self.dir})
        srv = gateway.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}/v1/approvals/{aid}"
        try:
            listed = json.load(urllib.request.urlopen(base.rsplit("/", 1)[0] + "/pending"))["pending"]
            self.assertEqual([p["summary"] for p in listed], ["Delete x"])
            req = urllib.request.Request(base, headers={"x-approval-token": token})
            self.assertEqual(json.load(urllib.request.urlopen(req))["summary"], "Delete x")
            bad = urllib.request.Request(base, data=json.dumps({"token": "no", "decision": "approve"}).encode(), method="POST")
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(bad)
            self.assertEqual(cm.exception.code, 403)
            good = urllib.request.Request(base, data=json.dumps({"token": token, "decision": "approve"}).encode(), method="POST")
            self.assertTrue(json.load(urllib.request.urlopen(good))["ok"])
            self.assertEqual(gateway.read_decision(self.dir, aid), "approve")
        finally:
            srv.shutdown()


class AddAppAndRouteTest(unittest.TestCase):
    """add-app / add-route: widen the policy by one named thing, only after the phone says yes."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.policy = json.loads(json.dumps(POLICY))
        self.policy["run_as_home"] = self.home
        self.policy["protected_paths"] = [os.path.join(self.home, ".ssh")]
        self.added = os.path.join(tempfile.mkdtemp(), "added-apps.json")
        os.makedirs(os.path.join(self.home, "life-api"))
        open(os.path.join(self.home, "life-api", "docker-compose.yml"), "w").close()
        self.config = {"services": {"api": {"volumes": [{"type": "bind", "source": os.path.join(self.home, "life-api", "data")},
                                                        {"type": "volume", "source": "pg"}]},
                                    "db": {"volumes": [{"type": "volume", "source": "pg"}]}}}

    def fake_run(self, config=None, inspect="life-api|homelab_net "):
        calls = []
        def run(cmd, cwd=None, timeout=1800, env=None):
            calls.append((cmd, cwd))
            if cmd[:3] == ["docker", "compose", "config"]:
                return 0, json.dumps(config or self.config)
            if cmd[:2] == ["docker", "inspect"]:
                return (0, inspect) if inspect else (1, "no such object")
            return 0, ""
        return calls, run

    def add(self, args, approve=True, config=None):
        calls, run = self.fake_run(config)
        with mock.patch.object(gateway, "run", run), \
             mock.patch.object(gateway, "request_approval", return_value=approve) as ask:
            rc, out = gateway.v_add_app(self.policy, args, added_path=self.added)
        return rc, out, ask, calls

    def test_add_app_records_a_plain_deploy_app_after_approval(self):
        rc, out, ask, _ = self.add(["life-api"])
        self.assertEqual(rc, 0, out)
        self.assertIn("db, api", ask.call_args[0][3].replace("api, db", "db, api"))
        policy = json.loads(json.dumps(POLICY)); policy["run_as_home"] = self.home
        gateway.merge_added_apps(policy, gateway.read_added_apps(self.added))
        self.assertEqual(policy["apps"]["life-api"], {"mode": "deploy", "dir": "life-api", "git": False,
                                                      "services": ["api", "db"], "added": True, "binds": []})

    def test_add_app_writes_nothing_without_approval(self):
        rc, out, _, _ = self.add(["life-api"], approve=False)
        self.assertEqual(rc, 3); self.assertFalse(os.path.exists(self.added))

    def test_add_app_refuses_compose_files_that_reach_outside_their_folder(self):
        for svc in [{"privileged": True}, {"network_mode": "host"}, {"pid": "host"}, {"cap_add": ["SYS_ADMIN"]},
                    {"devices": ["/dev/sda"]}, {"container_name": "caddy"},
                    {"volumes": [{"type": "bind", "source": "/var/run/docker.sock"}]},
                    {"volumes": [{"type": "bind", "source": "/"}]},
                    {"volumes": [{"type": "bind", "source": self.home}]},
                    {"volumes": [{"type": "bind", "source": os.path.join(self.home, ".ssh")}]},
                    {"volumes": [{"type": "bind", "source": os.path.join(self.home, "renki", "data")}]},
                    {"volumes": [{"type": "bind", "source": "/var/lib/docker/volumes"}]},
                    {"volumes": [{"type": "bind", "source": "/etc/localtime"}]}]:  # not read-only
            with self.assertRaises(gateway.Refused, msg=str(svc)):
                self.add(["life-api"], config={"services": {"api": svc}})
        self.assertFalse(os.path.exists(self.added))

    def test_add_app_asks_for_folders_outside_its_own_and_remembers_them(self):
        vault = os.path.join(self.home, "obsidian", "vault")
        os.makedirs(vault)
        self.policy["protected_paths"].append(os.path.join(self.home, "obsidian"))
        cfg = {"services": {"api": {"volumes": [{"type": "bind", "source": vault},
                                                {"type": "bind", "source": os.path.join(self.home, "archive"), "read_only": True}]}}}
        rc, out, ask, _ = self.add(["life-api"], config=cfg)
        self.assertEqual(rc, 0, out)
        summary = ask.call_args[0][3]
        self.assertIn("~/obsidian/vault (can change files, on your protected list)", summary)
        self.assertIn("~/archive (read only)", summary)
        self.assertEqual(gateway.read_added_apps(self.added)["life-api"]["binds"],
                         [{"source": os.path.realpath(os.path.join(self.home, "archive")), "rw": False},
                          {"source": os.path.realpath(vault), "rw": True}])

    def test_deploy_asks_once_for_new_folders_then_just_deploys(self):
        gateway.write_added_app(self.added, "life-api", {"dir": "life-api", "git": False, "services": ["api"]})
        self.policy["apps"]["life-api"] = {"mode": "deploy", "dir": "life-api", "git": False, "services": ["api"], "added": True, "binds": []}
        archive = os.path.realpath(os.path.join(self.home, "archive"))
        cfg = {"services": {"api": {"volumes": [{"type": "bind", "source": archive, "read_only": True}]}}}
        calls, run = self.fake_run(config=cfg)
        with mock.patch.object(gateway, "run", run), mock.patch.object(gateway, "ADDED_APPS_PATH", self.added), \
             mock.patch.object(gateway, "request_approval", return_value=False) as ask:
            rc, out = gateway.do_deploy(self.policy, "life-api")
        self.assertEqual(rc, 3)
        self.assertFalse(any(c[0][:3] == ["docker", "compose", "up"] for c in calls))
        with mock.patch.object(gateway, "run", run), mock.patch.object(gateway, "ADDED_APPS_PATH", self.added), \
             mock.patch.object(gateway, "request_approval", return_value=True):
            rc, out = gateway.do_deploy(self.policy, "life-api")
        self.assertEqual(rc, 0, out)
        self.assertTrue(any(c[0][:3] == ["docker", "compose", "up"] for c in calls))
        # Remembered: the next load of the policy has it, and the deploy after that doesn't ask.
        policy = json.loads(json.dumps(POLICY)); policy["run_as_home"] = self.home
        gateway.merge_added_apps(policy, gateway.read_added_apps(self.added))
        self.assertEqual(policy["apps"]["life-api"]["binds"], [{"source": archive, "rw": False}])
        with mock.patch.object(gateway, "run", run), \
             mock.patch.object(gateway, "request_approval", side_effect=AssertionError("must not ask")):
            rc, out = gateway.do_deploy(policy, "life-api")
        self.assertEqual(rc, 0, out)
        # Read-only approval doesn't cover a switch to read-write.
        cfg["services"]["api"]["volumes"][0]["read_only"] = False
        with mock.patch.object(gateway, "run", run), mock.patch.object(gateway, "request_approval", return_value=False) as ask:
            rc, _ = gateway.do_deploy(policy, "life-api")
        self.assertEqual(rc, 3)

    def test_older_apps_get_the_same_check_and_remember_approvals(self):
        # talkoot is in the base policy (not added): a compose change of its own is checked too.
        self.policy["apps"]["talkoot"]["git"] = False
        bad = {"services": {"talkoot": {"volumes": [{"type": "bind", "source": "/var/run/docker.sock"}]}}}
        calls, run = self.fake_run(config=bad)
        with mock.patch.object(gateway, "run", run):
            rc, out = gateway.do_deploy(self.policy, "talkoot")
        self.assertEqual(rc, 2); self.assertIn("Docker socket", out)
        self.assertFalse(any(c[0][:3] == ["docker", "compose", "up"] for c in calls))
        archive = os.path.realpath(os.path.join(self.home, "archive"))
        ok = {"services": {"talkoot": {"volumes": [{"type": "bind", "source": archive, "read_only": True}]}}}
        calls, run = self.fake_run(config=ok)
        with mock.patch.object(gateway, "run", run), mock.patch.object(gateway, "ADDED_APPS_PATH", self.added), \
             mock.patch.object(gateway, "request_approval", return_value=True):
            rc, out = gateway.do_deploy(self.policy, "talkoot")
        self.assertEqual(rc, 0, out)
        policy = json.loads(json.dumps(POLICY)); policy["run_as_home"] = self.home
        gateway.merge_added_apps(policy, gateway.read_added_apps(self.added))
        self.assertEqual(policy["apps"]["talkoot"]["binds"], [{"source": archive, "rw": False}])
        self.assertNotIn("_binds", policy["apps"])

    def test_merge_drops_binds_that_may_never_be_allowed(self):
        policy = json.loads(json.dumps(self.policy))
        gateway.merge_added_apps(policy, {"x": {"dir": "x", "services": ["a"], "binds": [
            {"source": "/", "rw": True}, {"source": "/etc", "rw": False}, {"source": self.home + "/.ssh", "rw": False},
            {"source": "/var/run/docker.sock", "rw": True}, {"source": self.home + "/../etc", "rw": False},
            {"source": os.path.realpath(self.home) + "/archive", "rw": False}]}})
        self.assertEqual(policy["apps"]["x"]["binds"], [{"source": os.path.realpath(self.home) + "/archive", "rw": False}])

    def test_add_app_refuses_bad_names_existing_apps_and_odd_folders(self):
        for args in [[], ["-x"], ["../x"], ["talkoot"], ["new", "--dir", "../etc"], ["new", "--dir", ".ssh"],
                     ["new", "--dir", "talkoot"], ["new", "--dir", "a/b"], ["new", "--dir", "missing"],
                     ["life-api", "--services", "nope"], ["life-api", "--bogus", "x"], ["life-api", "--repo", "a/b"],
                     ["life-api", "--repo", "life-api"]]:  # exists already, so no clone over it
            with self.assertRaises(gateway.Refused, msg=str(args)):
                self.add(args)

    def test_add_app_clones_from_the_policy_owner_only(self):
        def run(cmd, cwd=None, timeout=1800, env=None):
            if cmd[:2] == ["git", "clone"]:
                os.makedirs(cmd[-1]); open(os.path.join(cmd[-1], "compose.yaml"), "w").close()
                os.makedirs(os.path.join(cmd[-1], ".git"))
                return 0, ""
            return 0, json.dumps({"services": {"web": {}}})
        with mock.patch.object(gateway, "run", run), mock.patch.object(gateway, "request_approval", return_value=True):
            rc, out = gateway.v_add_app(self.policy, ["notes", "--repo", "notes-app"], added_path=self.added)
        self.assertEqual(rc, 0, out)
        self.assertIn("https://github.com/Zawaer/notes-app.git", out)
        self.assertTrue(gateway.read_added_apps(self.added)["notes"]["git"])

    def test_merge_skips_entries_that_clash_or_point_somewhere_protected(self):
        policy = json.loads(json.dumps(self.policy))
        gateway.merge_added_apps(policy, {
            "talkoot": {"dir": "elsewhere", "services": ["x"]},          # base policy wins
            "sneaky": {"dir": ".ssh", "services": ["x"]},                # protected
            "inside": {"dir": "talkoot", "services": ["x"]},             # another app's folder
            "bad": {"dir": "../etc", "services": ["x"]},
            "ok": {"dir": "ok", "services": ["web"], "mode": "detached"},  # mode is ignored
        })
        self.assertEqual(policy["apps"]["talkoot"], POLICY["apps"]["talkoot"])
        for n in ("sneaky", "inside", "bad"):
            self.assertNotIn(n, policy["apps"])
        self.assertEqual(policy["apps"]["ok"]["mode"], "deploy")

    def test_deploy_of_an_added_app_rechecks_its_compose_file(self):
        self.policy["apps"]["life-api"] = {"mode": "deploy", "dir": "life-api", "git": True, "services": ["api"], "added": True}
        calls, run = self.fake_run(config={"services": {"api": {"privileged": True}}})
        with mock.patch.object(gateway, "run", run):
            rc, out = gateway.do_deploy(self.policy, "life-api")
        self.assertEqual(rc, 2); self.assertIn("privileged", out)
        self.assertFalse(any(c[0][:3] == ["docker", "compose", "up"] for c in calls))

    # --- add-route

    def route(self, args, inspect="life-api|homelab_net ", approve=True, validate_rc=0):
        os.makedirs(os.path.join(self.home, "caddy"), exist_ok=True)
        cf = os.path.join(self.home, "caddy", "Caddyfile")
        if not os.path.exists(cf):
            open(cf, "w").write("(common) {\n}\n\nmatka.internal {\n\treverse_proxy matka:3000\n}\n")
        self.policy["apps"]["life-api"] = {"mode": "deploy", "dir": "life-api", "services": ["api"]}
        calls = []
        def run(cmd, cwd=None, timeout=1800, env=None):
            calls.append(cmd)
            if cmd[:2] == ["docker", "inspect"]:
                return (0, inspect) if inspect else (1, "")
            if "validate" in cmd:
                return validate_rc, "" if validate_rc == 0 else "bad"
            return 0, ""
        with mock.patch.object(gateway, "run", run), mock.patch.object(gateway, "request_approval", return_value=approve):
            rc, out = gateway.v_add_route(self.policy, args)
        return rc, out, open(cf).read(), calls

    def test_add_route_appends_a_block_and_reloads(self):
        rc, out, text, calls = self.route(["life", "life-api:8000"])
        self.assertEqual(rc, 0, out)
        self.assertIn("life.internal {\n\treverse_proxy life-api:8000\n\timport common\n}", text)
        self.assertIn("reload", calls[-1])

    def test_add_route_puts_the_caddyfile_back_when_it_does_not_validate(self):
        rc, out, text, calls = self.route(["life.internal", "life-api:8000"], validate_rc=1)
        self.assertNotEqual(rc, 0); self.assertNotIn("life.internal", text)
        self.assertFalse(any("reload" in c for c in calls))

    def test_add_route_refuses(self):
        for args, inspect in [(["matka", "life-api:8000"], None),            # name taken
                              (["life", "immich_server:2283"], None),        # protected
                              (["life", "life-api:0"], None), (["life", "life-api"], None),
                              (["Life", "life-api:80"], None), (["a.b", "life-api:80"], None),
                              (["life", "life-api:80"], ""),                  # no such container
                              (["life", "life-api:80"], "immich|homelab_net "),  # not a deployable app
                              (["life", "life-api:80"], "life-api|life-api_default ")]:  # caddy can't reach it
            with self.assertRaises(gateway.Refused, msg=str(args)):
                self.route(args, inspect=inspect if inspect is not None else "life-api|homelab_net ")

    def test_add_route_without_approval_changes_nothing(self):
        rc, out, text, _ = self.route(["life", "life-api:8000"], approve=False)
        self.assertEqual(rc, 3); self.assertNotIn("life.internal", text)


class PendingListTest(unittest.TestCase):
    def test_lists_open_requests_without_tokens(self):
        d = tempfile.mkdtemp()
        a, tok = gateway.create_approval(d, "add-app", ["x"], "Add x", 300, now=1000)
        b, _ = gateway.create_approval(d, "add-route", ["y"], "Route y", 300, now=1001)
        c, _ = gateway.create_approval(d, "rm-path", ["/z"], "Delete z", 10, now=900)  # expired
        gateway.write_decision(d, b, "approve")  # decided
        pending = gateway.list_pending(d, now=1100)
        self.assertEqual([p["id"] for p in pending], [a])
        self.assertEqual(pending[0]["summary"], "Add x")
        self.assertNotIn(tok, json.dumps(pending))
        self.assertNotIn("token_sha256", json.dumps(pending))


class HostCommandTest(unittest.TestCase):
    """sh, sudo and the time window."""

    def setUp(self):
        self.dir = os.path.realpath(tempfile.mkdtemp())
        self.window = os.path.join(self.dir, "window.json")
        self.policy = json.loads(json.dumps(POLICY))
        self.policy["approval"] = {"timeout_seconds": 3, "url": "https://x", "push_db": ""}

    def approver(self, answer):
        asked = []
        def approve(policy, verb, args, summary, **kw):
            asked.append((verb, args, summary, kw)); return answer
        return asked, approve

    def test_sh_asks_with_the_exact_command_then_runs_it(self):
        asked, approve = self.approver(True)
        fake = Fake()
        with mock.patch.object(gateway, "run", fake):
            rc, out = gateway.v_sh(self.policy, 'grep "a b" f && mv ~/x ~/y', window_path=self.window, approve=approve)
        self.assertEqual(rc, 0)
        self.assertIn('grep "a b" f && mv ~/x ~/y', asked[0][2])
        self.assertEqual(fake.calls, [(["bash", "-lc", 'grep "a b" f && mv ~/x ~/y'], "/home/zawaer")])

    def test_sh_denied_runs_nothing(self):
        _, approve = self.approver(False)
        fake = Fake()
        with mock.patch.object(gateway, "run", fake):
            rc, out = gateway.v_sh(self.policy, "ls", window_path=self.window, approve=approve)
        self.assertEqual(rc, 3); self.assertEqual(fake.calls, [])

    def test_sh_in_an_open_window_runs_without_asking_until_it_closes(self):
        gateway.open_window(30, self.window)
        asked, approve = self.approver(False)
        fake = Fake()
        with mock.patch.object(gateway, "run", fake):
            rc, out = gateway.v_sh(self.policy, "ls", window_path=self.window, approve=approve)
            self.assertEqual((rc, asked), (0, []))
            self.assertIn("time window", out)
            gateway.close_window(self.window)
            gateway.v_sh(self.policy, "ls", window_path=self.window, approve=approve)
        self.assertEqual(len(asked), 1)

    def test_window_expires(self):
        gateway.open_window(1, self.window, now=1000)
        self.assertIsNotNone(gateway.window_until(self.window, now=1030))
        self.assertIsNone(gateway.window_until(self.window, now=1061))

    def test_open_window_needs_approval_and_a_sane_length(self):
        asked, approve = self.approver(True)
        rc, _ = gateway.v_open_window(self.policy, ["20"], window_path=self.window, approve=approve)
        self.assertEqual(rc, 0)
        self.assertIn("20 minutes", asked[0][2]); self.assertIn("Any chat", asked[0][2])
        self.assertIsNotNone(gateway.window_until(self.window))
        for bad in (["0"], ["31"], ["60"], ["999"], ["x"], ["1", "2"]):
            with self.assertRaises(gateway.Refused):
                gateway.v_open_window(self.policy, bad, window_path=self.window, approve=approve)
        _, deny = self.approver(False)
        gateway.close_window(self.window)
        self.assertEqual(gateway.v_open_window(self.policy, [], window_path=self.window, approve=deny)[0], 3)
        self.assertIsNone(gateway.window_until(self.window))

    def test_sudo_asks_for_a_password_even_in_a_window_and_feeds_it_to_sudo(self):
        gateway.open_window(30, self.window)
        asked, approve = self.approver("hunter2")
        with mock.patch.object(gateway.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=0, stdout="done\n", stderr="")
            rc, out = gateway.v_sudo(self.policy, "systemctl restart x", approve=approve)
        self.assertEqual(rc, 0)
        self.assertTrue(asked[0][3].get("password"))
        self.assertIn("ROOT", asked[0][2])
        args, kw = run.call_args
        self.assertEqual(args[0], ["sudo", "-k", "-S", "-p", "", "--", "bash", "-lc", "systemctl restart x"])
        self.assertEqual(kw["input"], "hunter2\n")
        self.assertNotIn("hunter2", out)

    def test_sudo_with_a_wrong_password_says_so(self):
        _, approve = self.approver("nope")
        with mock.patch.object(gateway.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=1, stdout="", stderr="Sorry, try again.\nsudo: 1 incorrect password attempt\n")
            rc, out = gateway.v_sudo(self.policy, "id", approve=approve)
        self.assertEqual(rc, 1); self.assertIn("didn't accept the password", out)

    def test_handle_passes_sh_through_unsplit(self):
        with mock.patch.object(gateway, "v_sh", return_value=(0, "ok")) as v, \
             mock.patch.object(gateway, "AUDIT_LOG", os.path.join(self.dir, "audit.log")):
            gateway.RAW_VERBS["sh"] = v
            try:
                gateway.handle('sh echo "a  b" | wc -c', self.policy, disabled_path=os.path.join(self.dir, "D"))
            finally:
                gateway.RAW_VERBS["sh"] = gateway.v_sh
        self.assertEqual(v.call_args[0][1], 'echo "a  b" | wc -c')

    def test_kill_switch_stops_sh(self):
        dis = os.path.join(self.dir, "DISABLED"); open(dis, "w").close()
        fake = Fake()
        with mock.patch.object(gateway, "run", fake), mock.patch.object(gateway, "AUDIT_LOG", os.path.join(self.dir, "a.log")):
            rc, out = gateway.handle("sh ls", self.policy, disabled_path=dis)
        self.assertEqual(rc, 2); self.assertEqual(fake.calls, [])

    def test_empty_or_huge_commands_are_refused(self):
        for raw in ("", "   ", "x" * 5000):
            with self.assertRaises(gateway.Refused):
                gateway.check_command(raw)

    # --- the password's way from the phone to sudo
    def test_password_travels_sealed_and_is_deleted_after_use(self):
        got = {}
        def notify(**kw):
            got.update(kw); return True
        def sleeper(_):
            if gateway.read_decision(self.dir, got["data"]["id"]) is None:
                pad = bytes.fromhex(got["data"]["pad"])
                sealed = gateway.seal_password("pä55 word", pad)
                code, _ = gateway.decide(self.dir, got["data"]["id"], got["data"]["token"], "approve", secret=sealed)
                self.assertEqual(code, 200)
                self.assertNotIn("pä55", open(os.path.join(self.dir, got["data"]["id"] + ".secret")).read())
        pw = gateway.request_approval(self.policy, "sudo", ["id"], "s", notify=notify, approval_dir=self.dir, sleep=sleeper, password=True)
        self.assertEqual(pw, "pä55 word")
        self.assertFalse(os.path.exists(os.path.join(self.dir, got["data"]["id"] + ".secret")))
        self.assertNotIn(got["data"]["pad"], open(os.path.join(self.dir, got["data"]["id"] + ".json")).read())

    def test_password_request_cannot_be_approved_without_one(self):
        aid, token = gateway.create_approval(self.dir, "sudo", ["id"], "s", 60, password=True)
        self.assertEqual(gateway.decide(self.dir, aid, token, "approve")[0], 400)
        self.assertEqual(gateway.decide(self.dir, aid, token, "approve", secret="zz")[0], 400)
        self.assertIsNone(gateway.read_decision(self.dir, aid))
        self.assertEqual(gateway.decide(self.dir, aid, token, "deny")[0], 200)  # denying needs none
        self.assertTrue(gateway.peek(self.dir, aid, token)[1]["password"])




class TouchIdTest(unittest.TestCase):
    """Approving on the Mac: a fake platform authenticator signs like Touch ID would."""

    def setUp(self):
        from cryptography.hazmat.primitives.asymmetric import ec
        self.dir = os.path.realpath(tempfile.mkdtemp())
        self.policy = json.loads(json.dumps(POLICY))
        self.policy["approval"] = {"timeout_seconds": 3, "url": "https://approvals.internal", "push_db": ""}
        self.web = gateway.WebApprovals(self.policy, approval_dir=self.dir, approvers_path=os.path.join(self.dir, "approvers.json"),
                                        enroll_path=os.path.join(self.dir, "enroll.json"))
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred = gateway.b64u(b"cred-1")

    def client_data(self, kind, challenge, origin="https://approvals.internal"):
        return json.dumps({"type": kind, "challenge": challenge, "origin": origin}).encode()

    def auth_data(self, flags=0x05, rpid="approvals.internal"):
        import hashlib
        return hashlib.sha256(rpid.encode()).digest() + bytes([flags]) + b"\x00\x00\x00\x01"

    def enroll(self, code="c0de"):
        import hashlib
        from cryptography.hazmat.primitives import serialization
        with open(self.web.enroll_path, "w") as f:
            json.dump({"name": "mac", "code_sha256": hashlib.sha256(code.encode()).hexdigest(), "expires": 9e12}, f)
        o = self.web.enroll_options({"code": code})
        spki = self.key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        return self.web.enroll_finish({"code": code, "id": self.cred, "clientDataJSON": gateway.b64u(self.client_data("webauthn.create", o["challenge"])),
                                       "authenticatorData": gateway.b64u(self.auth_data()), "publicKey": gateway.b64u(spki)})

    def assertion(self, view, cd=None, auth=None, key=None):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        import hashlib
        cd = cd or self.client_data("webauthn.get", view["challenge"])
        auth = auth or self.auth_data()
        sig = (key or self.key).sign(auth + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        return {"decision": "approve", "id": self.cred, "clientDataJSON": gateway.b64u(cd),
                "authenticatorData": gateway.b64u(auth), "signature": gateway.b64u(sig)}

    def test_enroll_needs_the_link_and_works_once(self):
        with self.assertRaises(gateway.Refused):
            self.web.enroll_options({"code": "nope"})
        self.assertEqual(self.enroll()["name"], "mac")
        self.assertEqual(len(gateway.read_approvers(self.web.approvers_path)), 1)
        with self.assertRaises(gateway.Refused):
            self.web.enroll_options({"code": "c0de"})  # used up

    def test_touch_id_approves_and_nothing_else_does(self):
        from cryptography.hazmat.primitives.asymmetric import ec
        self.enroll()
        aid, _ = gateway.create_approval(self.dir, "sh", ["ls"], "Run ls", 60)
        v = self.web.view(aid)
        self.assertEqual(v["state"], "pending"); self.assertEqual(v["devices"], [self.cred])
        # another key (a chat making up a passkey), the wrong site, no Touch ID, a passkey for another site
        cases = [
            lambda v: self.assertion(v, key=ec.generate_private_key(ec.SECP256R1())),
            lambda v: self.assertion(v, cd=self.client_data("webauthn.get", v["challenge"], origin="https://renki.internal")),
            lambda v: self.assertion(v, auth=self.auth_data(flags=0x01)),
            lambda v: self.assertion(v, auth=self.auth_data(rpid="evil.internal")),
            lambda v: self.assertion(v, cd=self.client_data("webauthn.get", "made-up-challenge")),
        ]
        for make in cases:
            with self.assertRaises(gateway.Refused):
                self.web.answer(aid, make(self.web.view(aid)))
        self.assertIsNone(gateway.read_decision(self.dir, aid))
        v = self.web.view(aid)
        good = self.assertion(v)
        self.assertEqual(self.web.answer(aid, good)["decision"], "approve")
        self.assertEqual(gateway.read_decision(self.dir, aid), "approve")
        with self.assertRaises(gateway.Refused):
            self.web.answer(aid, good)  # the challenge is single-use

    def test_unenrolled_device_cannot_approve_but_anyone_can_deny(self):
        aid, _ = gateway.create_approval(self.dir, "sh", ["ls"], "Run ls", 60)
        v = self.web.view(aid)
        with self.assertRaises(gateway.Refused):
            self.web.answer(aid, self.assertion(v))
        self.assertEqual(self.web.answer(aid, {"decision": "deny"})["decision"], "deny")

    def test_sudo_password_from_the_mac_reaches_the_gateway_encrypted(self):
        import base64
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        self.enroll()
        got = {}
        def notify(**kw):
            got.update(kw); return True
        def sleeper(_):
            aid = got["data"]["id"]
            if gateway.read_decision(self.dir, aid) is not None:
                return
            v = self.web.view(aid)
            pub = serialization.load_der_public_key(base64.b64decode(v["pubkey"]))
            enc = base64.b64encode(pub.encrypt("s3cret pw".encode(), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))).decode()
            self.web.answer(aid, {**self.assertion(v), "password": enc})
            self.assertNotIn("s3cret", open(os.path.join(self.dir, aid + ".secret")).read())
        pw = gateway.request_approval(self.policy, "sudo", ["id"], "s", notify=notify, approval_dir=self.dir, sleep=sleeper,
                                      password=True, desktop=lambda: False)
        self.assertEqual(pw, "s3cret pw")

    def test_phone_push_waits_while_at_the_mac_and_never_comes_if_approved_there(self):
        self.enroll()
        sent, t = [], [0]
        def notify(**kw):
            sent.append(t[0]); return True
        def sleeper(_):
            t[0] += 1
            if t[0] == 10:  # approved on the Mac within the grace
                aid = [n[:-5] for n in os.listdir(self.dir) if n.endswith(".json") and gateway.ID_RE.match(n[:-5])][0]
                gateway.write_decision(self.dir, aid, "approve")
        policy = dict(self.policy, approval=dict(self.policy["approval"], timeout_seconds=60))
        ok = gateway.request_approval(policy, "sh", ["ls"], "s", notify=notify, approval_dir=self.dir, sleep=sleeper,
                                      now=lambda: t[0], desktop=lambda: True)
        self.assertTrue(ok); self.assertEqual(sent, [])

    def test_phone_push_goes_after_the_grace(self):
        sent, t = [], [0]
        def notify(**kw):
            sent.append(t[0]); return True
        policy = dict(self.policy, approval=dict(self.policy["approval"], timeout_seconds=60))
        gateway.request_approval(policy, "sh", ["ls"], "s", notify=notify, approval_dir=self.dir,
                                 sleep=lambda _: t.__setitem__(0, t[0] + 1), now=lambda: t[0], desktop=lambda: True)
        self.assertEqual(sent, [gateway.DESKTOP_GRACE_SECONDS])

    def test_desktop_presence_needs_a_fresh_report_and_an_approver(self):
        gateway.mark_desktop(self.dir, now=1000)
        self.assertFalse(gateway.desktop_present(self.dir, self.web.approvers_path, now=1005))  # nobody enrolled
        self.enroll()
        self.assertTrue(gateway.desktop_present(self.dir, self.web.approvers_path, now=1005))
        self.assertFalse(gateway.desktop_present(self.dir, self.web.approvers_path, now=1100))




class NativeMacTest(TouchIdTest):
    """The Renki Mac app: a Secure Enclave key, enrolled with the same root-made link."""

    def enroll_native(self, code="c0de"):
        import hashlib
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        with open(self.web.enroll_path, "w") as f:
            json.dump({"name": "mac", "code_sha256": hashlib.sha256(code.encode()).hexdigest(), "expires": 9e12}, f)
        o = self.web.enroll_options({"code": code})
        spki = self.key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        sig = self.key.sign(o["challenge"].encode(), ec.ECDSA(hashes.SHA256()))
        return self.web.enroll_native({"code": code, "challenge": o["challenge"], "publicKey": gateway.b64u(spki), "signature": gateway.b64u(sig)})

    def native(self, aid, view, key=None, challenge=None):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        c = challenge or view["challenge"]
        sig = (key or self.key).sign(gateway.native_message(aid, c), ec.ECDSA(hashes.SHA256()))
        return {"decision": "approve", "id": self.cred_id, "challenge": c, "signature": gateway.b64u(sig)}

    def test_native_key_approves_and_a_made_up_one_doesnt(self):
        from cryptography.hazmat.primitives.asymmetric import ec
        self.cred_id = self.enroll_native()["id"]
        aid, _ = gateway.create_approval(self.dir, "sh", ["ls"], "Run ls", 60)
        self.assertEqual(self.web.view(aid)["devices"], [])  # not offered to the browser page
        with self.assertRaises(gateway.Refused):
            self.web.answer(aid, self.native(aid, self.web.view(aid), key=ec.generate_private_key(ec.SECP256R1())))
        other, _ = gateway.create_approval(self.dir, "sh", ["rm"], "Run rm", 60)
        with self.assertRaises(gateway.Refused):  # a signature for another request
            v = self.web.view(other)
            self.web.answer(aid, self.native(other, v))
        self.assertIsNone(gateway.read_decision(self.dir, aid))
        self.assertEqual(self.web.answer(aid, self.native(aid, self.web.view(aid)))["decision"], "approve")

    def test_native_enroll_needs_proof_of_the_key(self):
        import hashlib
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        with open(self.web.enroll_path, "w") as f:
            json.dump({"name": "mac", "code_sha256": hashlib.sha256(b"c0de").hexdigest(), "expires": 9e12}, f)
        o = self.web.enroll_options({"code": "c0de"})
        spki = self.key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        from cryptography.hazmat.primitives import hashes
        bad = ec.generate_private_key(ec.SECP256R1()).sign(o["challenge"].encode(), ec.ECDSA(hashes.SHA256()))
        with self.assertRaises(gateway.Refused):
            self.web.enroll_native({"code": "c0de", "challenge": o["challenge"], "publicKey": gateway.b64u(spki), "signature": gateway.b64u(bad)})

    def test_pkcs1_is_offered_for_the_mac_app(self):
        key = gateway.new_password_key()
        self.assertTrue(gateway.pkcs1_of(gateway.public_key_b64(key)))


if __name__ == "__main__":
    unittest.main()
