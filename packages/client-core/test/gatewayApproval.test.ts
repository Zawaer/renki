import { describe, expect, it } from "vitest";
import { answerGatewayApproval, describeGatewayOutcome, parseGatewayApproval } from "../src/gatewayApproval";

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
