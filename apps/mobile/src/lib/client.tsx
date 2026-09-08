import { RealtimeClient, RestClient, type Store } from "@renki/client-core";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AppConfig } from "./config";

/**
 * React Native glue around client-core — the mirror of the web app's client.tsx.
 * client-core is entirely reused (WebSocket + fetch exist in RN too); only this
 * thin provider + the RN views are platform-specific.
 */
type Bundle = { rest: RestClient; realtime: RealtimeClient; config: AppConfig };

const Ctx = createContext<Bundle | null>(null);

export function ClientProvider({ config, children }: { config: AppConfig; children: React.ReactNode }) {
  const bundle = useMemo<Bundle>(
    () => ({
      rest: new RestClient({ baseUrl: config.baseUrl, token: config.token }),
      realtime: new RealtimeClient({
        baseUrl: config.baseUrl,
        token: config.token,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
      }),
      config,
    }),
    [config],
  );

  useEffect(() => {
    bundle.realtime.connect();
    return () => bundle.realtime.close();
  }, [bundle]);

  return <Ctx.Provider value={bundle}>{children}</Ctx.Provider>;
}

export function useClient(): Bundle {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useClient must be used within ClientProvider");
  return ctx;
}

export function useStoreValue<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
