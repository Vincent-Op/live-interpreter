import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { isAvailable, LiveAudio } from './modules/live-audio';
import { Interpreter } from './src/interpreter';
import { AudioTestScreen } from './src/screens/AudioTestScreen';
import { MainScreen } from './src/screens/MainScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AppSettings, loadSettings, saveSettings } from './src/settings';
import { colors } from './src/theme';
import type { SocketFactory, SocketLike } from './src/translator';

// React Native's WebSocket accepts headers as a third argument (the browser one doesn't).
const rnSocket: SocketFactory = (url, apiKey) =>
  new (WebSocket as any)(url, [], { headers: { Authorization: `Bearer ${apiKey}` } }) as SocketLike;

type Screen = 'main' | 'settings' | 'audioTest';

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [screen, setScreen] = useState<Screen>('main');
  const interp = useRef<Interpreter | null>(null);

  useEffect(() => {
    loadSettings().then((s) => {
      if (isAvailable) interp.current = new Interpreter(LiveAudio, rnSocket, s);
      setSettings(s);
      if (!s.apiKey) setScreen('settings');
    });
  }, []);

  if (!isAvailable) {
    return (
      <Centered>
        This JS needs a newer app build. Install the latest .ipa from GitHub Actions with Sideloadly.
      </Centered>
    );
  }
  if (!settings || !interp.current) return <Centered>Loading…</Centered>;

  const update = (s: AppSettings) => {
    setSettings(s);
    interp.current?.updateSettings(s);
    saveSettings(s).catch(() => {});
  };

  return (
    <>
      <StatusBar style="light" />
      <CostSaver interp={interp.current} settings={settings} onSave={update} />
      {screen === 'main' && (
        <MainScreen
          interp={interp.current}
          listenOnly={settings.listenOnly}
          totalSpentUsd={settings.totalSpentUsd}
          onOpenSettings={() => setScreen('settings')}
        />
      )}
      {screen === 'settings' && (
        <SettingsScreen
          settings={settings}
          running={interp.current.state.status !== 'off'}
          onChange={update}
          onBack={() => setScreen('main')}
          onOpenAudioTest={async () => {
            await interp.current?.stop();
            setScreen('audioTest');
          }}
        />
      )}
      {screen === 'audioTest' && <AudioTestScreen onBack={() => setScreen('settings')} />}
    </>
  );
}

/** Adds each turn's cost to the saved running total when the interpreter goes idle. */
function CostSaver({ interp, settings, onSave }: { interp: Interpreter; settings: AppSettings; onSave: (s: AppSettings) => void }) {
  const s = useSyncExternalStore(interp.subscribe, () => interp.state);
  const saved = useRef(0); // part of s.costUsd already added to the total
  useEffect(() => {
    if (s.turn !== null) return;
    const delta = s.costUsd - saved.current;
    if (delta > 0.0005) {
      saved.current = s.costUsd;
      onSave({ ...settings, totalSpentUsd: settings.totalSpentUsd + delta });
    }
  }, [s.turn, s.status, s.costUsd]);
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ color: colors.text, fontSize: 16, textAlign: 'center' }}>{children}</Text>
    </View>
  );
}
