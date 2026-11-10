import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TRANSCRIBE_USD_PER_MIN, TRANSLATE_USD_PER_MIN } from '../config';
import { AppSettings } from '../settings';
import { colors, radius } from '../theme';

type Props = {
  settings: AppSettings;
  running: boolean;
  onChange: (s: AppSettings) => void;
  onBack: () => void;
  onOpenAudioTest: () => void;
};

type IconName = keyof typeof Ionicons.glyphMap;

export function SettingsScreen({ settings, running, onChange, onBack, onOpenAudioTest }: Props) {
  const insets = useSafeAreaInsets();
  const [key, setKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  const set = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });
  const saveKey = () => {
    if (key.trim() !== settings.apiKey) set({ apiKey: key.trim() });
  };
  const keyOk = /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            saveKey();
            onBack();
          }}
          hitSlop={12}
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={22} color={colors.link} />
          <Text style={styles.backText}>Done</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
        <Section title="OpenAI">
          <Row icon="key-outline" tint="#F59E0B" title="API key" note="Stored in the iOS Keychain, on this phone only.">
            <View style={styles.keyRow}>
              <TextInput
                style={styles.input}
                value={key}
                onChangeText={setKey}
                onEndEditing={saveKey}
                placeholder="sk-…"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!showKey}
              />
              <Pressable onPress={() => setShowKey((v) => !v)} hitSlop={8} style={styles.eye}>
                <Ionicons name={showKey ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.muted} />
              </Pressable>
            </View>
            {!!key && !keyOk && <Text style={[styles.note, { color: colors.warn }]}>That doesn't look like an OpenAI key (sk-…).</Text>}
          </Row>
        </Section>

        <Section title="Volume">
          <VolumeRow icon="headset-outline" tint={colors.them} title="THEM → AirPods" value={settings.headphonesVolume} onChange={(v) => set({ headphonesVolume: v })} />
          <Divider />
          <VolumeRow icon="volume-high-outline" tint={colors.me} title="ME → speaker" value={settings.speakerVolume} onChange={(v) => set({ speakerVolume: v })} />
          <Text style={[styles.note, styles.pad]}>Relative to the phone's volume buttons.</Text>
        </Section>

        <Section title="Conversation">
          <ToggleRow
            icon="ear-outline"
            tint="#22C55E"
            title="Listen only"
            note="Never use the speaker. Your English is still translated to text."
            value={settings.listenOnly}
            onChange={(v) => set({ listenOnly: v })}
          />
          <Divider />
          <ToggleRow
            icon="headset"
            tint="#38BDF8"
            title="AirPods press"
            note="Press the AirPods stem once for THEM, twice for ME. Works only if iOS sends the press to this app."
            value={settings.airpodsPress}
            onChange={(v) => set({ airpodsPress: v })}
          />
          <Divider />
          <ToggleRow
            icon="document-text-outline"
            tint="#A78BFA"
            title="Show original text"
            note={`Also show what was said. Adds $${TRANSCRIBE_USD_PER_MIN}/min while talking.`}
            value={settings.showOriginal}
            onChange={(v) => set({ showOriginal: v })}
          />
          <Divider />
          <ToggleRow
            icon="pulse-outline"
            tint="#F472B6"
            title="Noise reduction"
            note="Filters street and restaurant noise for the phone's mic."
            value={settings.noiseReduction}
            onChange={(v) => set({ noiseReduction: v })}
          />
          {running && <Text style={[styles.note, styles.pad, { color: colors.warn }]}>Original text and noise reduction apply after the next Start.</Text>}
        </Section>

        <Section title="Cost">
          <Row icon="wallet-outline" tint="#22C55E" title={`Estimated total: $${settings.totalSpentUsd.toFixed(2)}`}>
            <Text style={styles.note}>
              You pay only while THEM or ME is on: ${TRANSLATE_USD_PER_MIN}/min
              {settings.showOriginal ? ` + $${TRANSCRIBE_USD_PER_MIN}/min for original text` : ''}. Waiting costs nothing. Exact charges:
              platform.openai.com/usage
            </Text>
            <Pressable onPress={() => set({ totalSpentUsd: 0 })} hitSlop={8}>
              <Text style={styles.link}>Reset total</Text>
            </Pressable>
          </Row>
        </Section>

        <Section title="Troubleshooting">
          <Pressable onPress={onOpenAudioTest}>
            <Row icon="flask-outline" tint="#94A3B8" title="Audio test" note="Tones to AirPods and speaker, mic meter. Stops the interpreter." chevron />
          </Pressable>
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  icon,
  tint,
  title,
  note,
  chevron,
  right,
  children,
}: {
  icon: IconName;
  tint: string;
  title: string;
  note?: string;
  chevron?: boolean;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={[styles.rowIcon, { backgroundColor: tint }]}>
          <Ionicons name={icon} size={16} color="#fff" />
        </View>
        <Text style={styles.rowTitle}>{title}</Text>
        {right}
        {chevron && <Ionicons name="chevron-forward" size={18} color={colors.faint} />}
      </View>
      {!!note && <Text style={[styles.note, styles.indent]}>{note}</Text>}
      {children && <View style={[styles.indent, { gap: 8 }]}>{children}</View>}
    </View>
  );
}

function ToggleRow(p: { icon: IconName; tint: string; title: string; note: string; value: boolean; onChange: (v: boolean) => void }) {
  return <Row icon={p.icon} tint={p.tint} title={p.title} note={p.note} right={<Switch value={p.value} onValueChange={p.onChange} />} />;
}

function VolumeRow({ icon, tint, title, value, onChange }: { icon: IconName; tint: string; title: string; value: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(value);
  return (
    <Row icon={icon} tint={tint} title={title} right={<Text style={styles.value}>{Math.round(v * 100)}%</Text>}>
      <Slider
        value={value}
        minimumValue={0}
        maximumValue={1}
        step={0.05}
        minimumTrackTintColor={tint}
        maximumTrackTintColor={colors.border}
        onValueChange={setV}
        onSlidingComplete={onChange}
      />
    </Row>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { flexDirection: 'row', alignItems: 'center', width: 70 },
  backText: { color: colors.link, fontSize: 17 },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  content: { padding: 16, gap: 22 },
  section: { color: colors.faint, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginLeft: 4 },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingVertical: 4 },
  row: { paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowIcon: { width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { flex: 1, color: colors.text, fontSize: 16 },
  indent: { marginLeft: 40 },
  pad: { paddingHorizontal: 14, paddingBottom: 10 },
  note: { color: colors.muted, fontSize: 12.5, lineHeight: 18 },
  value: { color: colors.muted, fontSize: 14, fontVariant: ['tabular-nums'] },
  keyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  input: { flex: 1, color: colors.text, fontSize: 15, padding: 12, fontFamily: 'Menlo' },
  eye: { paddingHorizontal: 12 },
  link: { color: colors.link, fontSize: 15 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 54 },
});
