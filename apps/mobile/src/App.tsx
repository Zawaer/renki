import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { type AppConfig, clearConfig, loadConfig, saveConfig } from "./lib/config";
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
  const colors = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    loadConfig().then((c) => {
      setConfig(c);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <View style={[styles.fill, styles.center]}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!config) {
    return (
      <>
        <StatusBar style="light" />
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
      <StatusBar style="light" />
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
