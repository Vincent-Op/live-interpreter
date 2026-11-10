// The interpreter: push-to-talk turns, mic -> the right translator, translated audio -> the
// right output, transcripts, and cost. Pure TS: audio and sockets are injected, so this exact
// code also runs in the Node test harness (spike/src/interp-test.ts).
import {
  IDLE_DISCONNECT_MS,
  IDLE_STOP_MS,
  KEEP_SILENT_CHUNKS,
  ME_DONE_AFTER_MS,
  SESSION_REFRESH_BEFORE_EXPIRY_S,
  STOP_SILENCE_CHUNKS,
  TRANSCRIBE_USD_PER_MIN,
  TRANSLATE_USD_PER_MIN,
  VOICED_MIN_MS,
  VOICED_THRESHOLD,
} from './config';
import { SILENT_CHUNK_200MS, voicedMs } from './pcm';
import { SessionStatus, SocketFactory, TranslateSession } from './translator';

export type Speaker = 'them' | 'me';
export type OutputTarget = 'headphones' | 'speaker';

export type AudioEvents = {
  onAudioChunk: { data: string; durationMs: number };
  onMicLevel: { db: number; gated: boolean };
  onRouteChange: { reason: string; route: { outputs: { type: string; name: string }[]; headphones?: boolean } };
  onInterruption: { state: 'began' | 'ended'; resumed: boolean };
  onRemoteCommand: { command: string };
};

/** The subset of the native LiveAudio module the interpreter needs. */
export interface AudioPort {
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Mic chunks are only sent to JS while streaming (saves battery); turning it on first replays ~400 ms. */
  setStreaming(on: boolean): Promise<void>;
  /** Re-activate audio after an interruption that couldn't resume in the background. */
  resume(): Promise<void>;
  playAudio(base64: string, target: OutputTarget): Promise<void>;
  /** on: switch to the speaker now and keep it. off: go back to the AirPods once speaker audio finishes. */
  holdSpeaker(on: boolean): Promise<void>;
  setVolume(target: OutputTarget, volume: number): Promise<void>;
  setRemoteCommands(on: boolean): Promise<void>;
  addListener<E extends keyof AudioEvents>(event: E, listener: (e: AudioEvents[E]) => void): { remove(): void };
}

export type InterpreterSettings = {
  apiKey: string;
  headphonesVolume: number; // 0..1
  speakerVolume: number; // 0..1
  listenOnly: boolean; // never play on the speaker
  showOriginal: boolean; // also transcribe what was said (extra cost)
  noiseReduction: boolean;
  airpodsPress: boolean; // AirPods stem press toggles THEM (if iOS delivers it)
};

export type Entry = {
  id: number;
  who: Speaker;
  original: string; // what was said (only if showOriginal)
  translation: string;
  startedAt: number;
};

export type InterpreterState = {
  status: 'off' | 'starting' | 'on';
  error: string | null;
  notice: string | null; // non-error info: AirPods removed, interrupted by a call, idle stop
  needsResume: boolean; // audio was interrupted and iOS didn't let it resume; open the app / tap Resume
  turn: Speaker | null;
  connecting: Speaker | null; // a turn is waiting for its translator to (re)connect
  speaking: boolean; // the phone speaker is playing (or about to play) the Mandarin translation
  sessions: Record<Speaker, SessionStatus>;
  entries: Entry[];
  micDb: number;
  micMuted: boolean; // muted because the speaker is playing
  sentSeconds: number;
  costUsd: number;
};

const OUTPUT: Record<Speaker, OutputTarget> = { them: 'headphones', me: 'speaker' };
const TARGET_LANG: Record<Speaker, 'en' | 'zh'> = { them: 'en', me: 'zh' };

export class Interpreter {
  state: InterpreterState = {
    status: 'off',
    error: null,
    notice: null,
    needsResume: false,
    turn: null,
    connecting: null,
    speaking: false,
    sessions: { them: 'idle', me: 'idle' },
    entries: [],
    micDb: -160,
    micMuted: false,
    sentSeconds: 0,
    costUsd: 0,
  };

  private listeners = new Set<(s: InterpreterState) => void>();
  private sessions: Partial<Record<Speaker, TranslateSession>> = {};
  private subs: { remove(): void }[] = [];
  private current: Record<Speaker, Entry | null> = { them: null, me: null };
  private silentRun: Record<Speaker, number> = { them: KEEP_SILENT_CHUNKS, me: KEEP_SILENT_CHUNKS };
  private held: Record<Speaker, string[]> = { them: [], me: [] }; // mic audio waiting for a reconnect
  private reconnecting: Record<Speaker, boolean> = { them: false, me: false };
  private nextId = 1;
  private settings: InterpreterSettings;

  // ME output is held during the turn and spoken when you tap stop (like a consecutive
  // interpreter). The mic is muted while the speaker plays, so speaking during the turn
  // would cut off the rest of what you're saying.
  private meQueue: string[] = [];
  private meHolding = false;
  private meLastAudioAt = 0;
  private meTurnEndedAt = 0;
  private meTimer: ReturnType<typeof setInterval> | null = null;

  private lastActivity = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly audio: AudioPort,
    private readonly makeSocket: SocketFactory,
    settings: InterpreterSettings,
  ) {
    this.settings = settings;
  }

  // Arrow function so React's useSyncExternalStore gets a stable reference.
  subscribe = (fn: (s: InterpreterState) => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  dismissError() {
    this.set({ error: null, notice: null });
  }

  /** Volume, listen-only and the AirPods button apply immediately; the rest on the next Start. */
  updateSettings(s: InterpreterSettings) {
    this.settings = s;
    if (this.state.status === 'on') {
      this.audio.setVolume('headphones', s.headphonesVolume).catch(() => {});
      this.audio.setVolume('speaker', s.speakerVolume).catch(() => {});
      this.audio.setRemoteCommands(s.airpodsPress).catch(() => {});
    }
  }

  async start() {
    if (this.state.status !== 'off') return;
    if (!this.settings.apiKey) return this.set({ error: 'Add your OpenAI API key in Settings first.' });
    this.set({ status: 'starting', error: null, notice: null });
    try {
      if (!(await this.audio.requestPermission())) {
        throw new Error('Microphone access is off. Turn it on in iPhone Settings → LiveInterpreter.');
      }
      await this.audio.start();
      await this.audio.setStreaming(false);
      await this.audio.setVolume('headphones', this.settings.headphonesVolume);
      await this.audio.setVolume('speaker', this.settings.speakerVolume);
      await this.audio.setRemoteCommands(this.settings.airpodsPress).catch(() => {});
      this.subs = [
        this.audio.addListener('onAudioChunk', (e) => this.onMicChunk(e.data)),
        this.audio.addListener('onMicLevel', (e) => {
          if (Math.abs(e.db - this.state.micDb) > 1.5 || e.gated !== this.state.micMuted) this.set({ micDb: e.db, micMuted: e.gated });
        }),
        this.audio.addListener('onRouteChange', (e) => this.onRouteChange(e)),
        this.audio.addListener('onInterruption', (e) => this.onInterruption(e)),
        this.audio.addListener('onRemoteCommand', (e) => {
          // Single press = THEM, double press = ME.
          if (this.settings.airpodsPress) void this.toggle(e.command === 'double' ? 'me' : 'them');
        }),
      ];
      for (const who of ['them', 'me'] as Speaker[]) this.sessions[who] = this.makeSession(who);
      // Both translators stay connected but idle (no audio = no cost) so a tap starts instantly.
      await Promise.all(Object.values(this.sessions).map((s) => s!.connect()));
      this.lastActivity = Date.now();
      this.idleTimer = setInterval(() => this.checkIdle(), 15000);
      this.set({ status: 'on' });
    } catch (e: any) {
      await this.stop();
      this.set({ error: e?.message ?? String(e) });
    }
  }

  async stop() {
    if (this.state.turn) this.endTurn();
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.meTimer) clearInterval(this.meTimer);
    this.idleTimer = this.meTimer = null;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    Object.values(this.sessions).forEach((s) => {
      this.sentMsClosed += s?.sentMs ?? 0;
      s?.close();
    });
    this.sessions = {};
    this.held = { them: [], me: [] };
    this.meQueue = [];
    this.meHolding = false;
    await this.audio.stop().catch(() => {});
    this.set({ status: 'off', turn: null, connecting: null, speaking: false, needsResume: false, micDb: -160, micMuted: false });
  }

  /** Tap a button: start that side's turn, or stop it if it's already running. */
  async toggle(who: Speaker) {
    if (this.state.status !== 'on') return;
    this.lastActivity = Date.now();
    if (this.state.turn === who) return this.endTurn();
    if (this.state.turn) this.endTurn();
    await this.beginTurn(who);
  }

  clearTranscript() {
    this.current = { them: null, me: null };
    this.set({ entries: [] });
  }

  // ---------- turns ----------

  private async beginTurn(who: Speaker) {
    const s = this.sessions[who];
    if (!s) return;
    if (s.status !== 'ready' || s.secondsLeft() < SESSION_REFRESH_BEFORE_EXPIRY_S) {
      // Parked after idle, dropped, or about to expire: reconnect in the background. The turn
      // starts now; its audio is held and sent as soon as the new connection is ready.
      void this.reconnect(who, null);
    }
    const entry: Entry = { id: this.nextId++, who, original: '', translation: '', startedAt: Date.now() };
    this.current[who] = entry;
    this.silentRun[who] = KEEP_SILENT_CHUNKS;
    if (who === 'me' && !this.settings.listenOnly) {
      // Switch to the speaker now so it's ready when you stop; the translation waits until then.
      this.meQueue = [];
      this.meHolding = true;
      this.audio.holdSpeaker(true).catch(() => {});
      this.set({ speaking: true });
    }
    if (who === 'them') this.releaseSpeaker(); // their English goes to the AirPods once Mandarin ends
    this.set({ turn: who, entries: [...this.state.entries, entry] });
    await this.audio.setStreaming(true).catch(() => {}); // replays the last ~400 ms first
  }

  private endTurn() {
    const who = this.state.turn;
    if (!who) return;
    this.audio.setStreaming(false).catch(() => {});
    // Without trailing silence the translator holds back the end of the sentence until the
    // next turn. 3 s sent at once flushes it in ~1-2 s (tested in the Phase 0 spike).
    for (let i = 0; i < STOP_SILENCE_CHUNKS; i++) this.sendAudio(who, SILENT_CHUNK_200MS);
    if (who === 'me' && this.meHolding) {
      const queued = this.meQueue;
      this.meQueue = [];
      queued.forEach((c) => this.play('me', c));
      this.meTurnEndedAt = Date.now();
      this.watchMeDone();
    }
    this.set({ turn: null });
    this.updateCost();
  }

  /** Once the Mandarin translation has stopped arriving, let the speaker go back to the AirPods. */
  private watchMeDone() {
    if (this.meTimer) clearInterval(this.meTimer);
    this.meTimer = setInterval(() => {
      if (this.state.turn === 'me') return;
      const quietSince = Math.max(this.meLastAudioAt, this.meTurnEndedAt);
      if (Date.now() - quietSince > ME_DONE_AFTER_MS) this.releaseSpeaker();
    }, 400);
  }

  private releaseSpeaker() {
    if (this.meTimer) clearInterval(this.meTimer);
    this.meTimer = null;
    if (!this.meHolding) return;
    this.meHolding = false;
    const queued = this.meQueue; // a ME turn interrupted by THEM: speak what we have
    this.meQueue = [];
    queued.forEach((c) => this.play('me', c));
    this.audio.holdSpeaker(false).catch(() => {});
    this.set({ speaking: false });
  }

  // ---------- audio ----------

  private onMicChunk(b64: string) {
    const who = this.state.turn;
    if (!who) return;
    this.sendAudio(who, b64);
    this.updateCost();
  }

  /** Send to the translator, or hold it (up to 15 s) while that translator reconnects. */
  private sendAudio(who: Speaker, b64: string) {
    const s = this.sessions[who];
    if (s && s.status === 'ready') {
      s.append(b64, 200);
    } else {
      this.held[who].push(b64);
      if (this.held[who].length > 75) this.held[who].shift();
    }
  }

  private onTranslatedAudio(who: Speaker, b64: string) {
    // The stream is continuous and ~2x longer than the input, so skip silence (keeping a short
    // natural pause) or the delay builds up.
    if (voicedMs(b64, VOICED_THRESHOLD) >= VOICED_MIN_MS) {
      this.silentRun[who] = 0;
    } else if (this.silentRun[who] < KEEP_SILENT_CHUNKS) {
      this.silentRun[who]++;
    } else {
      return;
    }
    if (who === 'me') {
      if (this.settings.listenOnly) return;
      this.meLastAudioAt = Date.now();
      if (this.state.turn === 'me') {
        this.meQueue.push(b64); // spoken when you tap stop
        return;
      }
      if (!this.meHolding) {
        // Late audio after the speaker was released (rare): hold the speaker again briefly.
        this.meHolding = true;
        this.audio.holdSpeaker(true).catch(() => {});
        this.set({ speaking: true });
        this.meTurnEndedAt = Date.now();
        this.watchMeDone();
      }
    }
    this.play(who, b64);
  }

  private play(who: Speaker, b64: string) {
    this.audio.playAudio(b64, OUTPUT[who]).catch((e) => this.set({ error: `Playback: ${e?.message ?? e}` }));
  }

  // ---------- phone events ----------

  private onRouteChange(e: AudioEvents['onRouteChange']) {
    const headphones = e.route.headphones ?? e.route.outputs.some((o) => /Bluetooth|Headphones/i.test(o.type));
    if (e.reason === 'deviceRemoved' && !headphones) {
      if (this.state.turn === 'them') this.endTurn();
      this.set({ notice: 'AirPods disconnected. English will play quietly from the earpiece until you put them back in.' });
    } else if (e.reason === 'deviceConnected' && headphones && this.state.notice?.startsWith('AirPods')) {
      this.set({ notice: null });
    }
  }

  private onInterruption(e: AudioEvents['onInterruption']) {
    if (e.state === 'began') {
      if (this.state.turn) this.endTurn();
      this.set({ notice: 'Paused by a call, Siri or another app.' });
    } else if (e.resumed) {
      this.set({ notice: null, needsResume: false });
    } else {
      this.set({ notice: 'Audio was interrupted. Tap Resume.', needsResume: true });
    }
  }

  /** Called from the Resume button and whenever the app comes back to the foreground. */
  async resumeAudio() {
    if (!this.state.needsResume || this.state.status !== 'on') return;
    try {
      await this.audio.resume();
      this.set({ notice: null, needsResume: false });
    } catch (e: any) {
      this.set({ notice: `Couldn't resume audio (${e?.message ?? e}). Tap Stop, then Start.` });
    }
  }

  private checkIdle() {
    if (this.state.status !== 'on' || this.state.turn) return;
    const idle = Date.now() - this.lastActivity;
    if (idle > IDLE_STOP_MS) {
      void this.stop().then(() => this.set({ notice: 'Stopped after 20 minutes without use, to save battery.' }));
    } else if (idle > IDLE_DISCONNECT_MS) {
      // Close idle sockets (less radio use); the next tap reconnects in ~1 s without losing audio.
      for (const who of ['them', 'me'] as Speaker[]) {
        const s = this.sessions[who];
        if (s && s.status === 'ready') s.close();
      }
    }
  }

  // ---------- text ----------

  private onText(who: Speaker, field: 'original' | 'translation', delta: string) {
    let entry = this.current[who];
    if (!entry) {
      entry = { id: this.nextId++, who, original: '', translation: '', startedAt: Date.now() };
      this.current[who] = entry;
      this.state.entries = [...this.state.entries, entry];
    }
    const updated = { ...entry, [field]: entry[field] + delta };
    this.current[who] = updated;
    this.set({ entries: this.state.entries.map((e) => (e.id === updated.id ? updated : e)) });
  }

  // ---------- plumbing ----------

  private async reconnect(who: Speaker, detail: string | null) {
    if (this.reconnecting[who]) return;
    this.reconnecting[who] = true;
    this.set({ connecting: who, error: detail ? `Translator connection dropped (${detail}). Reconnecting…` : this.state.error });
    for (let attempt = 1; attempt <= 3 && this.state.status === 'on'; attempt++) {
      const old = this.sessions[who];
      if (old) {
        this.sentMsClosed += old.sentMs;
        old.close();
      }
      const s = (this.sessions[who] = this.makeSession(who));
      try {
        await s.connect();
        const held = this.held[who];
        this.held[who] = [];
        held.forEach((c) => s.append(c, 200));
        this.updateCost();
        this.set({ connecting: null, error: detail ? null : this.state.error });
        this.reconnecting[who] = false;
        return;
      } catch (e: any) {
        if (attempt === 3) this.set({ error: `Couldn't reconnect: ${e?.message ?? e}` });
        else await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    this.held[who] = [];
    this.set({ connecting: null });
    this.reconnecting[who] = false;
  }

  private makeSession(who: Speaker): TranslateSession {
    const session: TranslateSession = new TranslateSession({
      apiKey: this.settings.apiKey,
      target: TARGET_LANG[who],
      transcribe: this.settings.showOriginal,
      noiseReduction: this.settings.noiseReduction,
      makeSocket: this.makeSocket,
      onAudio: (b64) => this.onTranslatedAudio(who, b64),
      onTranslation: (d) => this.onText(who, 'translation', d),
      onOriginal: (d) => this.onText(who, 'original', d),
      onStatus: (status, detail) => {
        if (this.sessions[who] !== session) return; // an old, replaced session
        if (status !== this.state.sessions[who]) this.set({ sessions: { ...this.state.sessions, [who]: status } });
        if (detail && status === 'ready') this.set({ error: detail });
        // The server closed it (not us): reconnect so the next words aren't lost.
        if ((status === 'closed' || status === 'error') && !session.closedByClient && this.state.status === 'on') {
          void this.reconnect(who, detail ?? 'closed');
        }
      },
    });
    return session;
  }

  private sentMsTotal = 0;
  private sentMsClosed = 0; // from sessions already replaced

  private updateCost() {
    const live = Object.values(this.sessions).reduce((a, s) => a + (s?.sentMs ?? 0), 0);
    const ms = this.sentMsClosed + live;
    if (ms === this.sentMsTotal) return;
    this.sentMsTotal = ms;
    const perMin = TRANSLATE_USD_PER_MIN + (this.settings.showOriginal ? TRANSCRIBE_USD_PER_MIN : 0);
    this.set({ sentSeconds: ms / 1000, costUsd: (ms / 60000) * perMin });
  }

  private set(patch: Partial<InterpreterState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }
}
