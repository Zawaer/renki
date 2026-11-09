import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/Markdown.js";
import { GenUiReplyContext } from "../src/components/GenUi.js";
import { markdownToPlainText } from "../src/lib/plainText.js";

const fence = (json: object) => "```renki-ui\n" + JSON.stringify(json) + "\n```";

describe("generative UI in replies", () => {
  it("draws choices, and a pick sends its reply once", () => {
    const onReply = vi.fn();
    const md = "Pick a style:\n\n" + fence({ type: "choices", question: "Which?", options: [{ label: "Calm", detail: "slow", reply: "Use calm" }, "Punchy"] });
    render(
      <GenUiReplyContext.Provider value={onReply}>
        <Markdown content={md} />
      </GenUiReplyContext.Provider>,
    );
    expect(screen.getByText("Pick a style:")).toBeInTheDocument();
    expect(screen.queryByText(/"type"/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Calm/ }));
    fireEvent.click(screen.getByRole("button", { name: /Punchy/ }));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith("Use calm");
  });

  it("can't pick without a chat to send to", () => {
    render(<Markdown content={fence({ type: "choices", options: ["A"] })} />);
    expect(screen.getByRole("button", { name: "A" })).toBeDisabled();
  });

  it("draws a checklist with its count, and stats", () => {
    render(<Markdown content={fence({ type: "checklist", title: "Release", items: [{ text: "Build", done: true }, "Upload"] })} />);
    expect(screen.getByTestId("genui-checklist")).toHaveTextContent("1 of 2");
    render(<Markdown content={fence({ type: "stats", items: [{ label: "Views", value: "12k" }] })} />);
    expect(screen.getByTestId("genui-stats")).toHaveTextContent("12k");
  });

  it("keeps an invalid block as code, and shows a placeholder while one streams in", () => {
    const { container } = render(<Markdown content={"```renki-ui\nnope\n```"} />);
    expect(container.querySelector("pre")).toHaveTextContent("nope");
    const live = render(<Markdown content={'Here:\n\n```renki-ui\n{"type":"che'} streaming />);
    expect(live.container.querySelector("pre")).toBeNull();
    expect(live.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("copies as text, not JSON", () => {
    expect(markdownToPlainText(fence({ type: "choices", options: ["A", "B"] }))).toBe("1. A\n2. B");
  });
});
