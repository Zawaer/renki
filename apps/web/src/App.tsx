import { useState } from "react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ClientProvider, useClient, useStoreValue } from "./lib/client.js";
import { type AppConfig, clearConfig, loadConfig, saveConfig } from "./lib/config.js";
import { AccountsBar } from "./components/AccountsBar.js";
import { RtkGainBadge } from "./components/RtkGainBadge.js";
import { SessionList } from "./components/SessionList.js";
import { SessionView } from "./components/SessionView.js";
import { Settings } from "./components/Settings.js";
import { Setup } from "./components/Setup.js";
import { StatsView } from "./components/StatsView.js";
import { injectedConfig } from "./lib/host.js";

export function App() {
  // A host (VS Code webview) can inject config; otherwise fall back to what this
  // browser saved. When hosted, we never show the Setup/Disconnect flow — the
  // host owns the connection settings.
  const injected = injectedConfig();
  const [config, setConfig] = useState<AppConfig | null>(() => injected ?? loadConfig());

  if (!config) {
    return (
      <Setup
        onSave={(c) => {
          saveConfig(c);
          setConfig(c);
        }}
      />
    );
  }

  // A VS Code webview has no real address bar to navigate — routes there
  // live only in memory. A plain browser tab gets real, bookmarkable URLs.
  const Router = injected !== null ? MemoryRouter : BrowserRouter;

  return (
    <ClientProvider config={config}>
      <Router>
        <Workspace
          managed={injected !== null}
          onReset={() => {
            clearConfig();
            setConfig(null);
          }}
        />
      </Router>
    </ClientProvider>
  );
}

function Workspace({ onReset, managed }: { onReset: () => void; managed: boolean }) {
  const { realtime, config } = useClient();
  const status = useStoreValue(realtime.status);
  const lastError = useStoreValue(realtime.lastError);
  const [selected, setSelected] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const onStats = location.pathname === "/stats";
  const onSettings = location.pathname === "/settings";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-(--crc-border) bg-(--crc-bg-elevated) px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-(--crc-fg)">Claude Remote Control</span>
          <ConnBadge status={status} />
        </div>
        <div className="flex items-center gap-3 text-xs text-(--crc-fg-muted)">
          <span>{config.deviceName}</span>
          <button
            onClick={() => navigate(onStats ? "/" : "/stats")}
            title="Stats"
            className={`flex items-center gap-1 rounded-sm px-1.5 py-1 hover:bg-(--crc-hover) hover:text-(--crc-fg) ${
              onStats ? "text-(--crc-fg)" : "text-(--crc-fg-muted)"
            }`}
          >
            <span className="codicon codicon-graph-line" />
          </button>
          <AccountsBar />
          <RtkGainBadge />
          <button
            onClick={() => navigate(onSettings ? "/" : "/settings")}
            title="Settings"
            className={`flex items-center gap-1 rounded-sm px-1.5 py-1 hover:bg-(--crc-hover) hover:text-(--crc-fg) ${
              onSettings ? "text-(--crc-fg)" : "text-(--crc-fg-muted)"
            }`}
          >
            <span className="codicon codicon-gear" />
          </button>
        </div>
      </header>

      {lastError && (
        <div className="flex items-center gap-1.5 bg-(--crc-danger)/15 px-4 py-1.5 text-xs text-(--crc-danger)">
          <span className="codicon codicon-error" />
          {lastError.code}: {lastError.message}
        </div>
      )}

      <div className="grid flex-1 grid-cols-[280px_1fr] overflow-hidden">
        <aside className="flex flex-col border-r border-(--crc-border) bg-(--crc-bg-elevated)">
          <div className="min-h-0 flex-1">
            <SessionList
              selectedId={selected}
              onSelect={(id) => {
                setSelected(id);
                navigate("/");
              }}
              onDeleted={(id) => setSelected((cur) => (cur === id ? null : cur))}
            />
          </div>
        </aside>
        <main className="overflow-hidden bg-(--crc-bg)">
          <Routes>
            <Route path="/stats" element={<StatsView />} />
            <Route path="/settings" element={<Settings onReset={onReset} managed={managed} />} />
            <Route
              path="*"
              element={
                selected ? (
                  <SessionView key={selected} sessionId={selected} />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-(--crc-fg-muted)">
                    Select or create a session.
                  </div>
                )
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ConnBadge({ status }: { status: "connecting" | "open" | "closed" }) {
  const map = {
    open: { color: "bg-(--crc-success)", label: "connected" },
    connecting: { color: "bg-(--crc-warning) animate-pulse", label: "connecting" },
    closed: { color: "bg-(--crc-danger)", label: "offline" },
  } as const;
  const s = map[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-(--crc-fg-muted)">
      <span className={`h-2 w-2 rounded-full ${s.color}`} />
      {s.label}
    </span>
  );
}
