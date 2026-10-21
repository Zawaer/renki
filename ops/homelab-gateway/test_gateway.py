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
        self.assertEqual(cmds[1], ["docker", "compose", "up", "-d", "--build", "talkoot", "scout"])
        self.assertEqual(fake.calls[1][1], "/home/zawaer/talkoot")

    def test_deploy_without_git_skips_pull(self):
        rc, out, fake, _ = self.go("deploy scout-tool")
        self.assertEqual([c[0][:2] for c in fake.calls], [["docker", "compose"]])

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


if __name__ == "__main__":
    unittest.main()
