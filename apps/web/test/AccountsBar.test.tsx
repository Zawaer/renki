import type { AccountsResponse } from "@crc/protocol";
import { RealtimeClient, RestClient } from "@crc/client-core";
import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AccountsBar } from "../src/components/AccountsBar.js";
import { ClientContext } from "../src/lib/client.js";
import { cleanupRoots, render } from "./render.js";

/**
 * Smoke test for the header's usage badge/dropdown — renders it with real
 * account data (not the empty-state null) to pin down that it's still
 * reachable after any styling/relocation pass, since AccountsBar silently
 * swallows fetch errors and renders nothing at all when it has no accounts.
 */

afterEach(cleanupRoots);

const SAMPLE: AccountsResponse = {
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1,
      email: "dev@example.com",
      active: true,
      usageStatus: "ok",
      usage: {
        fiveHour: { pct: 42, resetsAt: null },
        sevenDay: { pct: 18, resetsAt: null },
        limits: [
          { kind: "session", label: "Session usage", model: null, pct: 42, resetsAt: null, severity: "normal", isActive: true },
          { kind: "weekly_all", label: "All models", model: null, pct: 18, resetsAt: null, severity: "normal", isActive: false },
          { kind: "weekly_scoped", label: "Fable", model: "Fable", pct: 32, resetsAt: null, severity: "normal", isActive: false },
        ],
        extra: null,
      },
    },
  ],
  rotation: { enabled: true, threshold: 90, cooldownMs: 60_000, lastSwitchAt: null, lastHoldReason: null },
  usageConfigured: true,
  usageConnectedEmails: ["dev@example.com"],
};

function renderAccountsBar(response: AccountsResponse) {
  const rest = new RestClient({ baseUrl: "http://test.invalid", token: "t" });
  rest.listAccounts = async () => response;
  const realtime = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
  const config = { baseUrl: "http://test.invalid", token: "t", deviceId: "d1", deviceName: "Test" };

  return render(
    <MemoryRouter>
      <ClientContext.Provider value={{ rest, realtime, config }}>
        <AccountsBar />
      </ClientContext.Provider>
    </MemoryRouter>,
  );
}

describe("AccountsBar", () => {
  it("shows a badge trigger, and the account row + usage meters once opened", async () => {
    renderAccountsBar(SAMPLE);

    const trigger = await screen.findByRole("button", { name: /Accounts & usage/ });
    // The trigger shows the worst usage figure — the one number worth glancing at.
    expect(trigger.textContent).toContain("42%");
    // Closed by default — a footer badge, not an always-visible panel.
    expect(screen.queryByText("dev@example.com")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
    // 42% is the worst window, so it shows twice once open: on the trigger and on its meter.
    expect(screen.getAllByText("42%")).toHaveLength(2);
    expect(screen.getByText("18%")).toBeInTheDocument();
    // The per-model weekly cap — invisible before this existed.
    expect(screen.getByText("Fable")).toBeInTheDocument();
    expect(screen.getByText("32%")).toBeInTheDocument();
    expect(screen.getAllByText("Weekly")).toHaveLength(2);
    expect(screen.getByText(/auto @ 90%/)).toBeInTheDocument();
  });

  it("shows every window (including a per-model weekly cap), its reset and any overage", async () => {
    // Reset later today, so the wording is stable regardless of when this runs.
    const today = new Date();
    today.setHours(23, 30, 0, 0);
    const resetsAt = today.toISOString();
    renderAccountsBar({
      ...SAMPLE,
      accounts: [
        {
          ...SAMPLE.accounts[0],
          usage: {
            limits: [
              { kind: "session", label: "Session usage", model: null, pct: 42, resetsAt, severity: "critical", isActive: true },
              { kind: "weekly_all", label: "All models", model: null, pct: 18, resetsAt: null, severity: "normal", isActive: false },
            ],
            fiveHour: { pct: 42, resetsAt },
            sevenDay: { pct: 18, resetsAt: null },
            extra: { pct: 79, usedDollars: 39.53, limitDollars: 50, currency: "USD" },
          },
        },
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: /Accounts & usage/ }));

    expect(screen.getByText("Resets today 23:30")).toBeInTheDocument();
    expect(screen.getByText("5-hour rolling window")).toBeInTheDocument();
    expect(screen.getByText("39.53 / 50.00 USD")).toBeInTheDocument();
  });

  it("renders nothing when there are no configured accounts (by design)", async () => {
    renderAccountsBar({ ...SAMPLE, accounts: [] });

    // Give the listAccounts().then(setData) microtask a tick to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "Accounts & usage" })).not.toBeInTheDocument();
  });
});
