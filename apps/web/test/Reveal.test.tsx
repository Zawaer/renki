import { screen } from "@testing-library/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Reveal } from "../src/components/ui.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Reveal", () => {
  it("shows its content the moment it opens, and keeps it for the closing animation", () => {
    vi.useFakeTimers();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    const show = (open: boolean) => flushSync(() => root.render(<Reveal open={open}>details</Reveal>));

    show(false);
    expect(screen.queryByText("details")).not.toBeInTheDocument();
    show(true);
    expect(screen.getByText("details")).toBeInTheDocument();

    show(false);
    expect(screen.getByText("details")).toBeInTheDocument(); // still animating closed
    flushSync(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText("details")).not.toBeInTheDocument();
    root.unmount();
  });
});
