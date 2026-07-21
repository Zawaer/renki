import { RealtimeClient, RestClient, type Store } from "@crc/client-core";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AppConfig } from "./config.js";

/**
 * React glue around client-core. The heavy lifting (WS, reconnect, replay,
 * reducer) lives in client-core; this file just makes a RealtimeClient +
 * RestClient available via context and exposes a hook to read any Store
 * reactively. This is the ONLY React-specific plumbing — the exact same
 * client-core stores get consumed by the React Native app later.
 */
export type ClientBundle = {
  rest: RestClient;
  realtime: RealtimeClient;
  config: AppConfig;
};

// Exported so tests can supply a stub bundle directly (a real RealtimeClient
// that's never .connect()-ed, seeded via its Store, works fine — no need to
// mock the class) without going through ClientProvider's real WS connection.
export const ClientContext = createContext<ClientBundle | null>(null);

export function ClientProvider({ config, children }: { config: AppConfig; children: React.ReactNode }) {
  const bundle = useMemo<ClientBundle>(() => {
    const rest = new RestClient({ baseUrl: config.baseUrl, token: config.token });
    const realtime = new RealtimeClient({
      baseUrl: config.baseUrl,
      token: config.token,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
    });
    return { rest, realtime, config };
  }, [config]);

  useEffect(() => {
    bundle.realtime.connect();
    return () => bundle.realtime.close();
  }, [bundle]);

  return <ClientContext.Provider value={bundle}>{children}</ClientContext.Provider>;
}

export function useClient(): ClientBundle {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error("useClient must be used inside <ClientProvider>");
  return ctx;
}

/** Subscribe a component to any client-core Store. */
export function useStoreValue<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
