import json, os, tempfile, unittest
from unittest import mock
import gateway

POLICY = json.load(open(os.path.join(os.path.dirname(__file__), "policy.json")))


class Fake:
    """Records every command the gateway would have run."""
    def __init__(self, containers=("talkoot", "immich_server")):
        self.calls, self.containers = [], containers

    def __call__(self, cmd, cwd=None, timeout=1800):
        self.calls.append((cmd, cwd))
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

    def test_tier2_not_enabled(self):
        for c in ["rm-path /home/zawaer/immich", "remove-container immich_server"]:
            rc, out, fake, _ = self.go(c)
            self.assertEqual(rc, 2); self.assertIn("approval", out); self.assertEqual(fake.calls, [])

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


if __name__ == "__main__":
    unittest.main()
