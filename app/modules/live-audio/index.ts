import { NativeModule, requireOptionalNativeModule } from 'expo';

export type OutputTarget = 'headphones' | 'speaker';
export type RoutePort = { type: string; name: string };
export type SpeakerMode = 'off' | 'switchingOn' | 'on' | 'switchingOff';
export type AudioRoute = { inputs: RoutePort[]; outputs: RoutePort[]; speakerMode: SpeakerMode; sampleRate: number };
export type PlaybackState = { headphones: boolean; speaker: boolean; speakerMode: SpeakerMode };

export type LiveAudioEvents = {
  /** 200 ms of mic audio: base64 PCM16, 24 kHz mono. Not sent while the speaker is playing. */
  onAudioChunk: (e: { data: string; durationMs: number }) => void;
  /** ~10 per second. `gated` = mic is muted because the speaker is (or just was) playing. */
  onMicLevel: (e: { db: number; gated: boolean }) => void;
  onPlaybackState: (e: PlaybackState) => void;
  onRouteChange: (e: { reason: string; route: AudioRoute }) => void;
  onError: (e: { message: string }) => void;
};

declare class LiveAudioNativeModule extends NativeModule<LiveAudioEvents> {
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  playAudio(base64: string, target: OutputTarget): Promise<void>;
  stopPlayback(target: OutputTarget | null): Promise<void>;
  setVolume(target: OutputTarget, volume: number): Promise<void>;
  configure(options: AudioConfig): Promise<void>;
  getCurrentRoute(): AudioRoute;
}

export type AudioConfig = {
  /** Keep the speaker route this long after its audio runs out (default 1200). */
  speakerHoldMs?: number;
  /** Keep the mic muted this long after the speaker route ends (default 300). */
  micTailMs?: number;
};

// Optional so that new JS running on an older app build shows a message instead of crashing.
const native = requireOptionalNativeModule<LiveAudioNativeModule>('LiveAudio');

export const isAvailable = native != null;

function mod(): LiveAudioNativeModule {
  if (!native) throw new Error('LiveAudio native module missing: install the latest build from GitHub Actions.');
  return native;
}

export const LiveAudio = {
  requestPermission: () => mod().requestPermission(),
  start: () => mod().start(),
  stop: () => mod().stop(),
  playAudio: (base64: string, target: OutputTarget) => mod().playAudio(base64, target),
  stopPlayback: (target?: OutputTarget) => mod().stopPlayback(target ?? null),
  setVolume: (target: OutputTarget, volume: number) => mod().setVolume(target, volume),
  configure: (options: AudioConfig) => mod().configure(options),
  getCurrentRoute: () => mod().getCurrentRoute(),
  addListener: <E extends keyof LiveAudioEvents>(event: E, listener: LiveAudioEvents[E]) =>
    mod().addListener(event, listener),
};

// ---------- helpers ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

/** A sine tone as base64 PCM16 24 kHz mono chunks (like streamed translation audio). */
export function toneChunks(freqHz: number, ms: number, chunkMs = 400, gain = 0.25): string[] {
  const rate = 24000;
  const total = Math.round((rate * ms) / 1000);
  const fade = Math.round(rate * 0.01);
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    const env = Math.min(1, i / fade, (total - 1 - i) / fade);
    pcm[i] = Math.round(Math.sin((2 * Math.PI * freqHz * i) / rate) * gain * env * 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  const step = Math.round((rate * chunkMs) / 1000) * 2;
  const chunks: string[] = [];
  for (let off = 0; off < bytes.length; off += step) chunks.push(bytesToBase64(bytes.subarray(off, off + step)));
  return chunks;
}
