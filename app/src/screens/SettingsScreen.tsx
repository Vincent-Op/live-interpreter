import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { TRANSCRIBE_USD_PER_MIN, TRANSLATE_USD_PER_MIN } from '../config';
import { AppSettings } from '../settings';
import { colors } from '../theme';

type Props = {
  settings: AppSettings;
  running: boolean;
  onChange: (s: AppSettings) => void;
  onBack: () => void;
  onOpenAudioTest: () => void;
};

export function SettingsScreen({ settings, running, onChange, onBack, onOpenAudioTest }: Props) {
  const [key, setKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  const set = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={() => { if (key !== settings.apiKey) set({ apiKey: key.trim() }); onBack(); }} hitSlop={12}>
          <Text style={styles.back}>‹ Done</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 60 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>OpenAI API key</Text>
        <View style={styles.card}>
          <TextInput
            style={styles.input}
            value={key}
            onChangeText={setKey}
            onEndEditing={() => set({ apiKey: key.trim() })}
            placeholder="sk-…"
            placeholderTextColor="#52525b"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!showKey}
          />
          <View style={styles.rowBetween}>
            <Text style={styles.note}>Stored in the iOS Keychain, on this phone only.</Text>
            <Pressable onPress={() => setShowKey((v) => !v)} hitSlop={8}>
              <Text style={styles.link}>{showKey ? 'Hide' : 'Show'}</Text>
            </Pressable>
          </View>
        </View>

        <Text style={styles.section}>Volume</Text>
        <View style={styles.card}>
          <Stepper label="THEM → AirPods (English)" value={settings.headphonesVolume} onChange={(v) => set({ headphonesVolume: v })} />
          <Stepper label="ME → speaker (中文)" value={settings.speakerVolume} onChange={(v) => set({ speakerVolume: v })} />
          <Text style={styles.note}>Also use the phone's volume buttons; this sets each side relative to that.</Text>
        </View>

        <Text style={styles.section}>Options</Text>
        <View style={styles.card}>
          <Toggle
            label="Listen only"
            note="Never use the speaker. Your English is still translated to text on screen."
            value={settings.listenOnly}
            onChange={(v) => set({ listenOnly: v })}
          />
          <Toggle
            label="Show original text"
            note={`Also show what was said (中文 / English). Adds $${TRANSCRIBE_USD_PER_MIN}/min while talking.`}
            value={settings.showOriginal}
            onChange={(v) => set({ showOriginal: v })}
          />
          <Toggle
            label="Noise reduction"
            note="Filters background noise (street, restaurant) for the phone's mic."
            value={settings.noiseReduction}
            onChange={(v) => set({ noiseReduction: v })}
          />
          {running && <Text style={[styles.note, { color: colors.warn }]}>Original text and noise reduction apply the next time you press Start.</Text>}
        </View>

        <Text style={styles.section}>Cost</Text>
        <View style={styles.card}>
          <Text style={styles.text}>Estimated total so far: ${settings.totalSpentUsd.toFixed(2)}</Text>
          <Text style={styles.note}>
            You pay only while a button is on: ${TRANSLATE_USD_PER_MIN}/min of talking
            {settings.showOriginal ? ` + $${TRANSCRIBE_USD_PER_MIN}/min for original text` : ''}. Waiting costs nothing. Check exact
            charges at platform.openai.com/usage.
          </Text>
          <Pressable onPress={() => set({ totalSpentUsd: 0 })} hitSlop={8}>
            <Text style={styles.link}>Reset total</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>Troubleshooting</Text>
        <Pressable style={styles.card} onPress={onOpenAudioTest}>
          <Text style={styles.text}>Audio test screen ›</Text>
          <Text style={styles.note}>Tones to AirPods / speaker and a mic meter. Stops the interpreter.</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const pct = Math.round(value * 100);
  const step = (d: number) => onChange(Math.max(0, Math.min(1, Math.round((value + d) * 10) / 10)));
  return (
    <View style={styles.rowBetween}>
      <Text style={[styles.text, { flex: 1 }]}>{label}</Text>
      <Pressable style={styles.stepBtn} onPress={() => step(-0.1)}>
        <Text style={styles.stepText}>−</Text>
      </Pressable>
      <Text style={[styles.text, { width: 52, textAlign: 'center' }]}>{pct}%</Text>
      <Pressable style={styles.stepBtn} onPress={() => step(0.1)}>
        <Text style={styles.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

function Toggle({ label, note, value, onChange }: { label: string; note: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ gap: 2 }}>
      <View style={styles.rowBetween}>
        <Text style={styles.text}>{label}</Text>
        <Switch value={value} onValueChange={onChange} />
      </View>
      <Text style={styles.note}>{note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 54 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  back: { color: '#60a5fa', fontSize: 17, width: 60 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  content: { padding: 16, gap: 8, paddingBottom: 60 },
  section: { color: '#93c5fd', fontSize: 13, fontWeight: '700', marginTop: 12, textTransform: 'uppercase' },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, gap: 12 },
  input: { color: colors.text, fontSize: 16, backgroundColor: '#0f0f14', borderRadius: 8, padding: 12, fontFamily: 'Menlo' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  text: { color: colors.text, fontSize: 16 },
  note: { color: colors.dim, fontSize: 12, lineHeight: 17, flexShrink: 1 },
  link: { color: '#60a5fa', fontSize: 15 },
  stepBtn: { width: 40, height: 36, borderRadius: 8, backgroundColor: '#2a2a33', alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.text, fontSize: 22, fontWeight: '600' },
});
