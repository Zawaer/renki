import { describe, expect, it } from "vitest";
import { answerGatewayApproval, describeGatewayOutcome, formatTimeLeft, parseGatewayApproval, peekGatewayApproval } from "../src/gatewayApproval";

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
    expect(await peekGatewayApproval(approval, spy)).toEqual({ summary: "Create a private GitHub repo Zawaer/x (empty).", state: "pending", expires: 1_800_000_300 });
    expect(seen!.url).toBe("https://approvals.internal/v1/approvals/0123456789");
    expect((seen!.init.headers as Record<string, string>)["x-approval-token"]).toBe("t".repeat(43));
    expect(seen!.url).not.toContain("t".repeat(43)); // the token never goes in the URL
  });

  it("reports a request that was already decided or ran out", async () => {
    expect((await peekGatewayApproval(approval, json({ summary: "s", state: "approve", expires: 1 })))?.state).toBe("approve");
    expect((await peekGatewayApproval(approval, json({ summary: "s", state: "expired", expires: 1 })))?.state).toBe("expired");
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
