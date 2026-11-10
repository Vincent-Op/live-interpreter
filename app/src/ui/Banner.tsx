import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';

type Props = {
  kind: 'error' | 'notice';
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
};

export function Banner({ kind, text, actionLabel, onAction, onDismiss }: Props) {
  const tint = kind === 'error' ? colors.danger : colors.warn;
  return (
    <View style={[styles.box, { borderColor: tint + '55', backgroundColor: tint + '1A' }]}>
      <Ionicons name={kind === 'error' ? 'alert-circle' : 'information-circle'} size={20} color={tint} />
      <Text style={styles.text}>{text}</Text>
      {actionLabel && onAction && (
        <Pressable onPress={onAction} style={[styles.action, { backgroundColor: tint }]} hitSlop={8}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      )}
      <Pressable onPress={onDismiss} hitSlop={10}>
        <Ionicons name="close" size={18} color={colors.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  text: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19 },
  action: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  actionText: { color: '#000', fontWeight: '700', fontSize: 13 },
});
