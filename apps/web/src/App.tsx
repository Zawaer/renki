import { useState } from "react";
import { ClientProvider, useClient, useStoreValue } from "./lib/client.js";
import { type AppConfig, clearConfig, loadConfig, saveConfig } from "./lib/config.js";
import { SessionList } from "./components/SessionList.js";
import { SessionView } from "./components/SessionView.js";
import { Setup } from "./components/Setup.js";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(() => loadConfig());

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

  return (
    <ClientProvider config={config}>
      <Workspace
        onReset={() => {
          clearConfig();
          setConfig(null);
        }}
      />
    </ClientProvider>
  );
}

function Workspace({ onReset }: { onReset: () => void }) {
  const { realtime, config } = useClient();
  const status = useStoreValue(realtime.status);
  const lastError = useStoreValue(realtime.lastError);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-200">Claude Remote Control</span>
          <ConnBadge status={status} />
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span>{config.deviceName}</span>
          <button className="hover:text-neutral-300" onClick={onReset}>
            Disconnect
          </button>
        </div>
      </header>

      {lastError && (
        <div className="bg-red-950/40 px-4 py-1.5 text-xs text-red-300">
          {lastError.code}: {lastError.message}
        </div>
      )}

      <div className="grid flex-1 grid-cols-[280px_1fr] overflow-hidden">
        <aside className="border-r border-neutral-800">
          <SessionList selectedId={selected} onSelect={setSelected} />
        </aside>
        <main className="overflow-hidden">
          {selected ? (
            <SessionView key={selected} sessionId={selected} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-neutral-600">
              Select or create a session.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function ConnBadge({ status }: { status: "connecting" | "open" | "closed" }) {
  const map = {
    open: { color: "bg-emerald-500", label: "connected" },
    connecting: { color: "bg-amber-400 animate-pulse", label: "connecting" },
    closed: { color: "bg-red-500", label: "offline" },
  } as const;
  const s = map[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-500">
      <span className={`h-2 w-2 rounded-full ${s.color}`} />
      {s.label}
    </span>
  );
}
