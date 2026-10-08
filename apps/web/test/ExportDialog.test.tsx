import { RealtimeClient, RestClient } from "@renki/client-core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "../src/components/ExportDialog.js";
import { ClientContext } from "../src/lib/client.js";
import { cleanupRoots, render } from "./render.js";

afterEach(cleanupRoots);
beforeEach(() => {
  localStorage.clear();
  // jsdom has no object URLs; the dialog only needs them to hand over the file.
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  // …nor navigation, which clicking the download link would start.
  HTMLAnchorElement.prototype.click = vi.fn();
});

function renderDialog(exportSession: RestClient["exportSession"], onClose = vi.fn()) {
  const realtime = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
  const rest = new RestClient({ baseUrl: "http://test.invalid", token: "t" });
  rest.exportSession = exportSession;
  const config = { baseUrl: "http://test.invalid", token: "t", deviceId: "d1", deviceName: "Test" };
  render(
    <ClientContext.Provider value={{ rest, realtime, config }}>
      <ExportDialog sessionId="s1" title="My chat" onClose={onClose} />
    </ClientContext.Provider>,
  );
  return onClose;
}

describe("ExportDialog", () => {
  it("exports Markdown with media and tool calls by default, and sends what the checkboxes say", async () => {
    const exportSession = vi.fn(async () => ({ filename: "my-chat.md", contentType: "text/markdown", data: new ArrayBuffer(4) }));
    const onClose = renderDialog(exportSession);
    expect((screen.getByLabelText(/Include media/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Include thinking/) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "PDF" }));
    fireEvent.click(screen.getByLabelText(/Include stats/));
    fireEvent.click(screen.getByText("Export"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exportSession).toHaveBeenCalledWith("s1", { format: "pdf", media: true, tools: true, thinking: false, stats: true });
    // Remembered for next time on this device.
    expect(JSON.parse(localStorage.getItem("renki.export.choices")!)).toMatchObject({ format: "pdf", stats: true });
  });

  it("shows why an export failed and stays open", async () => {
    const onClose = renderDialog(vi.fn(async () => {
      throw new Error("PDF export needs Chromium on the daemon host.");
    }));
    fireEvent.click(screen.getByText("Export"));
    await waitFor(() => expect(screen.getByText(/needs Chromium/)).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});
