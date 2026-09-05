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
  const location = useLocation();
  const navigate = useNavigate();
  const onStats = location.pathname === "/stats";
  const onSettings = location.pathname === "/settings";
  const sessionMatch = location.pathname.match(/^\/session\/(.+)$/);
  const selected = sessionMatch ? decodeURIComponent(sessionMatch[1]!) : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-(--crc-border) bg-(--crc-bg-elevated) px-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-(--crc-accent) text-(--crc-accent-fg) shadow-(--crc-shadow-xs)">
            <span className="codicon codicon-terminal text-[13px]" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-(--crc-fg)">Claude Remote Control</span>
          <ConnBadge status={status} />
        </div>
        <div className="flex items-center gap-1 text-xs text-(--crc-fg-muted)">
          <span className="mr-2 hidden sm:inline">{config.deviceName}</span>
          <HeaderButton active={onStats} title="Stats" icon="graph-line" onClick={() => navigate(onStats ? "/" : "/stats")} />
          <AccountsBar />
          <RtkGainBadge />
          <HeaderButton active={onSettings} title="Settings" icon="gear" onClick={() => navigate(onSettings ? "/" : "/settings")} />
        </div>
      </header>

      {lastError && (
        <div className="flex items-center gap-1.5 border-b border-(--crc-danger)/30 bg-(--crc-danger)/10 px-4 py-1.5 text-xs text-(--crc-danger)">
          <span className="codicon codicon-error" />
          {lastError.code}: {lastError.message}
        </div>
      )}

      <div className="grid flex-1 grid-cols-[288px_1fr] overflow-hidden">
        <aside className="flex flex-col border-r border-(--crc-border) bg-(--crc-bg-elevated)">
          <div className="min-h-0 flex-1">
            <SessionList
              selectedId={selected}
              onSelect={(id) => navigate(`/session/${encodeURIComponent(id)}`)}
              onDeleted={(id) => {
                if (selected === id) navigate("/");
              }}
            />
          </div>
        </aside>
        <main className="overflow-hidden bg-(--crc-bg)">
          <Routes>
            <Route path="/stats" element={<StatsView />} />
            <Route path="/settings" element={<Settings onReset={onReset} managed={managed} />} />
            <Route
              path="/session/:id"
              element={selected ? <SessionView key={selected} sessionId={selected} /> : null}
            />
            <Route
              path="*"
              element={
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-(--crc-border) bg-(--crc-surface) text-(--crc-fg-muted) shadow-(--crc-shadow-sm)">
                    <span className="codicon codicon-comment-discussion text-xl" />
                  </span>
                  <div>
                    <div className="text-sm font-medium text-(--crc-fg)">No session open</div>
                    <div className="mt-1 text-xs text-(--crc-fg-muted)">Pick one from the sidebar, or start a new one.</div>
                  </div>
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function HeaderButton({ active, title, icon, onClick }: { active: boolean; title: string; icon: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-(--crc-hover) hover:text-(--crc-fg) ${
        active ? "bg-(--crc-hover) text-(--crc-fg)" : "text-(--crc-fg-muted)"
      }`}
    >
      <span className={`codicon codicon-${icon}`} />
    </button>
  );
}

function ConnBadge({ status }: { status: "connecting" | "open" | "closed" }) {
  const map = {
    open: { color: "bg-(--crc-success)", label: "Connected", tone: "text-(--crc-fg-muted)" },
    connecting: { color: "bg-(--crc-warning) animate-pulse", label: "Connecting…", tone: "text-(--crc-warning)" },
    closed: { color: "bg-(--crc-danger)", label: "Offline", tone: "text-(--crc-danger)" },
  } as const;
  const s = map[status];
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-full border border-(--crc-border) bg-(--crc-surface) px-2 text-[11px] font-medium ${s.tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.color}`} />
      {s.label}
    </span>
  );
}
