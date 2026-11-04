import { describe, expect, it } from "vitest";
import { phoneShellReadOnly } from "../src/mac/phoneShell.js";
import { createMacApprovalHook } from "../src/mac/tools.js";

describe("phoneShellReadOnly", () => {
  it("lets plain reads through", () => {
    for (const c of [
      "dumpsys battery",
      "dumpsys batterystats --charged",
      "dumpsys batterystats --history",
      "dumpsys deviceidle",
      "getprop ro.product.model",
      "settings get global stay_on_while_plugged_in",
      "pm list packages -3",
      "pm path fi.zawaer.matka",
      "cmd package list packages",
      "cmd battery get level",
      "cat /proc/meminfo",
      "ls -la /sdcard/Download",
      "ps -A",
      "top -n 1",
      "wm size",
      "content query --uri content://settings/system",
      "am get-current-user",
      "ip addr show",
      "  dumpsys   battery  ",
    ])
      expect(phoneShellReadOnly(c), c).toBe(true);
  });

  it("asks for anything that changes the phone or uses shell syntax", () => {
    for (const c of [
      "",
      "dumpsys battery set level 5",
      "dumpsys battery unplug",
      "dumpsys battery reset",
      "dumpsys batterystats --reset",
      "dumpsys deviceidle force-idle",
      "dumpsys deviceidle whitelist +fi.x",
      "settings put global x 1",
      "pm clear fi.zawaer.matka",
      "pm uninstall fi.x",
      "cmd package install-existing x",
      "cmd battery set level 5",
      "am start -n x/.Main",
      "am stack remove 1",
      "wm size 1080x1920",
      "ip link set wlan0 down",
      "ifconfig wlan0 down",
      "date 010100002026",
      "rm -rf /sdcard/x",
      "input tap 1 1",
      "svc wifi disable",
      "reboot",
      "cat /sdcard/a; rm /sdcard/a",
      "cat /sdcard/a && reboot",
      "dumpsys battery | grep level",
      "cat $(echo /x)",
      "cat `id`",
      "echo x > /sdcard/a",
      "ls /sdcard/*",
      "cat '/sdcard/a' ",
      "dumpsys battery\nreboot",
      "content insert --uri x",
    ])
      expect(phoneShellReadOnly(c), JSON.stringify(c)).toBe(false);
  });
});

describe("phone_shell approval", () => {
  const run = (command: string) =>
    createMacApprovalHook().hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: "mcp__mac__phone_shell", tool_input: { command } } as never,
      undefined,
      { signal: new AbortController().signal },
    );

  it("allows a read without asking and asks for a change", async () => {
    expect(await run("dumpsys battery")).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect(await run("pm clear x")).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });
});
