// One gpt-realtime-translate session = one WebSocket = one target language.
// Pure TS: the socket comes from a factory, so the same code runs in the app and in Node tests.
import { TRANSCRIBE_MODEL, TRANSLATE_URL } from './config';

export type SessionStatus = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}
export type SocketFactory = (url: string, apiKey: string) => SocketLike;

export type SessionOptions = {
  apiKey: string;
  target: 'en' | 'zh';
  transcribe: boolean; // also send back the source-language text (costs extra)
  noiseReduction: boolean;
  makeSocket: SocketFactory;
  onAudio: (base64: string) => void;
  onTranslation: (delta: string) => void;
  onOriginal: (delta: string) => void;
  onStatus: (status: SessionStatus, detail?: string) => void;
};

const OPEN = 1;

export class TranslateSession {
  status: SessionStatus = 'idle';
  sentMs = 0;
  closedByClient = false; // close() was called: a 'closed' status is expected, not a drop
  private ws: SocketLike | null = null;
  private expiresAt = 0; // unix seconds
  private connecting: Promise<void> | null = null;

  constructor(private readonly o: SessionOptions) {}

  get target() {
    return this.o.target;
  }

  secondsLeft(): number {
    return this.expiresAt ? this.expiresAt - Date.now() / 1000 : Infinity;
  }

  connect(): Promise<void> {
    if (this.status === 'ready' && this.ws?.readyState === OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.setStatus('connecting');
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      let created = false;
      const fail = (msg: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(msg));
        }
      };
      const timer = setTimeout(() => {
        fail(`Timed out connecting the ${this.o.target} translator`);
        ws.close();
      }, 12000);

      const ws = this.o.makeSocket(TRANSLATE_URL, this.o.apiKey);
      this.ws = ws;
      ws.onmessage = (m) => {
        let ev: any;
        try {
          ev = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data));
        } catch {
          return;
        }
        switch (ev.type) {
          case 'session.created':
            created = true;
            this.expiresAt = ev.session?.expires_at ?? 0;
            this.send({
              type: 'session.update',
              session: {
                audio: {
                  output: { language: this.o.target },
                  input: {
                    transcription: this.o.transcribe ? { model: TRANSCRIBE_MODEL } : null,
                    noise_reduction: this.o.noiseReduction ? { type: 'far_field' } : null,
                  },
                },
              },
            });
            break;
          case 'session.updated':
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              this.setStatus('ready');
              resolve();
            }
            break;
          case 'session.output_audio.delta':
            this.o.onAudio(ev.delta);
            break;
          case 'session.output_transcript.delta':
            this.o.onTranslation(ev.delta);
            break;
          case 'session.input_transcript.delta':
            this.o.onOriginal(ev.delta);
            break;
          case 'error': {
            const msg = ev.error?.message ?? 'Unknown error';
            if (!settled) {
              clearTimeout(timer);
              fail(friendlyError(msg));
              ws.close();
            } else {
              this.o.onStatus(this.status, msg); // most errors are recoverable; the session stays open
            }
            break;
          }
        }
      };
      ws.onerror = () => {
        // onclose follows with details
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        const why = e?.reason || (e?.code ? `code ${e.code}` : '');
        fail(
          created
            ? friendlyError(`Connection closed${why ? ` (${why})` : ''}`)
            : "Couldn't connect to OpenAI. Check the API key in Settings and your internet connection.",
        );
        if (this.ws === ws) {
          this.ws = null;
          this.setStatus(this.status === 'error' ? 'error' : 'closed', why);
        }
      };
    }).finally(() => {
      this.connecting = null;
    });
    this.connecting.catch(() => this.setStatus('error'));
    return this.connecting;
  }

  /** Base64 PCM16 24 kHz mono. Billed by duration. */
  append(base64: string, ms: number) {
    if (this.status !== 'ready' || this.ws?.readyState !== OPEN) return;
    this.send({ type: 'session.input_audio_buffer.append', audio: base64 });
    this.sentMs += ms;
  }

  close() {
    this.closedByClient = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'session.close' }));
    } catch {}
    setTimeout(() => ws.close(), 1500); // let it flush; we don't need anything after this
    this.setStatus('closed');
  }

  private send(ev: object) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(ev));
  }

  private setStatus(s: SessionStatus, detail?: string) {
    this.status = s;
    this.o.onStatus(s, detail);
  }
}

function friendlyError(msg: string): string {
  if (/401|invalid_api_key|Incorrect API key|Unauthorized/i.test(msg)) return 'OpenAI rejected the API key. Check it in Settings.';
  if (/429|quota|billing|insufficient/i.test(msg)) return 'OpenAI says the account is out of credit or rate-limited.';
  return msg;
}
