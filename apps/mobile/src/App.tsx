import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from "react-native";
import { addHost, DEFAULT_PALETTE, emptyHostsState, removeHost, updateHost, type HostsState, type PaletteKey } from "@renki/client-core";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { type AppConfig, getOrCreateDeviceId } from "./lib/config";
import { loadHosts, saveHosts } from "./lib/hosts";
import { loadPalette } from "./lib/composerPrefs";
import { migrateLegacyStorage } from "./lib/storageMigration";
import { ClientProvider } from "./lib/client";
import { registerForPush } from "./lib/push";
import { Setup } from "./screens/Setup";
import { Settings } from "./screens/Settings";
import { SessionList } from "./screens/SessionList";
import { SessionView } from "./screens/SessionView";
import { StatsView } from "./screens/StatsView";
import { PaletteProvider, type ThemeColors, useTheme } from "./theme";

// Show notifications while the app is foregrounded too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // shouldShowAlert is the legacy field; banner/list are its newer split.
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export function App() {
  // The palette wraps everything, including the loading and Setup screens, so
  // there's no amber flash before a linen device's preference loads. It starts
  // at the default and swaps once SecureStore answers — a read too fast to see
  // on the loading spinner, and the only alternative is blocking first paint
  // on the keychain.
  const [palette, setPalette] = useState<PaletteKey>(DEFAULT_PALETTE);
  useEffect(() => {
    let live = true;
    loadPalette().then((p) => {
      if (live) setPalette(p);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <PaletteProvider value={palette}>
      <SafeAreaProvider>
        <AppBody onPaletteChange={setPalette} />
      </SafeAreaProvider>
    </PaletteProvider>
  );
}

function AppBody({ onPaletteChange }: { onPaletteChange: (p: PaletteKey) => void }) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [hostsState, setHostsState] = useState<HostsState>(emptyHostsState());
  const [deviceId, setDeviceId] = useState("");

  useEffect(() => {
    // Bring `crc.*` keys over before the first read, so the rename doesn't
    // un-pair this phone or lose its composer picks. deviceId is loaded once
    // here alongside the host list — it's shared across every host (see
    // hosts.ts in client-core), not part of any one host record.
    migrateLegacyStorage()
      .then(() => Promise.all([loadHosts(), getOrCreateDeviceId()]))
      .then(([state, id]) => {
        setHostsState(state);
        setDeviceId(id);
        setLoading(false);
      });
  }, []);

  /** Every host mutation (switch, add, rename, remove) goes through here: write, then update the state that drives everything downstream — no reload, this is React Native. */
  function persist(next: HostsState): void {
    setHostsState(next);
    void saveHosts(next);
  }

  if (loading) {
    return (
      <View style={[styles.fill, styles.center]}>
        <StatusBar style="light" backgroundColor={colors.bg} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const active = hostsState.hosts.find((h) => h.id === hostsState.activeId) ?? null;

  if (!active) {
    return (
      <>
        <StatusBar style="light" backgroundColor={colors.bg} />
        <Setup
          onSave={(c, label) => {
            persist(addHost(hostsState, { label: label || "Home", baseUrl: c.baseUrl, token: c.token, deviceName: c.deviceName }));
          }}
        />
      </>
    );
  }

  return (
    <AppBodyConnected
      colors={colors}
      hostsState={hostsState}
      active={active}
      deviceId={deviceId}
      onHostsChange={persist}
      onPaletteChange={onPaletteChange}
    />
  );
}

/**
 * Split out so `config` can be memoized on the primitive fields that matter
 * (baseUrl/token/deviceId/deviceName/hostId) rather than recomputed as a new
 * object every render — `ClientProvider` reconstructs its RestClient and
 * RealtimeClient, and reconnects the socket, whenever `config`'s identity
 * changes, so an unmemoized object literal here would reconnect on every
 * unrelated re-render of the tree above it (a session selected, a palette
 * flipped, anything).
 */
function AppBodyConnected({
  colors,
  hostsState,
  active,
  deviceId,
  onHostsChange,
  onPaletteChange,
}: {
  colors: ThemeColors;
  hostsState: HostsState;
  active: HostsState["hosts"][number];
  deviceId: string;
  onHostsChange: (next: HostsState) => void;
  onPaletteChange: (palette: PaletteKey) => void;
}) {
  const config = useMemo<AppConfig>(
    () => ({ baseUrl: active.baseUrl, token: active.token, deviceId, deviceName: active.deviceName, hostId: active.id }),
    [active.baseUrl, active.token, deviceId, active.deviceName, active.id],
  );

  return (
    <ClientProvider config={config}>
      <StatusBar style="light" backgroundColor={colors.bg} />
      <Main
        config={config}
        hostsState={hostsState}
        onHostsChange={onHostsChange}
        onReset={() => onHostsChange(removeHost(hostsState, active.id))}
        onReconnect={async (baseUrl) => {
          onHostsChange(updateHost(hostsState, active.id, { baseUrl }));
        }}
        onRenameDevice={async (deviceName) => {
          onHostsChange(updateHost(hostsState, active.id, { deviceName }));
        }}
        onPaletteChange={onPaletteChange}
      />
    </ClientProvider>
  );
}

function Main({
  config,
  hostsState,
  onHostsChange,
  onReset,
  onReconnect,
  onRenameDevice,
  onPaletteChange,
}: {
  config: AppConfig;
  hostsState: HostsState;
  onHostsChange: (next: HostsState) => void;
  onReset: () => void;
  onReconnect: (baseUrl: string) => Promise<void>;
  onRenameDevice: (name: string) => Promise<void>;
  onPaletteChange: (palette: PaletteKey) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const selectedRef = useRef(setSelected);
  selectedRef.current = setSelected;

  // Android hardware/gesture back should step back through this screen stack
  // (session -> settings/stats -> session list) instead of exiting the app —
  // there's no navigation library here, just this state, so it needs its own
  // handler. Modals/bottom sheets (model picker, attach menu, etc.) aren't
  // handled here: Android delivers back to the topmost native Dialog a Modal
  // renders as before it ever reaches this JS handler, so `onRequestClose`
  // (already wired on every Modal) closes those first, on its own.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selected) {
        setSelected(null);
        return true;
      }
      if (showSettings) {
        setShowSettings(false);
        return true;
      }
      if (showStats) {
        setShowStats(false);
        return true;
      }
      return false; // at the root session list — let Android exit/minimize as normal
    });
    return () => sub.remove();
  }, [selected, showSettings, showStats]);

  // Register for push, and when a notification is tapped, open its session.
  useEffect(() => {
    void registerForPush(config);
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const sessionId = res.notification.request.content.data?.sessionId;
      if (typeof sessionId === "string") selectedRef.current(sessionId);
    });
    return () => sub.remove();
  }, [config]);

  if (selected) {
    return <SessionView sessionId={selected} onBack={() => setSelected(null)} />;
  }
  if (showSettings) {
    return (
      <Settings
        onBack={() => setShowSettings(false)}
        onReset={onReset}
        onReconnect={onReconnect}
        onRenameDevice={onRenameDevice}
        onPaletteChange={onPaletteChange}
        hostsState={hostsState}
        onHostsChange={onHostsChange}
      />
    );
  }
  if (showStats) {
    return <StatsView onBack={() => setShowStats(false)} />;
  }
  return (
    <SessionList
      onSelect={setSelected}
      onOpenSettings={() => setShowSettings(true)}
      onOpenStats={() => setShowStats(true)}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    center: { alignItems: "center", justifyContent: "center" },
  });
