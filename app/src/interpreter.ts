// The interpreter: push-to-talk turns, mic -> the right translator, translated audio -> the
// right output, transcripts, and cost. Pure TS: audio and sockets are injected, so this exact
// code also runs in the Node test harness (spike/src/interp-test.ts).
import {
  KEEP_SILENT_CHUNKS,
  PREROLL_CHUNKS,
  SESSION_REFRESH_BEFORE_EXPIRY_S,
  STOP_SILENCE_CHUNKS,
  TRANSCRIBE_USD_PER_MIN,
  TRANSLATE_USD_PER_MIN,
} from './config';
import { SILENT_CHUNK_200MS, voicedMs } from './pcm';
import { SessionStatus, SocketFactory, TranslateSession } from './translator';

export type Speaker = 'them' | 'me';
export type OutputTarget = 'headphones' | 'speaker';

/** The subset of the native LiveAudio module the interpreter needs. */
export interface AudioPort {
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  playAudio(base64: string, target: OutputTarget): Promise<void>;
  setVolume(target: OutputTarget, volume: number): Promise<void>;
  addListener(event: 'onAudioChunk', l: (e: { data: string; durationMs: number }) => void): { remove(): void };
  addListener(event: 'onMicLevel', l: (e: { db: number; gated: boolean }) => void): { remove(): void };
}

export type InterpreterSettings = {
  apiKey: string;
  headphonesVolume: number; // 0..1
  speakerVolume: number; // 0..1
  listenOnly: boolean; // never play on the speaker
  showOriginal: boolean; // also transcribe what was said (extra cost)
  noiseReduction: boolean;
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
  turn: Speaker | null;
  connecting: Speaker | null; // a turn is waiting for its translator to (re)connect
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
    turn: null,
    connecting: null,
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
  private preroll: string[] = [];
  private current: Record<Speaker, Entry | null> = { them: null, me: null };
  private silentRun: Record<Speaker, number> = { them: KEEP_SILENT_CHUNKS, me: KEEP_SILENT_CHUNKS };
  private nextId = 1;
  private held: Record<Speaker, string[]> = { them: [], me: [] };
  private reconnecting: Record<Speaker, boolean> = { them: false, me: false };
  private settings: InterpreterSettings;

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
    this.set({ error: null });
  }

  /** Volume and listen-only apply immediately; other changes apply on the next Start. */
  updateSettings(s: InterpreterSettings) {
    this.settings = s;
    if (this.state.status === 'on') {
      this.audio.setVolume('headphones', s.headphonesVolume).catch(() => {});
      this.audio.setVolume('speaker', s.speakerVolume).catch(() => {});
    }
  }

  async start() {
    if (this.state.status !== 'off') return;
    if (!this.settings.apiKey) return this.set({ error: 'Add your OpenAI API key in Settings first.' });
    this.set({ status: 'starting', error: null });
    try {
      if (!(await this.audio.requestPermission())) {
        throw new Error('Microphone access is off. Turn it on in iPhone Settings → LiveInterpreter.');
      }
      await this.audio.start();
      await this.audio.setVolume('headphones', this.settings.headphonesVolume);
      await this.audio.setVolume('speaker', this.settings.speakerVolume);
      this.subs = [
        this.audio.addListener('onAudioChunk', (e) => this.onMicChunk(e.data)),
        this.audio.addListener('onMicLevel', (e) => this.set({ micDb: e.db, micMuted: e.gated })),
      ];
      for (const who of ['them', 'me'] as Speaker[]) this.sessions[who] = this.makeSession(who);
      // Both translators stay connected but idle (no audio = no cost) so a tap starts instantly.
      await Promise.all(Object.values(this.sessions).map((s) => s!.connect()));
      this.set({ status: 'on' });
    } catch (e: any) {
      await this.stop();
      this.set({ error: e?.message ?? String(e) });
    }
  }

  async stop() {
    if (this.state.turn) this.endTurn();
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    Object.values(this.sessions).forEach((s) => {
      this.sentMsClosed += s?.sentMs ?? 0;
      s?.close();
    });
    this.sessions = {};
    this.preroll = [];
    this.held = { them: [], me: [] };
    await this.audio.stop().catch(() => {});
    this.set({ status: 'off', turn: null, connecting: null, micDb: -160, micMuted: false });
  }

  /** Tap a button: start that side's turn, or stop it if it's already running. */
  async toggle(who: Speaker) {
    if (this.state.status !== 'on') return;
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
      // Dropped, expired, or about to expire: reconnect in the background. The turn starts
      // right away; its audio is held and sent as soon as the new connection is ready.
      void this.reconnect(who, null);
    }
    const entry: Entry = { id: this.nextId++, who, original: '', translation: '', startedAt: Date.now() };
    this.current[who] = entry;
    this.silentRun[who] = KEEP_SILENT_CHUNKS;
    this.set({ turn: who, entries: [...this.state.entries, entry] });
    // Include the last moment before the tap, in case they had already started speaking.
    for (const c of this.preroll) this.sendAudio(who, c);
  }

  private endTurn() {
    const who = this.state.turn;
    if (!who) return;
    // Without trailing silence the translator holds back the end of the sentence until the
    // next turn. 3 s sent at once flushes it in ~1-2 s (tested in the Phase 0 spike).
    for (let i = 0; i < STOP_SILENCE_CHUNKS; i++) this.sendAudio(who, SILENT_CHUNK_200MS);
    this.set({ turn: null });
    this.updateCost();
  }

  // ---------- audio ----------

  private onMicChunk(b64: string) {
    this.preroll.push(b64);
    if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
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

  private async reconnect(who: Speaker, detail: string | null) {
    if (this.reconnecting[who]) return;
    this.reconnecting[who] = true;
    this.set({ connecting: who, error: detail ? `Translator connection dropped (${detail}). Reconnecting…` : null });
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
        this.set({ connecting: null, error: null });
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

  private onTranslatedAudio(who: Speaker, b64: string) {
    // Skip silence (keeping a short natural pause) so the delay doesn't build up.
    if (voicedMs(b64) >= 40) {
      this.silentRun[who] = 0;
    } else if (this.silentRun[who] < KEEP_SILENT_CHUNKS) {
      this.silentRun[who]++;
    } else {
      return;
    }
    if (who === 'me' && this.settings.listenOnly) return;
    this.audio.playAudio(b64, OUTPUT[who]).catch((e) => this.set({ error: `Playback: ${e?.message ?? e}` }));
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

