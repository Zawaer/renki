import { describe, expect, it, vi } from "vitest";
import {
  answerGatewayApproval,
  describeGatewayOutcome,
  describeGatewaySettled,
  describeMentions,
  formatTimeLeft,
  gatewaySummaryLine,
  parseGatewayApproval,
  peekGatewayApproval,
  sealPassword,
  settledToMention,
} from "../src/gatewayApproval";

const good = { kind: "gateway-approval", id: "0123456789", token: "t".repeat(43), url: "https://approvals.internal" };

describe("parseGatewayApproval", () => {
  it("accepts a well-formed approval and trims a trailing slash", () => {
    expect(parseGatewayApproval(good)).toEqual({ id: "0123456789", token: "t".repeat(43), url: "https://approvals.internal" });
    expect(parseGatewayApproval({ ...good, url: "https://approvals.internal/" })?.url).toBe("https://approvals.internal");
  });

  it("ignores anything that isn't a gateway approval", () => {
    for (const data of [null, undefined, "x", 3, {}, { sessionId: "s_1", requestId: "r" }, { ...good, kind: "other" }]) {
      expect(parseGatewayApproval(data)).toBeNull();
    }
  });

  it("rejects malformed ids, short tokens and non-https or path-bearing urls", () => {
    expect(parseGatewayApproval({ ...good, id: "../etc" })).toBeNull();
    expect(parseGatewayApproval({ ...good, id: "ABCDEF0123" })).toBeNull();
    expect(parseGatewayApproval({ ...good, token: "short" })).toBeNull();
    expect(parseGatewayApproval({ ...good, url: "http://approvals.internal" })).toBeNull();
    expect(parseGatewayApproval({ ...good, url: "https://evil.example/path?x=1" })).toBeNull();
    expect(parseGatewayApproval({ ...good, url: "" })).toBeNull();
  });
});

describe("answerGatewayApproval", () => {
  const approval = parseGatewayApproval(good)!;
  const reply = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

  it("posts the token and decision to the approval service", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await answerGatewayApproval(approval, "approve", spy)).toBe("done");
    expect(seen!.url).toBe("https://approvals.internal/v1/approvals/0123456789");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ token: "t".repeat(43), decision: "approve" });
  });

  it("maps the service's answers", async () => {
    expect(await answerGatewayApproval(approval, "deny", reply(409))).toBe("already_answered");
    expect(await answerGatewayApproval(approval, "deny", reply(410))).toBe("expired");
    expect(await answerGatewayApproval(approval, "deny", reply(403))).toBe("failed");
    expect(await answerGatewayApproval(approval, "deny", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe("failed");
  });

  it("words each outcome for the user", () => {
    expect(describeGatewayOutcome("done", "approve")).toBe("Approved");
    expect(describeGatewayOutcome("done", "deny")).toBe("Denied");
    expect(describeGatewayOutcome("expired", "approve")).toMatch(/expired/);
  });
});

describe("peekGatewayApproval", () => {
  const approval = parseGatewayApproval(good)!;
  const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads the gateway's own wording, state and deadline, sending the token as a header", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ summary: "Create a private GitHub repo Zawaer/x (empty).", state: "pending", expires: 1_800_000_300 }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await peekGatewayApproval(approval, spy)).toEqual({ summary: "Create a private GitHub repo Zawaer/x (empty).", state: "pending", expires: 1_800_000_300, password: false, by: null });
    expect(seen!.url).toBe("https://approvals.internal/v1/approvals/0123456789");
    expect((seen!.init.headers as Record<string, string>)["x-approval-token"]).toBe("t".repeat(43));
    expect(seen!.url).not.toContain("t".repeat(43)); // the token never goes in the URL
  });

  it("reports a request that was already decided or ran out", async () => {
    expect((await peekGatewayApproval(approval, json({ summary: "s", state: "approve", expires: 1 })))?.state).toBe("approve");
    expect((await peekGatewayApproval(approval, json({ summary: "s", state: "expired", expires: 1 })))?.state).toBe("expired");
    expect((await peekGatewayApproval(approval, json({ summary: "s", state: "approve", expires: 1, by: "mac" })))?.by).toBe("mac");
  });

  it("gives null for anything it can't trust: errors, odd bodies, no network", async () => {
    expect(await peekGatewayApproval(approval, json({ error: "forbidden" }, 403))).toBeNull();
    expect(await peekGatewayApproval(approval, json({ nope: true }))).toBeNull();
    expect(await peekGatewayApproval(approval, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe("formatTimeLeft", () => {
  it("counts down as m:ss and stops at zero", () => {
    expect(formatTimeLeft(1000, 700_000)).toBe("5:00");
    expect(formatTimeLeft(1000, 940_000)).toBe("1:00");
    expect(formatTimeLeft(1000, 995_500)).toBe("0:05");
    expect(formatTimeLeft(1000, 2_000_000)).toBe("0:00");
  });
});

describe("gateway calls on a phone that just woke up", () => {
  const approval = { id: "abcdef0123", token: "t".repeat(40), url: "https://approvals.internal" };

  it("give up on a connection that hangs instead of spinning for good", async () => {
    vi.useFakeTimers();
    try {
      const hang = ((_: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
      const peek = peekGatewayApproval(approval, hang);
      const answer = answerGatewayApproval(approval, "approve", hang);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await peek).toBeNull();
      expect(await answer).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treat a request the homelab no longer has as closed, not unreachable", async () => {
    const gone = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await peekGatewayApproval(approval, gone)).toMatchObject({ state: "expired" });
  });
});

describe("root commands: the sudo password", () => {
  const pad = "a5".repeat(128);
  const approval = { id: "0123456789", token: "t".repeat(43), url: "https://approvals.internal", pad };

  it("keeps the pad from the notification", () => {
    expect(parseGatewayApproval({ kind: "gateway-approval", id: approval.id, token: approval.token, url: approval.url, pad })).toEqual(approval);
    expect(parseGatewayApproval({ kind: "gateway-approval", id: approval.id, token: approval.token, url: approval.url, pad: "zz" })).not.toHaveProperty("pad");
  });

  it("seals the password with the pad (the gateway's open_password undoes it)", () => {
    const sealed = sealPassword("pä55", pad)!;
    expect(sealed).toHaveLength(256);
    expect(sealed).not.toContain(Buffer.from("pä55").toString("hex"));
    const back = Buffer.from(sealed, "hex").map((b, i) => b ^ 0xa5);
    expect(Buffer.from(back).toString("utf8").replace(/\0+$/, "")).toBe("pä55");
    expect(sealPassword("x".repeat(128), pad)).toBeNull();
  });

  it("sends only the sealed password, and only when approving", async () => {
    const bodies: unknown[] = [];
    const spy = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await answerGatewayApproval(approval, "approve", spy, "secret!")).toBe("done");
    expect(await answerGatewayApproval(approval, "deny", spy, "secret!")).toBe("done");
    expect(JSON.stringify(bodies)).not.toContain("secret!");
    expect(bodies[0]).toMatchObject({ decision: "approve", secret: sealPassword("secret!", pad) });
    expect(bodies[1]).toEqual({ token: approval.token, decision: "deny" });
  });

  it("peek says when a password is needed", async () => {
    const res = (async () => new Response(JSON.stringify({ summary: "s", state: "pending", expires: 1, password: true }), { status: 200 })) as unknown as typeof fetch;
    expect((await peekGatewayApproval(approval, res))?.password).toBe(true);
  });
});

describe("what became of a closed request", () => {
  const r = (id: string, over: Partial<{ settled: number; outcome: "approve" | "deny" | "expired"; by: string | null; pushed: boolean }> = {}) => ({
    id,
    summary: "Run on the homelab as zawaer:\nls -la /srv",
    settled: 2_000,
    outcome: "expired" as const,
    by: "timeout",
    pushed: true,
    ...over,
  });

  it("says how it ended and where", () => {
    expect(describeGatewaySettled("expired", "timeout")).toBe("Expired, nothing ran");
    expect(describeGatewaySettled("approve", "mac")).toBe("Approved on the Mac");
    expect(describeGatewaySettled("deny", "phone")).toBe("Denied on the phone, nothing ran");
    expect(describeGatewaySettled("deny", "guard")).toBe("Denied after wrong tries, nothing ran");
    expect(describeGatewaySettled("approve", null)).toBe("Approved");
  });

  it("shows the command, not the gateway's preamble", () => {
    expect(gatewaySummaryLine("Run as ROOT on the homelab:\nsystemctl restart x\n\nEnter your sudo password to approve.")).toBe("systemctl restart x");
    expect(gatewaySummaryLine("Delete folder /a (zawaer): 3 files")).toBe("Delete folder /a (zawaer): 3 files");
    expect(gatewaySummaryLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("mentions only what reached the phone, closed since it last looked, and wasn't answered there", () => {
    const list = [
      r("new-expired"),
      r("old", { settled: 1_000 }),
      r("answered-here", { outcome: "approve", by: "phone" }),
      r("never-buzzed", { outcome: "approve", by: "mac", pushed: false }),
      r("mac-after-buzz", { outcome: "approve", by: "mac" }),
      r("in-the-popup"),
    ];
    expect(settledToMention(list, 1_500, new Set(["in-the-popup"])).map((x) => x.id)).toEqual(["new-expired", "mac-after-buzz"]);
  });

  it("puts one in a toast with its command, several as a count", () => {
    expect(describeMentions([])).toBeNull();
    expect(describeMentions([r("a")])).toBe("Homelab: Expired, nothing ran: ls -la /srv");
    expect(describeMentions([r("a"), r("b"), r("c", { outcome: "approve", by: "mac" })])).toBe(
      "Homelab: 3 requests closed (2 expired, 1 answered elsewhere). See Settings > Homelab approvals.",
    );
  });
});
