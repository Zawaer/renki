import { addHost, removeHost, type HostsState } from "@renki/client-core";
import { useEffect, useState } from "react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ClientProvider, useClient, useStoreValue } from "./lib/client.js";
import { type AppConfig, getOrCreateDeviceId } from "./lib/config.js";
import { loadHosts, saveHosts } from "./lib/hosts.js";
import { HostSwitcher } from "./components/HostSwitcher.js";
import { RenkiMark } from "./components/ui.js";
import { AccountsBar } from "./components/AccountsBar.js";
import { Home } from "./components/Home.js";
import { SessionList } from "./components/SessionList.js";
import { SessionView } from "./components/SessionView.js";
import { Settings } from "./components/Settings.js";
import { Setup } from "./components/Setup.js";
import { StatsView } from "./components/StatsView.js";
import { injectedConfig } from "./lib/host.js";

export function App() {
  // A host (VS Code webview) can inject config; that connection is owned by
  // the workspace's own settings, so it bypasses the host list entirely —
  // there's nothing to switch between inside one workspace's webview.
  const injected = injectedConfig();
  if (injected !== null) return <ManagedApp config={injected} />;
  return <MultiHostApp />;
}

/** VS Code webview path: unchanged from before hosts existed — one injected connection, no Setup/Disconnect/switcher. */
function ManagedApp({ config }: { config: AppConfig }) {
  return (
    <ClientProvider config={config}>
      <MemoryRouter>
        <Workspace managed onReset={() => {}} />
      </MemoryRouter>
    </ClientProvider>
  );
}

/**
 * The ordinary path: a plain browser tab, backed by the stored host list.
 * Reads the list fresh each render rather than in state — every mutation
 * below reloads the page, so this component is never alive to see a change
 * happen out from under it; state would just be an unused setter.
 */
function MultiHostApp() {
  const hostsState = loadHosts();
  const active = hostsState.hosts.find((h) => h.id === hostsState.activeId) ?? null;

  function persist(next: HostsState) {
    saveHosts(next);
    // A full reload rather than just updating state: ClientProvider's
    // RestClient/RealtimeClient are constructed once per config identity, and
    // a host switch changes baseUrl/token/deviceId all at once — the same
    // "reload after a connection change" pattern Settings' rename-device and
    // PairDevice's reconnect already use.
    window.location.reload();
  }

  if (!active) {
    return (
      <Setup
        onSave={(c, label) => {
          persist(addHost(hostsState, { label: label || "Home", baseUrl: c.baseUrl, token: c.token, deviceName: c.deviceName }));
        }}
      />
    );
  }

  const config: AppConfig = {
    baseUrl: active.baseUrl,
    token: active.token,
    deviceId: getOrCreateDeviceId(),
    deviceName: active.deviceName,
    hostId: active.id,
  };

  return (
    <ClientProvider config={config}>
      <BrowserRouter>
        <Workspace managed={false} onReset={() => persist(removeHost(hostsState, active.id))} />
      </BrowserRouter>
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
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "1" : "0");
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Storage unavailable — the preference just won't persist.
    }
  }, [sidebarOpen, sidebarWidth]);

  /**
   * Drag the sidebar's edge to resize it, and keep dragging left to collapse
   * it to the rail — the same gesture an editor uses, so it needs no
   * explaining.
   *
   * The listeners live on the WINDOW, not the handle: crossing the collapse
   * threshold swaps which of the two sidebar branches is rendered, which
   * unmounts the handle mid-drag. Pointer capture on the handle would die with
   * it, stranding the drag; the window doesn't go anywhere.
   */
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      // The sidebar starts at the window's left edge, so the pointer's x IS
      // the width the user is asking for.
      if (ev.clientX < SIDEBAR_COLLAPSE_AT) {
        setSidebarOpen(false);
        return;
      }
      setSidebarOpen(true);
      setSidebarWidth(clampSidebarWidth(ev.clientX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("renki-resizing");
    };
    // Held on <body> so the resize cursor survives crossing other elements and
    // a drag can't select text on the way past.
    document.body.classList.add("renki-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Arrow keys move the edge; pushing past the minimum collapses it, as dragging does. */
  function resizeByKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (!sidebarOpen) return;
      if (sidebarWidth <= SIDEBAR_MIN) setSidebarOpen(false);
      else setSidebarWidth(clampSidebarWidth(sidebarWidth - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!sidebarOpen) setSidebarOpen(true);
      else setSidebarWidth(clampSidebarWidth(sidebarWidth + step));
    }
  }

  const resizeHandle = (
    <ResizeHandle
      width={sidebarOpen ? sidebarWidth : SIDEBAR_RAIL}
      onPointerDown={startResize}
      onKeyDown={resizeByKey}
      onDoubleClick={() => {
        setSidebarOpen(true);
        setSidebarWidth(SIDEBAR_DEFAULT);
      }}
    />
  );

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
      <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: `${SIDEBAR_RAIL}px 1fr` }}>
        <aside className="relative flex min-h-0 flex-col items-center border-r border-(--renki-border) bg-(--renki-bg-elevated) py-2">
          {/* Draggable from the rail too, so the gesture that collapsed it brings it back. */}
          {resizeHandle}
          <button
            onClick={() => navigate("/")}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-(--renki-hover)"
            title="Home"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-(--renki-accent) text-(--renki-accent-fg) shadow-(--renki-shadow-xs)">
              <RenkiMark className="h-3.5 w-3.5" />
            </span>
          </button>
          <HeaderButton active={false} title="Show sidebar (⌘B)" icon="layout-sidebar-left" onClick={() => setSidebarOpen(true)} />
          <div className="flex-1" />
          {status !== "open" && (
            <span className="mb-1 flex h-8 w-8 items-center justify-center" title={status === "connecting" ? "Connecting…" : "Offline — retrying"}>
              <span className={`h-2 w-2 rounded-full ${status === "connecting" ? "bg-(--renki-warning) animate-pulse" : "bg-(--renki-danger)"}`} />
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
    <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <aside className="relative flex min-h-0 flex-col border-r border-(--renki-border) bg-(--renki-bg-elevated)">
        {resizeHandle}
        <div className="flex h-12 shrink-0 items-center gap-1.5 pr-2 pl-4">
          <button
            onClick={() => navigate("/")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-(--renki-accent) text-(--renki-accent-fg) shadow-(--renki-shadow-xs)"
            title="Home"
          >
            <RenkiMark className="h-3.5 w-3.5" />
          </button>
          {/* The wordmark doubles as a switcher between stored daemons — not
              meaningful for a VS Code-managed connection, which belongs to
              the workspace's own settings rather than a switchable list. */}
          {managed ? (
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-(--renki-fg)">Renki</span>
          ) : (
            <HostSwitcher />
          )}
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
        <div className="flex shrink-0 items-center gap-0.5 border-t border-(--renki-border) p-2">
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

const SIDEBAR_KEY = "renki.sidebar.open";
const SIDEBAR_WIDTH_KEY = "renki.sidebar.width";
/** The collapsed rail: wide enough for one 32px button with breathing room. */
const SIDEBAR_RAIL = 48;
const SIDEBAR_DEFAULT = 288;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
/**
 * Drag narrower than this and the sidebar collapses instead of shrinking.
 * Comfortably below SIDEBAR_MIN so the collapse reads as a deliberate shove
 * past the end rather than something that happens while you're still adjusting.
 */
const SIDEBAR_COLLAPSE_AT = 140;

function clampSidebarWidth(px: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
}

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

function loadSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

/**
 * The sidebar's draggable edge.
 *
 * Invisible until you approach it — a permanent divider line on a UI whose
 * hierarchy comes from tone would be a piece of furniture you can't use for
 * anything else. The hit area straddles the border and is wider than the line
 * it draws, because a 1px target is a target you miss.
 */
function ResizeHandle({
  width,
  onPointerDown,
  onKeyDown,
  onDoubleClick,
}: {
  width: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_RAIL}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      title="Drag to resize · drag left to collapse · double-click to reset"
      className="group absolute top-0 -right-1 z-30 h-full w-2 cursor-col-resize focus-visible:outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-(--renki-accent) opacity-0 transition-opacity duration-150 group-hover:opacity-70 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  );
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
    <main className="flex min-h-0 flex-col overflow-hidden bg-(--renki-bg)">
      {lastError && (
        <div className="flex items-center gap-1.5 border-b border-(--renki-danger)/30 bg-(--renki-danger)/10 px-4 py-1.5 text-xs text-(--renki-danger)">
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
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-(--renki-hover) hover:text-(--renki-fg) ${
        active ? "bg-(--renki-hover) text-(--renki-fg)" : "text-(--renki-fg-muted)"
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
      ? { dot: "bg-(--renki-warning) animate-pulse", tone: "text-(--renki-warning)", label: "Connecting…" }
      : { dot: "bg-(--renki-danger)", tone: "text-(--renki-danger)", label: "Offline — retrying" };
  return (
    <span className={`inline-flex h-8 items-center gap-1.5 px-2 text-xs font-medium ${s.tone}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
