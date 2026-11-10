import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Full-screen, high-contrast text to show the other person (or to read somewhere noisy). */
export function ShowModal({ text, sub, onClose }: { text: string | null; sub?: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const zh = !!text && /[㐀-鿿]/.test(text);
  return (
    <Modal visible={!!text} animationType="fade" onRequestClose={onClose} presentationStyle="fullScreen">
      <Pressable style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]} onPress={onClose}>
        <View style={styles.top}>
          <Text style={styles.hint}>{zh ? '請看 · tap to close' : 'Tap to close'}</Text>
          <Ionicons name="close-circle" size={30} color="#9ca3af" />
        </View>
        <ScrollView contentContainerStyle={styles.center}>
          <Text style={[styles.text, { fontSize: zh ? 44 : 34, lineHeight: zh ? 62 : 44 }]}>{text}</Text>
          {!!sub && <Text style={styles.sub}>{sub}</Text>}
        </ScrollView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF', paddingHorizontal: 24 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { color: '#6b7280', fontSize: 14 },
  center: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
  text: { color: '#0a0a0a', fontWeight: '700' },
  sub: { color: '#6b7280', fontSize: 18, lineHeight: 26, marginTop: 24 },
});
