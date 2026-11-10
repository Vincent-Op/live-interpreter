import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';

type Props = {
  title: string;
  from: string;
  to: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  active: boolean;
  status: string; // small line under the label
  disabled?: boolean;
  onPress: () => void;
};

export function TalkButton({ title, from, to, icon, color, active, status, disabled, onPress }: Props) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const bg = active ? colors.live : color;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.wrap, { opacity: disabled ? 0.45 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
    >
      {active && (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.ring,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] }) }],
            },
          ]}
        />
      )}
      <View style={[styles.button, { backgroundColor: bg }]}>
        <View style={styles.iconCircle}>
          <Ionicons name={active ? 'stop' : icon} size={26} color="#fff" />
        </View>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.langRow}>
          <Text style={styles.lang}>{from}</Text>
          <Ionicons name="arrow-forward" size={13} color="rgba(255,255,255,0.75)" />
          <Text style={styles.lang}>{to}</Text>
        </View>
        <Text style={styles.status} numberOfLines={1}>
          {status}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  ring: { borderRadius: radius.xl, borderWidth: 3, borderColor: colors.live },
  button: { borderRadius: radius.xl, paddingVertical: 18, paddingHorizontal: 10, alignItems: 'center', gap: 6 },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 0.5 },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  lang: { color: 'rgba(255,255,255,0.88)', fontSize: 13, fontWeight: '600' },
  status: { color: 'rgba(255,255,255,0.72)', fontSize: 12, marginTop: 2 },
});
