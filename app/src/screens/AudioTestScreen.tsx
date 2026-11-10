import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AudioRoute, LiveAudio, PlaybackState, toneChunks } from '../../modules/live-audio';

// Audio test screen (from Phase 2): proves routing (AirPods vs speaker) and mic capture before any AI.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AudioTestScreen({ onBack }: { onBack: () => void }) {
  const [route, setRoute] = useState<AudioRoute>(() => LiveAudio.getCurrentRoute());
  const [playback, setPlayback] = useState<PlaybackState>({ headphones: false, speaker: false, speakerMode: 'off' });
  const [micOn, setMicOn] = useState(false);
  const [level, setLevel] = useState({ db: -160, gated: false });
  const [chunks, setChunks] = useState(0);
  const [recording, setRecording] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const recordBuf = useRef<string[] | null>(null);

  const add = useCallback((line: string) => {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    setLog((l) => [`${t}  ${line}`, ...l].slice(0, 14));
  }, []);

  useEffect(() => {
    const subs = [
      LiveAudio.addListener('onRouteChange', (e) => {
        setRoute(e.route);
        add(`route: ${e.reason} → ${e.route.outputs.map((o) => o.name).join(', ')}`);
      }),
      LiveAudio.addListener('onPlaybackState', setPlayback),
      LiveAudio.addListener('onMicLevel', setLevel),
      LiveAudio.addListener('onAudioChunk', (e) => {
        setChunks((n) => n + 1);
        recordBuf.current?.push(e.data);
      }),
      LiveAudio.addListener('onError', (e) => add(`ERROR: ${e.message}`)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [add]);

  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    try {
      add(label);
      await fn();
      setRoute(LiveAudio.getCurrentRoute());
    } catch (e: any) {
      add(`ERROR (${label}): ${e?.message ?? e}`);
    }
  };

  const tone = (target: 'headphones' | 'speaker', hz: number, ms: number) =>
    Promise.all(toneChunks(hz, ms).map((c) => LiveAudio.playAudio(c, target)));

  const toggleMic = run(micOn ? 'mic off' : 'mic on', async () => {
    if (micOn) {
      await LiveAudio.stop();
      setMicOn(false);
      return;
    }
    const ok = await LiveAudio.requestPermission();
    if (!ok) throw new Error('Microphone permission denied (Settings → LiveInterpreter → Microphone)');
    await LiveAudio.start();
    setMicOn(true);
  });

  const recordAndPlay = run('record 3 s, then play in AirPods', async () => {
    if (!micOn) throw new Error('Turn the mic on first');
    recordBuf.current = [];
    setRecording(true);
    await sleep(3000);
    const recorded = recordBuf.current;
    recordBuf.current = null;
    setRecording(false);
    add(`recorded ${recorded.length} chunks (${recorded.length * 200} ms), playing back`);
    await Promise.all(recorded.map((c) => LiveAudio.playAudio(c, 'headphones')));
  });

  const meter = Math.max(0, Math.min(1, (level.db + 60) / 60));
  const outputs = route.outputs.map((o) => `${o.name} (${o.type})`).join(', ') || '—';
  const inputs = route.inputs.map((o) => `${o.name} (${o.type})`).join(', ') || '— (mic not started)';

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={async () => { await LiveAudio.stop(); onBack(); }} hitSlop={12}>
          <Text style={{ color: '#60a5fa', fontSize: 17 }}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Audio test</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Output</Text>
          <Text style={styles.text}>{outputs}</Text>
          <Text style={styles.label}>Input</Text>
          <Text style={styles.text}>{inputs}</Text>
          <Text style={styles.small}>
            speaker mode: {playback.speakerMode} · 🎧 {playback.headphones ? 'playing' : 'idle'} · 🔊 {playback.speaker ? 'playing' : 'idle'}
            {route.sampleRate ? ` · ${route.sampleRate} Hz` : ''}
          </Text>
        </View>

        <Text style={styles.section}>1. Output routing</Text>
        <Btn label="🎧  Tone → AirPods" onPress={run('tone → AirPods', () => tone('headphones', 440, 1000))} />
        <Btn label="🔊  Tone → speaker" onPress={run('tone → speaker', () => tone('speaker', 660, 1000))} />
        <Btn
          label="🔁  Switch test: AirPods → speaker → AirPods"
          onPress={run('switch test', async () => {
            await tone('headphones', 440, 800);
            await sleep(1100);
            await tone('speaker', 660, 800);
            await sleep(2000);
            await tone('headphones', 440, 800);
          })}
        />
        <Btn
          label="⏸  Overlap test: speaker interrupts AirPods"
          onPress={run('overlap test', async () => {
            await tone('headphones', 330, 3000);
            await sleep(1000);
            await tone('speaker', 880, 1000);
          })}
        />

        <Text style={styles.section}>2. Microphone</Text>
        <Btn label={micOn ? '⏹  Stop mic' : '🎙  Start mic'} onPress={toggleMic} />
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${meter * 100}%`, backgroundColor: level.gated ? '#f59e0b' : '#22c55e' }]} />
        </View>
        <Text style={styles.small}>
          {micOn ? `${level.db.toFixed(0)} dB · chunks sent: ${chunks}${level.gated ? ' · MUTED (speaker playing)' : ''}` : 'mic off'}
        </Text>
        <Btn label={recording ? '⏺  Recording…' : '⏺  Record 3 s → play in AirPods'} onPress={recordAndPlay} />
        <Btn
          label="🔇  Feedback test: speaker tone with mic on"
          onPress={run('feedback test', async () => {
            if (!micOn) throw new Error('Turn the mic on first');
            await tone('speaker', 660, 1500);
          })}
        />

        <Btn label="🛑  Stop everything" color="#7f1d1d" onPress={run('stop all', async () => { await LiveAudio.stop(); setMicOn(false); })} />

        <Text style={styles.section}>Log</Text>
        {log.map((l, i) => (
          <Text key={i} style={styles.log}>{l}</Text>
        ))}
      </ScrollView>
    </View>
  );
}

function Btn({ label, onPress, color = '#1e3a8a' }: { label: string; onPress: () => void; color?: string }) {
  return (
    <Pressable style={({ pressed }) => [styles.btn, { backgroundColor: color, opacity: pressed ? 0.7 : 1 }]} onPress={onPress}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0b0f", paddingTop: 54 },
  content: { padding: 16, gap: 10, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 8 },
  section: { color: '#93c5fd', fontSize: 15, fontWeight: '700', marginTop: 12 },
  card: { backgroundColor: '#18181f', borderRadius: 12, padding: 12, gap: 2 },
  label: { color: '#9ca3af', fontSize: 12, marginTop: 4 },
  text: { color: '#e5e7eb', fontSize: 15 },
  small: { color: '#9ca3af', fontSize: 12, marginTop: 4 },
  btn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 14 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  meterTrack: { height: 14, backgroundColor: '#27272a', borderRadius: 7, overflow: 'hidden' },
  meterFill: { height: '100%' },
  log: { color: '#a1a1aa', fontSize: 11, fontFamily: 'Menlo' },
});
