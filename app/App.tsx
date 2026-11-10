import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Phase 1 placeholder: proves the dev client loads JS from Metro and hot reload works.
export default function App() {
  const [taps, setTaps] = useState(0);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>LiveInterpreter</Text>
      <Text style={styles.sub}>Phase 1: JS loaded from Metro ✅</Text>
      <Pressable style={styles.button} onPress={() => setTaps((n) => n + 1)}>
        <Text style={styles.buttonText}>Tapped {taps} times</Text>
      </Pressable>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { color: '#fff', fontSize: 32, fontWeight: '700' },
  sub: { color: '#aaa', fontSize: 16 },
  button: { backgroundColor: '#2563eb', paddingHorizontal: 28, paddingVertical: 16, borderRadius: 12 },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: '600' },
});
