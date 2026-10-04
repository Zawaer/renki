import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/Markdown.js";
import { FileLinkContext } from "../src/lib/fileLinks.js";

const WT = "/srv/renki/worktrees/abc";

function renderWith(md: string, onOpenFile?: (path: string, line?: number) => void) {
  return render(
    onOpenFile ? (
      <FileLinkContext.Provider value={{ worktreePath: WT, onOpenFile }}>
        <Markdown content={md} />
      </FileLinkContext.Provider>
    ) : (
      <Markdown content={md} />
    ),
  );
}

describe("Markdown file links", () => {
  afterEach(cleanup);

  it("opens a relative file link in the panel instead of a new tab", () => {
    const onOpenFile = vi.fn();
    renderWith("See [notes.md](notes.md).", onOpenFile);
    const link = screen.getByRole("link", { name: "notes.md" });
    expect(link).not.toHaveAttribute("target");
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("notes.md", undefined);
  });

  it("passes the line from #L42 and maps absolute worktree paths", () => {
    const onOpenFile = vi.fn();
    renderWith(`[foo.ts:42](src/foo.ts#L42) and [bar](${WT}/lib/bar.ts:7)`, onOpenFile);
    fireEvent.click(screen.getByRole("link", { name: "foo.ts:42" }));
    expect(onOpenFile).toHaveBeenLastCalledWith("src/foo.ts", 42);
    fireEvent.click(screen.getByRole("link", { name: "bar" }));
    expect(onOpenFile).toHaveBeenLastCalledWith("lib/bar.ts", 7);
  });

  it("keeps web links opening in a new tab", () => {
    const onOpenFile = vi.fn();
    renderWith("[site](https://example.com)", onOpenFile);
    const link = screen.getByRole("link", { name: "site" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "https://example.com");
    fireEvent.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("renders file links as inert text with no worktree to open them in", () => {
    renderWith("See [notes.md](notes.md) and [pw](/etc/passwd).");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("notes.md").tagName).toBe("SPAN");
  });

  it("leaves paths outside the worktree inert", () => {
    const onOpenFile = vi.fn();
    renderWith("[pw](/etc/passwd) [up](../secret)", onOpenFile);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
