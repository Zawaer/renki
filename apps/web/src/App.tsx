import { useEffect, useState } from "react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ClientProvider, useClient, useStoreValue } from "./lib/client.js";
import { type AppConfig, clearConfig, loadConfig, saveConfig } from "./lib/config.js";
import { AccountsBar } from "./components/AccountsBar.js";
import { Home } from "./components/Home.js";
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
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "1" : "0");
    } catch {
      // Storage unavailable — the preference just won't persist.
    }
  }, [sidebarOpen]);

  // ⌘B / Ctrl+B toggles the sidebar, as in every editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!sidebarOpen) {
    // Collapsed: a slim rail keeps the essentials one click away.
    return (
      <div className="grid h-full grid-cols-[48px_1fr] overflow-hidden">
        <aside className="flex min-h-0 flex-col items-center border-r border-(--crc-border) bg-(--crc-bg-elevated) py-2">
          <button
            onClick={() => navigate("/")}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-(--crc-hover)"
            title="Home"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-(--crc-accent) text-(--crc-accent-fg) shadow-(--crc-shadow-xs)">
              <span className="codicon codicon-terminal text-[13px]" />
            </span>
          </button>
          <HeaderButton active={false} title="Show sidebar (⌘B)" icon="layout-sidebar-left" onClick={() => setSidebarOpen(true)} />
          <div className="flex-1" />
          {status !== "open" && (
            <span className="mb-1 flex h-8 w-8 items-center justify-center" title={status === "connecting" ? "Connecting…" : "Offline — retrying"}>
              <span className={`h-2 w-2 rounded-full ${status === "connecting" ? "bg-(--crc-warning) animate-pulse" : "bg-(--crc-danger)"}`} />
            </span>
          )}
          <HeaderButton active={onStats} title="Stats" icon="graph-line" onClick={() => navigate(onStats ? "/" : "/stats")} />
          <HeaderButton active={onSettings} title="Settings" icon="gear" onClick={() => navigate(onSettings ? "/" : "/settings")} />
        </aside>
        <MainColumn lastError={lastError} selected={selected} onReset={onReset} managed={managed} />
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[288px_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col border-r border-(--crc-border) bg-(--crc-bg-elevated)">
        <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
          <button onClick={() => navigate("/")} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 text-left" title="Home">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-(--crc-accent) text-(--crc-accent-fg) shadow-(--crc-shadow-xs)">
              <span className="codicon codicon-terminal text-[13px]" />
            </span>
            <span className="truncate text-[13px] font-semibold tracking-tight text-(--crc-fg)">Claude Remote Control</span>
          </button>
          <HeaderButton active={false} title="Hide sidebar (⌘B)" icon="layout-sidebar-left-off" onClick={() => setSidebarOpen(false)} />
        </div>

        <div className="min-h-0 flex-1">
          <SessionList
            selectedId={selected}
            onSelect={(id) => navigate(`/session/${encodeURIComponent(id)}`)}
            onDeleted={(id) => {
              if (selected === id) navigate("/");
            }}
          />
        </div>

        {/*
          * The quiet corner. It carries only what you'd act on: how much usage
          * headroom is left (AccountsBar's trigger), and the two places you
          * navigate to. Your own device name and a permanently-green
          * "connected" dot told you nothing, so they're gone — the connection
          * only speaks up when it's actually broken.
          */}
        <div className="flex shrink-0 items-center gap-0.5 border-t border-(--crc-border) p-2">
          {status === "open" ? <AccountsBar /> : <ConnectionAlert status={status} />}
          <div className="ml-auto flex items-center gap-0.5">
            <HeaderButton active={onStats} title="Stats" icon="graph-line" onClick={() => navigate(onStats ? "/" : "/stats")} />
            <HeaderButton active={onSettings} title="Settings" icon="gear" onClick={() => navigate(onSettings ? "/" : "/settings")} />
          </div>
        </div>
      </aside>

      <MainColumn lastError={lastError} selected={selected} onReset={onReset} managed={managed} />
    </div>
  );
}

const SIDEBAR_KEY = "crc.sidebar.open";

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

function MainColumn({
  lastError,
  selected,
  onReset,
  managed,
}: {
  lastError: { code: string; message: string } | null;
  selected: string | null;
  onReset: () => void;
  managed: boolean;
}) {
  return (
    <main className="flex min-h-0 flex-col overflow-hidden bg-(--crc-bg)">
      {lastError && (
        <div className="flex items-center gap-1.5 border-b border-(--crc-danger)/30 bg-(--crc-danger)/10 px-4 py-1.5 text-xs text-(--crc-danger)">
          <span className="codicon codicon-error" />
          {lastError.code}: {lastError.message}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Routes>
          <Route path="/stats" element={<StatsView />} />
          <Route path="/settings" element={<Settings onReset={onReset} managed={managed} />} />
          <Route path="/session/:id" element={selected ? <SessionView key={selected} sessionId={selected} /> : null} />
          <Route path="*" element={<Home />}             />
        </Routes>
      </div>
    </main>
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

/** Shown only while the daemon is unreachable — silence is the healthy state. */
function ConnectionAlert({ status }: { status: "connecting" | "closed" }) {
  const s =
    status === "connecting"
      ? { dot: "bg-(--crc-warning) animate-pulse", tone: "text-(--crc-warning)", label: "Connecting…" }
      : { dot: "bg-(--crc-danger)", tone: "text-(--crc-danger)", label: "Offline — retrying" };
  return (
    <span className={`inline-flex h-8 items-center gap-1.5 px-2 text-xs font-medium ${s.tone}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
