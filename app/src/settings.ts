import * as SecureStore from 'expo-secure-store';
import type { InterpreterSettings } from './interpreter';

export type AppSettings = InterpreterSettings & {
  totalSpentUsd: number; // running total across app sessions (an estimate from audio sent)
};

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  headphonesVolume: 1,
  speakerVolume: 1,
  listenOnly: false,
  showOriginal: false,
  noiseReduction: true,
  airpodsPress: true,
  totalSpentUsd: 0,
};

const API_KEY = 'openai_api_key';
const SETTINGS = 'settings_v1';
// Readable after the first unlock (so it works with the screen locked); never leaves this phone.
const opts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export async function loadSettings(): Promise<AppSettings> {
  const [apiKey, raw] = await Promise.all([
    SecureStore.getItemAsync(API_KEY, opts).catch(() => null),
    SecureStore.getItemAsync(SETTINGS, opts).catch(() => null),
  ]);
  let rest: Partial<AppSettings> = {};
  try {
    rest = raw ? JSON.parse(raw) : {};
  } catch {}
  return { ...DEFAULT_SETTINGS, ...rest, apiKey: apiKey ?? '' };
}

export async function saveSettings(s: AppSettings): Promise<void> {
  const { apiKey, ...rest } = s;
  await Promise.all([
    apiKey ? SecureStore.setItemAsync(API_KEY, apiKey.trim(), opts) : SecureStore.deleteItemAsync(API_KEY, opts),
    SecureStore.setItemAsync(SETTINGS, JSON.stringify(rest), opts),
  ]);
}
