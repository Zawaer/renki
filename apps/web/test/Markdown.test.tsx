import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown.js";

describe("Markdown tables", () => {
  it("renders a GFM table in a scrolling rounded frame with row dividers only", () => {
    const md = ["| Name | Notes |", "| --- | --- |", "| `foo` | first |", "| bar | second |"].join("\n");
    const { container } = render(<Markdown content={md} />);

    const table = container.querySelector("table")!;
    expect(table).toBeInTheDocument();
    const frame = table.parentElement!;
    expect(frame.className).toContain("overflow-x-auto");
    expect(frame.className).toContain("rounded-");

    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("font-semibold");
    // Body cells divide rows with a top border, never a full box.
    const cell = screen.getByRole("cell", { name: "first" });
    expect(cell.className).toContain("border-t");
    expect(cell.className).not.toMatch(/(^|\s)border(\s|$)/);
    // Inline code inside a cell keeps its styling.
    expect(screen.getByText("foo").tagName).toBe("CODE");
  });
});
