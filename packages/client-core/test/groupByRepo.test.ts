import type { Session } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { groupByRepo } from "../src/trash.js";

const s = (id: string, repoId: string | null, createdAt: number, lastActivityAt: number) =>
  ({ id, repoId, repoName: repoId ?? "", createdAt, lastActivityAt, status: "idle", hasPendingPermission: false }) as unknown as Session;

describe("groupByRepo", () => {
  it("keeps chats where they are when one gets a message: newest started first", () => {
    const groups = groupByRepo([s("old", "a", 1, 900), s("new", "a", 5, 10), s("other", "b", 3, 999)]);
    expect(groups.map((g) => g.key)).toEqual(["a", "b"]);
    expect(groups[0]!.sessions.map((x) => x.id)).toEqual(["new", "old"]);
  });
});
