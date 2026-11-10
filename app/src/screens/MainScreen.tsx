import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import { LiveAudio } from '../../modules/live-audio';
import { toTaiwanese } from '../chinese';
import { Entry, Interpreter, Speaker } from '../interpreter';
import { colors } from '../theme';

type Props = {
  interp: Interpreter;
  listenOnly: boolean;
  totalSpentUsd: number;
  onOpenSettings: () => void;
};

export function MainScreen({ interp, listenOnly, totalSpentUsd, onOpenSettings }: Props) {
  const s = useSyncExternalStore(interp.subscribe, () => interp.state);
  const [output, setOutput] = useState(() => routeName(LiveAudio.getCurrentRoute().outputs));
  const scroll = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    const sub = LiveAudio.addListener('onRouteChange', (e) => setOutput(routeName(e.route.outputs)));
    return () => sub.remove();
  }, []);

  const on = s.status === 'on';
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>LiveInterpreter</Text>
          <Text style={styles.sub}>
            {on ? '● Connected' : s.status === 'starting' ? 'Connecting…' : 'Off'} · {output}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.cost}>${s.costUsd.toFixed(3)}</Text>
          <Text style={styles.sub}>{Math.round(s.sentSeconds)} s sent · total ${(totalSpentUsd + s.costUsd).toFixed(2)}</Text>
        </View>
        <Pressable onPress={onOpenSettings} hitSlop={12} style={styles.gear}>
          <Text style={{ fontSize: 24 }}>⚙️</Text>
        </Pressable>
      </View>

      {s.error && (
        <Pressable style={styles.error} onPress={() => interp.dismissError()}>
          <Text style={styles.errorText}>{s.error}</Text>
        </Pressable>
      )}

      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={styles.transcript}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {s.entries.length === 0 && (
          <Text style={styles.hint}>
            {on
              ? 'Tap THEM when they speak Mandarin: you hear English in your AirPods.\nTap ME when you speak English: the phone says it in Mandarin.\nTap again to stop.'
              : 'Press Start to connect.'}
          </Text>
        )}
        {s.entries.map((e) => (
          <Bubble key={e.id} entry={e} live={s.turn === e.who && e === s.entries.filter((x) => x.who === e.who).at(-1)} />
        ))}
      </ScrollView>

      {on && (
        <View style={styles.meterTrack}>
          <View
            style={[
              styles.meterFill,
              { width: `${Math.max(0, Math.min(1, (s.micDb + 60) / 60)) * 100}%`, backgroundColor: s.micMuted ? colors.warn : colors.ok },
            ]}
          />
        </View>
      )}
      {on && s.micMuted && <Text style={styles.muted}>Mic muted while the speaker plays</Text>}

      <View style={styles.controls}>
        {!on ? (
          <Pressable
            style={[styles.start, s.status === 'starting' && { opacity: 0.6 }]}
            disabled={s.status === 'starting'}
            onPress={() => interp.start()}
          >
            <Text style={styles.startText}>{s.status === 'starting' ? 'Connecting…' : 'Start'}</Text>
          </Pressable>
        ) : (
          <>
            <View style={styles.row}>
              <TalkButton who="them" s={s} onPress={() => interp.toggle('them')} label="THEM" lang="中文 → 🎧 English" />
              <TalkButton
                who="me"
                s={s}
                onPress={() => interp.toggle('me')}
                label="ME"
                lang={listenOnly ? 'English → text only' : 'English → 🔊 中文'}
              />
            </View>
            <View style={styles.row}>
              <Pressable onPress={() => interp.clearTranscript()} hitSlop={10}>
                <Text style={styles.link}>Clear</Text>
              </Pressable>
              <Pressable onPress={() => interp.stop()} hitSlop={10}>
                <Text style={[styles.link, { color: colors.danger }]}>Stop</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

function TalkButton({ who, s, onPress, label, lang }: { who: Speaker; s: Interpreter['state']; onPress: () => void; label: string; lang: string }) {
  const active = s.turn === who;
  const connecting = s.connecting === who;
  const base = who === 'them' ? colors.them : colors.me;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.talk,
        { backgroundColor: active ? colors.live : base, opacity: pressed ? 0.8 : 1, borderColor: active ? '#fff' : 'transparent' },
      ]}
    >
      <Text style={styles.talkLabel}>{active ? '● ' : ''}{label}</Text>
      <Text style={styles.talkLang}>{lang}</Text>
      <Text style={styles.talkHint}>{connecting ? 'reconnecting…' : active ? 'listening · tap to stop' : 'tap to talk'}</Text>
    </Pressable>
  );
}

function Bubble({ entry, live }: { entry: Entry; live: boolean }) {
  const them = entry.who === 'them';
  // Chinese is the original for THEM and the translation for ME: show it in Traditional, Taiwan wording.
  const original = them ? toTaiwanese(entry.original) : entry.original;
  const translation = them ? entry.translation : toTaiwanese(entry.translation);
  return (
    <View style={[styles.bubble, them ? styles.bubbleThem : styles.bubbleMe]}>
      <Text style={styles.bubbleWho}>{them ? 'THEM' : 'ME'}</Text>
      {!!original.trim() && <Text style={styles.original}>{original.trim()}</Text>}
      <Text style={[styles.translation, !them && styles.translationZh]}>
        {translation.trim() || (live ? 'listening…' : '…')}
      </Text>
    </View>
  );
}

function routeName(outputs: { name: string; type: string }[]): string {
  const o = outputs[0];
  if (!o) return 'no output';
  if (/Bluetooth/i.test(o.type)) return `🎧 ${o.name}`;
  if (o.type === 'Speaker') return '🔊 iPhone speaker';
  if (o.type === 'Receiver') return '📱 earpiece (no headphones)';
  return o.name;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 54 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10, gap: 10 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  sub: { color: colors.dim, fontSize: 12, marginTop: 2 },
  cost: { color: colors.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  gear: { paddingLeft: 4 },
  error: { backgroundColor: '#7f1d1d', marginHorizontal: 16, borderRadius: 10, padding: 10 },
  errorText: { color: '#fff', fontSize: 14 },
  transcript: { padding: 16, gap: 10 },
  hint: { color: colors.dim, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 40 },
  bubble: { borderRadius: 14, padding: 12, maxWidth: '88%' },
  bubbleThem: { backgroundColor: colors.card, alignSelf: 'flex-start' },
  bubbleMe: { backgroundColor: '#1e3a8a', alignSelf: 'flex-end' },
  bubbleWho: { color: colors.dim, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  original: { color: '#a1a1aa', fontSize: 14, marginBottom: 6 },
  translation: { color: colors.text, fontSize: 18, lineHeight: 25 },
  translationZh: { fontSize: 22, lineHeight: 31 },
  meterTrack: { height: 4, backgroundColor: '#27272a', marginHorizontal: 16 },
  meterFill: { height: '100%' },
  muted: { color: colors.warn, fontSize: 12, textAlign: 'center', marginTop: 4 },
  controls: { padding: 16, paddingBottom: 34, gap: 12 },
  row: { flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  start: { backgroundColor: colors.ok, borderRadius: 18, paddingVertical: 26, alignItems: 'center' },
  startText: { color: '#04210f', fontSize: 24, fontWeight: '800' },
  talk: { flex: 1, borderRadius: 18, paddingVertical: 22, paddingHorizontal: 12, alignItems: 'center', borderWidth: 3 },
  talkLabel: { color: '#fff', fontSize: 26, fontWeight: '800' },
  talkLang: { color: '#e5e7eb', fontSize: 14, marginTop: 4 },
  talkHint: { color: '#d4d4d8', fontSize: 12, marginTop: 6 },
  link: { color: colors.dim, fontSize: 15, paddingHorizontal: 8 },
});
