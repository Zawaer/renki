import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { type AppConfig, clearConfig, loadConfig, saveConfig } from "./lib/config";
import { migrateLegacyStorage } from "./lib/storageMigration";
import { ClientProvider } from "./lib/client";
import { registerForPush } from "./lib/push";
import { Setup } from "./screens/Setup";
import { Settings } from "./screens/Settings";
import { SessionList } from "./screens/SessionList";
import { SessionView } from "./screens/SessionView";
import { StatsView } from "./screens/StatsView";
import { type ThemeColors, useTheme } from "./theme";

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
  return (
    <SafeAreaProvider>
      <AppBody />
    </SafeAreaProvider>
  );
}

function AppBody() {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    // Bring `crc.*` keys over before the first read, so the rename doesn't
    // un-pair this phone or lose its composer picks.
    migrateLegacyStorage()
      .then(loadConfig)
      .then((c) => {
        setConfig(c);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <View style={[styles.fill, styles.center]}>
        <StatusBar style="light" backgroundColor={colors.bg} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!config) {
    return (
      <>
        <StatusBar style="light" backgroundColor={colors.bg} />
        <Setup
          onSave={async (c) => {
            await saveConfig(c);
            setConfig(c);
          }}
        />
      </>
    );
  }

  return (
    <ClientProvider config={config}>
      <StatusBar style="light" backgroundColor={colors.bg} />
      <Main
        config={config}
        onReset={async () => {
          await clearConfig();
          setConfig(null);
        }}
        onReconnect={async (baseUrl) => {
          const next = { ...config, baseUrl };
          await saveConfig(next);
          setConfig(next);
        }}
        onRenameDevice={async (deviceName) => {
          const next = { ...config, deviceName };
          await saveConfig(next);
          setConfig(next);
        }}
      />
    </ClientProvider>
  );
}

function Main({
  config,
  onReset,
  onReconnect,
  onRenameDevice,
}: {
  config: AppConfig;
  onReset: () => void;
  onReconnect: (baseUrl: string) => Promise<void>;
  onRenameDevice: (name: string) => Promise<void>;
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
