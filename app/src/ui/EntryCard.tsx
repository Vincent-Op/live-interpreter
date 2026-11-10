import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { toTaiwanese } from '../chinese';
import type { Entry } from '../interpreter';
import { colors, radius } from '../theme';

/** Chinese is the original for THEM and the translation for ME: Traditional, Taiwan wording. */
export function displayTexts(entry: Entry) {
  const them = entry.who === 'them';
  return {
    original: (them ? toTaiwanese(entry.original) : entry.original).trim(),
    translation: (them ? entry.translation : toTaiwanese(entry.translation)).trim(),
  };
}

export function EntryCard({ entry, live, onPress }: { entry: Entry; live: boolean; onPress: () => void }) {
  const them = entry.who === 'them';
  const tint = them ? colors.them : colors.me;
  const { original, translation } = displayTexts(entry);
  const time = new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <Pressable
      onPress={onPress}
      disabled={!translation}
      style={({ pressed }) => [
        styles.card,
        them ? styles.left : styles.right,
        { backgroundColor: them ? colors.surface2 : colors.meSoft, borderColor: tint + '55', opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: live ? colors.live : tint }]} />
        <Text style={[styles.who, { color: them ? '#5EEAD4' : '#A5B4FC' }]}>{them ? 'THEM · 中文' : 'ME · ENGLISH'}</Text>
        <Text style={styles.time}>{time}</Text>
        {!!translation && <Ionicons name="expand-outline" size={14} color={colors.faint} />}
      </View>
      {!!original && <Text style={styles.original}>{original}</Text>}
      <Text style={[styles.translation, !them && styles.zh, !translation && styles.placeholder]}>
        {translation || (live ? 'Listening…' : 'Translating…')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 14, maxWidth: '90%', gap: 6 },
  left: { alignSelf: 'flex-start', borderTopLeftRadius: 6 },
  right: { alignSelf: 'flex-end', borderTopRightRadius: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  who: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, flex: 1 },
  time: { color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  original: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  translation: { color: colors.text, fontSize: 18, lineHeight: 26, fontWeight: '500' },
  zh: { fontSize: 22, lineHeight: 32 },
  placeholder: { color: colors.faint, fontStyle: 'italic', fontSize: 16 },
});
