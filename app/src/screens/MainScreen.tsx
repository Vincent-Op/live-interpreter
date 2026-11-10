import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LiveAudio } from '../../modules/live-audio';
import { Entry, Interpreter, Speaker } from '../interpreter';
import { colors, radius } from '../theme';
import { Banner } from '../ui/Banner';
import { displayTexts, EntryCard } from '../ui/EntryCard';
import { ShowModal } from '../ui/ShowModal';
import { TalkButton } from '../ui/TalkButton';

type Props = {
  interp: Interpreter;
  listenOnly: boolean;
  totalSpentUsd: number;
  onOpenSettings: () => void;
};

type Route = { icon: keyof typeof Ionicons.glyphMap; label: string };

export function MainScreen({ interp, listenOnly, totalSpentUsd, onOpenSettings }: Props) {
  const s = useSyncExternalStore(interp.subscribe, () => interp.state);
  const insets = useSafeAreaInsets();
  const [route, setRoute] = useState<Route>(() => describeRoute(LiveAudio.getCurrentRoute()));
  const [shown, setShown] = useState<Entry | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    const sub = LiveAudio.addListener('onRouteChange', (e) => setRoute(describeRoute(e.route)));
    return () => sub.remove();
  }, []);

  const on = s.status === 'on';
  const tap = (who: Speaker) => {
    Haptics.impactAsync(s.turn === who ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    void interp.toggle(who);
  };
  const statusOf = (who: Speaker) => {
    if (s.connecting === who) return 'Connecting…';
    if (s.turn === who) return who === 'me' && !listenOnly ? 'Listening · speaks when you stop' : 'Listening · tap to stop';
    if (who === 'me' && s.speaking) return 'Speaking…';
    return 'Tap to talk';
  };
  const shownTexts = shown ? displayTexts(shown) : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 6 }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={styles.title}>LiveInterpreter</Text>
          <View style={styles.chips}>
            <Chip
              icon="ellipse"
              iconColor={on ? colors.ok : s.status === 'starting' ? colors.warn : colors.faint}
              label={on ? 'Live' : s.status === 'starting' ? 'Connecting' : 'Offline'}
            />
            <Chip icon={route.icon} label={route.label} />
            {on && s.micMuted && <Chip icon="mic-off" iconColor={colors.warn} label="Mic paused" />}
          </View>
        </View>
        <View style={styles.costBox}>
          <Text style={styles.cost}>${s.costUsd.toFixed(3)}</Text>
          <Text style={styles.costSub}>total ${(totalSpentUsd + s.costUsd).toFixed(2)}</Text>
        </View>
        <Pressable onPress={onOpenSettings} hitSlop={12} style={styles.iconBtn}>
          <Ionicons name="settings-outline" size={22} color={colors.text} />
        </Pressable>
      </View>

      {s.error && <Banner kind="error" text={s.error} onDismiss={() => interp.dismissError()} />}
      {!s.error && s.notice && (
        <Banner
          kind="notice"
          text={s.notice}
          actionLabel={s.needsResume ? 'Resume' : undefined}
          onAction={() => interp.resumeAudio()}
          onDismiss={() => interp.dismissError()}
        />
      )}

      {/* Conversation */}
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={styles.transcript}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {s.entries.length === 0 ? (
          <Empty on={on} listenOnly={listenOnly} />
        ) : (
          s.entries.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              live={s.turn === e.who && e === s.entries.filter((x) => x.who === e.who).at(-1)}
              onPress={() => setShown(e)}
            />
          ))
        )}
      </ScrollView>

      {/* Controls */}
      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        {!on ? (
          <Pressable
            style={({ pressed }) => [styles.start, { opacity: s.status === 'starting' ? 0.6 : pressed ? 0.85 : 1 }]}
            disabled={s.status === 'starting'}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              void interp.start();
            }}
          >
            <Ionicons name={s.status === 'starting' ? 'hourglass-outline' : 'play'} size={22} color="#052e16" />
            <Text style={styles.startText}>{s.status === 'starting' ? 'Connecting…' : 'Start interpreting'}</Text>
          </Pressable>
        ) : (
          <>
            <View style={styles.meterTrack}>
              <View
                style={[
                  styles.meterFill,
                  {
                    width: `${s.turn ? Math.max(0, Math.min(1, (s.micDb + 60) / 55)) * 100 : 0}%`,
                    backgroundColor: s.micMuted ? colors.warn : s.turn === 'me' ? colors.me : colors.them,
                  },
                ]}
              />
            </View>
            <View style={styles.row}>
              <TalkButton
                title="THEM"
                from="中文"
                to="AirPods"
                icon="ear-outline"
                color={colors.them}
                active={s.turn === 'them'}
                status={statusOf('them')}
                onPress={() => tap('them')}
              />
              <TalkButton
                title="ME"
                from="English"
                to={listenOnly ? 'Text' : 'Speaker'}
                icon="mic-outline"
                color={colors.me}
                active={s.turn === 'me'}
                status={statusOf('me')}
                onPress={() => tap('me')}
              />
            </View>
            <View style={styles.footer}>
              <Pressable onPress={() => interp.clearTranscript()} hitSlop={10} style={styles.footerBtn}>
                <Ionicons name="trash-outline" size={15} color={colors.muted} />
                <Text style={styles.footerText}>Clear</Text>
              </Pressable>
              <Text style={styles.footerMid}>{Math.round(s.sentSeconds)} s of audio sent</Text>
              <Pressable onPress={() => interp.stop()} hitSlop={10} style={styles.footerBtn}>
                <Ionicons name="power" size={15} color={colors.danger} />
                <Text style={[styles.footerText, { color: colors.danger }]}>Stop</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>

      <ShowModal
        text={shownTexts ? shownTexts.translation : null}
        sub={shownTexts?.original || undefined}
        onClose={() => setShown(null)}
      />
    </View>
  );
}

function Empty({ on, listenOnly }: { on: boolean; listenOnly: boolean }) {
  const steps: [keyof typeof Ionicons.glyphMap, string, string][] = [
    ['ear-outline', 'THEM', 'Tap when they speak Mandarin. You hear English in your AirPods.'],
    ['mic-outline', 'ME', listenOnly ? 'Tap and speak English. The Mandarin appears as text.' : 'Tap and speak English. When you tap again, the phone says it in Mandarin.'],
    ['expand-outline', 'SHOW', 'Tap any message to show it full screen.'],
  ];
  return (
    <View style={styles.empty}>
      <Ionicons name="chatbubbles-outline" size={42} color={colors.faint} />
      <Text style={styles.emptyTitle}>{on ? 'Ready when you are' : 'Live Mandarin ↔ English'}</Text>
      <View style={{ gap: 14, marginTop: 8 }}>
        {steps.map(([icon, label, text]) => (
          <View key={label} style={styles.step}>
            <View style={styles.stepIcon}>
              <Ionicons name={icon} size={18} color={colors.text} />
            </View>
            <Text style={styles.stepText}>
              <Text style={{ fontWeight: '700', color: colors.text }}>{label} </Text>
              {text}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Chip({ icon, label, iconColor = colors.muted }: { icon: keyof typeof Ionicons.glyphMap; label: string; iconColor?: string }) {
  return (
    <View style={styles.chip}>
      <Ionicons name={icon} size={icon === 'ellipse' ? 8 : 13} color={iconColor} />
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function describeRoute(route: { outputs: { name: string; type: string }[]; headphones?: boolean; speakerMode?: string }): Route {
  const o = route.outputs[0];
  if (route.speakerMode && route.speakerMode !== 'off' && route.headphones) return { icon: 'headset-outline', label: 'AirPods + speaker' };
  if (!o) return { icon: 'alert-circle-outline', label: 'No output' };
  if (/Bluetooth/i.test(o.type)) return { icon: 'headset-outline', label: o.name };
  if (o.type === 'Speaker') return { icon: 'volume-high-outline', label: 'Speaker' };
  if (o.type === 'Receiver') return { icon: 'phone-portrait-outline', label: 'No AirPods' };
  return { icon: 'headset-outline', label: o.name };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingBottom: 12, gap: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: 170,
  },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  costBox: { alignItems: 'flex-end', paddingTop: 2 },
  cost: { color: colors.text, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  costSub: { color: colors.faint, fontSize: 11, marginTop: 2, fontVariant: ['tabular-nums'] },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transcript: { paddingHorizontal: 16, paddingVertical: 8, gap: 10, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 8 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1, color: colors.muted, fontSize: 14, lineHeight: 20 },
  dock: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  meterTrack: { height: 3, backgroundColor: colors.surface2, borderRadius: 2, overflow: 'hidden' },
  meterFill: { height: '100%' },
  row: { flexDirection: 'row', gap: 12 },
  start: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.ok,
    borderRadius: radius.xl,
    paddingVertical: 22,
  },
  startText: { color: '#052e16', fontSize: 20, fontWeight: '800' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 4 },
  footerText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  footerMid: { color: colors.faint, fontSize: 12 },
});
