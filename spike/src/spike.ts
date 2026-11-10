/**
 * Phase 0 spike: two parallel gpt-realtime-translate sessions (target "en" and target "zh"),
 * both fed the same audio in real time, exactly like the phone app will do.
 *
 * Measures latency, saves the translated audio as WAV, and reports what each session does
 * when the speech is already in its target language (silence vs echo).
 *
 *   npm run probe                      -> which language codes the API accepts
 *   npm run spike                      -> all built-in scenarios
 *   npm run spike -- --only mixed      -> one scenario
 *   npm run spike -- --file my.m4a     -> your own recording (any format ffmpeg reads)
 *
 * Key: OPENAI_API_KEY env var, or a spike/.env file containing OPENAI_API_KEY=sk-...
 */
import WebSocket from "ws";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as OpenCC from "opencc-js";

// ---------- config ----------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WS_URL = process.env.TRANSLATE_WS_URL ?? "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
const RATE = 24000;
const BYTES_PER_MS = (RATE * 2) / 1000; // PCM16 mono = 48 bytes per ms
const CHUNK_MS = 200;
const PRICE_PER_MIN = 0.034; // gpt-realtime-translate, per session, Nov 2026 pricing page
const TRANSCRIBE_PRICE_PER_MIN = 0.017; // gpt-realtime-whisper, if billed separately

for (const f of [path.join(ROOT, ".env"), path.join(ROOT, "..", ".env")]) {
  if (existsSync(f)) process.loadEnvFile(f);
}
const KEY = process.env.OPENAI_API_KEY;

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const optAll = (n: string) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));

const TARGETS = opt("targets", "en,zh").split(",");
const TAIL_MS = Number(opt("tail", "6")) * 1000; // silence streamed after the speech
const GAP_MS = Number(opt("gap", "3")) * 1000; // silence between turns in the "mixed" scenario
const NOISE = opt("noise", "off"); // off | near_field | far_field
const TRANSCRIBE = !flag("no-transcribe");
const TRANSCRIBE_MODEL = opt("transcribe-model", "gpt-realtime-whisper");

const toTrad = OpenCC.Converter({ from: "cn", to: "tw" });
const toSimp = OpenCC.Converter({ from: "tw", to: "cn" });

// ---------- audio helpers ----------
function decode(file: string): Buffer {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(RATE), "-"],
    { maxBuffer: 1 << 28 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr}`);
  return r.stdout;
}
const silence = (ms: number) => Buffer.alloc(Math.round(ms * BYTES_PER_MS));
const ms = (bytes: number) => bytes / BYTES_PER_MS;

function rms(pcm: Buffer): number {
  let sum = 0;
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Voiced span of a clip: first/last 20 ms frame above the threshold. */
function speechSpan(pcm: Buffer, thresh = 400): { start: number; end: number } {
  const frame = 20 * BYTES_PER_MS;
  let first = -1, last = -1;
  for (let off = 0, i = 0; off + frame <= pcm.length; off += frame, i++) {
    if (rms(pcm.subarray(off, off + frame)) > thresh) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? { start: 0, end: 0 } : { start: first * 20, end: (last + 1) * 20 };
}

function voicedMs(pcm: Buffer, thresh = 300): number {
  const frame = 20 * BYTES_PER_MS;
  let v = 0;
  for (let off = 0; off + frame <= pcm.length; off += frame) if (rms(pcm.subarray(off, off + frame)) > thresh) v += 20;
  return v;
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------- text helpers ----------
const isCJK = (s: string) => /[㐀-鿿]/.test(s);
function script(s: string): string {
  if (!isCJK(s)) return "-";
  const t = toTrad(s) === s, simp = toSimp(s) === s;
  return t && !simp ? "Traditional" : simp && !t ? "Simplified" : t && simp ? "ambiguous" : "mixed";
}
const norm = (s: string) => toTrad(s.toLowerCase()).replace(/[\s\p{P}\p{S}]/gu, "");
/** Character-bigram Dice similarity (0..1). Chinese is normalised to Traditional first. */
function similarity(a: string, b: string): number {
  a = norm(a); b = norm(b);
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

// ---------- session ----------
type Rec = { t: number; kind: "audio" | "out" | "in"; text?: string; bytes?: number; voiced?: number; elapsed?: number | null };
let T0 = 0; // wall clock when audio position 0 "was spoken"
const now = () => performance.now() - T0;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

class TranslateSession {
  ws!: WebSocket;
  recs: Rec[] = [];
  audio: Buffer[] = [];
  errors: unknown[] = [];
  created: any;
  updated: any;
  private waiters: { type: string; res: (e: any) => void; rej: (e: Error) => void }[] = [];

  constructor(readonly target: string, private log?: string) {}

  async open(config = true): Promise<void> {
    this.ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${KEY}` } });
    this.ws.on("message", (d) => this.onEvent(JSON.parse(d.toString())));
    this.ws.on("close", (code, reason) => {
      for (const w of this.waiters.splice(0)) w.rej(new Error(`socket closed ${code} ${reason}`));
    });
    this.ws.on("error", (e) => {
      for (const w of this.waiters.splice(0)) w.rej(e);
    });
    this.created = (await this.waitFor("session.created", 10000)).session;
    if (!config) return;
    const audio: any = { output: { language: this.target } };
    audio.input = {
      transcription: TRANSCRIBE ? { model: TRANSCRIBE_MODEL } : null,
      noise_reduction: NOISE === "off" ? null : { type: NOISE },
    };
    this.send({ type: "session.update", session: { audio } });
    this.updated = (await this.waitFor("session.updated", 10000)).session;
  }

  send(ev: object) {
    this.ws.send(JSON.stringify(ev));
  }
  sentMs = 0; // audio sent = what we're billed for
  append(b64: string) {
    this.sentMs += (b64.length * 3) / 4 / BYTES_PER_MS;
    this.send({ type: "session.input_audio_buffer.append", audio: b64 });
  }

  waitFor(type: string, timeout: number): Promise<any> {
    return new Promise((res, rej) => {
      const w = { type, res, rej };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        rej(new Error(`[${this.target}] timeout waiting for ${type}`));
      }, timeout);
    });
  }

  private onEvent(ev: any) {
    const t = now();
    if (this.log) {
      const { delta, ...rest } = ev;
      const slim = ev.type === "session.output_audio.delta" ? { ...rest, bytes: Buffer.from(delta, "base64").length } : ev;
      appendFileSync(this.log, JSON.stringify({ t: Math.round(t), ...slim }) + "\n");
    }
    switch (ev.type) {
      case "session.output_audio.delta": {
        const pcm = Buffer.from(ev.delta, "base64");
        this.audio.push(pcm);
        this.recs.push({ t, kind: "audio", bytes: pcm.length, voiced: voicedMs(pcm), elapsed: ev.elapsed_ms });
        break;
      }
      case "session.output_transcript.delta":
        this.recs.push({ t, kind: "out", text: ev.delta, elapsed: ev.elapsed_ms });
        break;
      case "session.input_transcript.delta":
        this.recs.push({ t, kind: "in", text: ev.delta, elapsed: ev.elapsed_ms });
        break;
      case "error":
        this.errors.push(ev.error);
        console.error(`  [${this.target}] error:`, JSON.stringify(ev.error));
        for (const w of this.waiters.splice(0)) w.rej(new Error(ev.error?.message ?? "error"));
        return;
    }
    for (const w of this.waiters.filter((x) => x.type === ev.type)) {
      this.waiters = this.waiters.filter((x) => x !== w);
      w.res(ev);
    }
  }

  async close() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const done = this.waitFor("session.closed", 20000).catch((e) => console.error("  ", e.message));
    this.send({ type: "session.close" });
    await done;
    this.ws.close();
  }
}

// ---------- scenarios ----------
type Segment = { label: string; lang: "zh" | "en" | "?"; start: number; end: number };
type Scenario = { name: string; pcm: Buffer; segments: Segment[] };

function buildScenario(name: string, parts: { file: string; lang: Segment["lang"] }[], gap: number): Scenario {
  const bufs: Buffer[] = [silence(500)];
  const segments: Segment[] = [];
  let pos = 500;
  parts.forEach((p, i) => {
    const pcm = decode(p.file);
    const span = speechSpan(pcm);
    segments.push({ label: path.basename(p.file), lang: p.lang, start: pos + span.start, end: pos + span.end });
    bufs.push(pcm);
    pos += ms(pcm.length);
    if (i < parts.length - 1) { bufs.push(silence(gap)); pos += gap; }
  });
  bufs.push(silence(TAIL_MS));
  return { name, pcm: Buffer.concat(bufs), segments };
}

function scenarios(): Scenario[] {
  const files = optAll("file");
  if (files.length) {
    const lang = opt("lang", "?") as Segment["lang"];
    return files.map((f) => buildScenario(path.parse(f).name, [{ file: f, lang }], GAP_MS));
  }
  const s = (n: string) => path.join(ROOT, "samples", `${n}.mp3`);
  const all = [
    buildScenario("zh-tw-1", [{ file: s("zh-tw-1"), lang: "zh" }], GAP_MS),
    buildScenario("en-1", [{ file: s("en-1"), lang: "en" }], GAP_MS),
    // A back-and-forth conversation in ONE continuous stream - the real app situation.
    buildScenario(
      "mixed",
      [
        { file: s("zh-tw-1"), lang: "zh" },
        { file: s("en-1"), lang: "en" },
        { file: s("zh-tw-2"), lang: "zh" },
        { file: s("en-2"), lang: "en" },
      ],
      GAP_MS,
    ),
  ];
  const only = opt("only", "");
  return only ? all.filter((x) => only.split(",").includes(x.name)) : all;
}

// ---------- analysis ----------
// The server streams audio continuously (silence included) and the stream runs LONGER than
// the input, so playing every chunk in order makes the delay grow. The app must skip
// silent chunks; this analysis simulates exactly that.
const VOICED_CHUNK_MS = 40; // a chunk with at least this much voiced audio counts as speech

type SegResult = {
  segment: string; source: string; target: string;
  inputTranscript: string; outputTranscript: string; outputScript: string;
  firstInputTextMs: number | null; firstOutputTextMs: number | null; firstVoicedAudioMs: number | null;
  transcriptLeadMs: number | null; lastVoicedAfterSpeechEndMs: number | null; doneAfterSpeechEndMs: number | null;
  outputVoicedMs: number; similarityToSource: number | null; sameLanguage: boolean; verdict: string;
};

function analyse(sc: Scenario, s: TranslateSession): SegResult[] {
  // Each event belongs to the latest segment that had started when it arrived.
  const segOf = (t: number) => {
    let k = 0;
    sc.segments.forEach((g, i) => { if (g.start <= t) k = i; });
    return k;
  };
  const isVoiced = (r: Rec) => r.kind === "audio" && r.voiced! >= VOICED_CHUNK_MS;
  // Simulated playback that skips silent chunks; voiced chunks play back to back in arrival order.
  let playEnd = 0;
  const playEnds = new Map<Rec, number>();
  for (const r of s.recs) if (isVoiced(r)) {
    playEnd = Math.max(playEnd, r.t) + ms(r.bytes!);
    playEnds.set(r, playEnd);
  }
  return sc.segments.map((g, i) => {
    const mine = s.recs.filter((r) => segOf(r.t) === i);
    const vAud = mine.filter(isVoiced);
    const out = mine.filter((r) => r.kind === "out");
    const inp = mine.filter((r) => r.kind === "in");
    const outText = out.map((r) => r.text).join("");
    const inText = inp.map((r) => r.text).join("");
    const voiced = vAud.reduce((a, r) => a + r.voiced!, 0);
    const same = g.lang !== "?" && s.target.startsWith(g.lang);
    const rel = (r?: Rec) => (r ? Math.round(r.t - g.start) : null);
    const lastV = vAud.at(-1);
    const sim = inText && outText ? Number(similarity(inText, outText).toFixed(2)) : null;
    let verdict = "translated";
    if (voiced < 300 && !outText.trim()) verdict = "SILENT";
    else if (voiced < 300) verdict = "text only, no audio";
    else if (same) verdict = sim !== null && sim >= 0.5 ? "ECHO (repeats the source)" : "speaks (paraphrase?)";
    return {
      segment: g.label, source: g.lang, target: s.target,
      inputTranscript: inText, outputTranscript: outText, outputScript: script(outText),
      firstInputTextMs: rel(inp[0]), firstOutputTextMs: rel(out[0]), firstVoicedAudioMs: rel(vAud[0]),
      // > 0: the source transcript arrives before the translated speech, so gating adds no delay
      transcriptLeadMs: inp[0] && vAud[0] ? Math.round(vAud[0].t - inp[0].t) : null,
      lastVoicedAfterSpeechEndMs: lastV ? Math.round(lastV.t - g.end) : null,
      doneAfterSpeechEndMs: lastV ? Math.round(playEnds.get(lastV)! - g.end) : null,
      outputVoicedMs: voiced, similarityToSource: sim, sameLanguage: same, verdict,
    };
  });
}

// ---------- runs ----------
async function probe() {
  const codes = optAll("code").length ? optAll("code") : ["en", "zh", "zh-TW", "zh-Hant", "zh-CN", "cmn", "yue", "nan", "xx"];
  console.log("Probing output language codes:", codes.join(", "));
  const results = await Promise.all(codes.map(async (c) => {
    const s = new TranslateSession(c);
    try {
      await s.open();
      return { code: c, ok: true, language: s.updated?.audio?.output?.language, created: s.created };
    } catch (e: any) {
      return { code: c, ok: false, error: e.message };
    } finally {
      s.ws?.close();
    }
  }));
  for (const r of results) console.log(`  ${r.code.padEnd(8)} ${r.ok ? `accepted -> ${r.language}` : `REJECTED: ${r.error}`}`);
  const first = results.find((r) => r.ok) as any;
  if (first) console.log("\nDefault session object from session.created:\n" + JSON.stringify(first.created, null, 2));
}

async function runScenario(sc: Scenario, outDir: string): Promise<SegResult[]> {
  const dir = path.join(outDir, sc.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "input.wav"), wav(sc.pcm));
  const secs = ms(sc.pcm.length) / 1000;
  console.log(`\n=== ${sc.name}  (${secs.toFixed(1)} s of audio, streamed in real time) ===`);
  for (const g of sc.segments) console.log(`  speech ${g.label} [${g.lang}] ${(g.start / 1000).toFixed(1)}s - ${(g.end / 1000).toFixed(1)}s`);

  T0 = performance.now();
  const sessions = TARGETS.map((t) => new TranslateSession(t, path.join(dir, `events-${t}.jsonl`)));
  await Promise.all(sessions.map((s) => s.open()));

  // Chunk i holds audio [i*200, i*200+200) ms; a real mic only has it at (i+1)*200 ms.
  T0 = performance.now();
  const chunk = CHUNK_MS * BYTES_PER_MS;
  for (let i = 0, off = 0; off < sc.pcm.length; i++, off += chunk) {
    const wait = (i + 1) * CHUNK_MS - now();
    if (wait > 0) await sleep(wait);
    const b64 = sc.pcm.subarray(off, off + chunk).toString("base64");
    for (const s of sessions) s.append(b64);
  }
  await Promise.all(sessions.map((s) => s.close()));

  const results: SegResult[] = [];
  for (const s of sessions) {
    writeFileSync(path.join(dir, `out-${s.target}.wav`), wav(Buffer.concat(s.audio)));
    results.push(...analyse(sc, s));
  }
  for (const r of results) {
    console.log(`\n  ${r.segment} [${r.source}] -> session "${r.target}"${r.sameLanguage ? "  (SAME LANGUAGE)" : ""}: ${r.verdict}`);
    console.log(`    heard : ${r.inputTranscript || "(no input transcript)"}`);
    console.log(`    output: ${r.outputTranscript || "(no text)"}  [${r.outputScript}]`);
    console.log(`    from speech start: source text ${r.firstInputTextMs ?? "-"} ms, translated text ${r.firstOutputTextMs ?? "-"} ms, first audible audio ${r.firstVoicedAudioMs ?? "-"} ms (source text arrives ${r.transcriptLeadMs ?? "-"} ms before audio)`);
    console.log(`    after speaker stops: last audible chunk ${r.lastVoicedAfterSpeechEndMs ?? "-"} ms, playback done ${r.doneAfterSpeechEndMs ?? "-"} ms; audible audio ${r.outputVoicedMs} ms; similarity to source ${r.similarityToSource ?? "-"}`);
  }
  for (const s of sessions) {
    const total = s.audio.reduce((a, b) => a + ms(b.length), 0);
    console.log(`  session "${s.target}": ${(total / 1000).toFixed(1)} s of output audio for ${secs.toFixed(1)} s of input`);
  }
  return results;
}

// ---------- push-to-talk test ----------
// Both sessions stay connected, but only the one for the current speaker gets audio, and only
// while its button is "on". Questions: does an idle session send anything, does a session pick up
// cleanly after a pause, and how much silence after "stop" does it need to finish the sentence?
async function streamTo(s: TranslateSession, pcm: Buffer, burst: boolean) {
  const chunk = CHUNK_MS * BYTES_PER_MS;
  const start = now();
  for (let i = 0, off = 0; off < pcm.length; i++, off += chunk) {
    if (!burst) {
      const wait = start + (i + 1) * CHUNK_MS - now();
      if (wait > 0) await sleep(wait);
    }
    s.append(pcm.subarray(off, off + chunk).toString("base64"));
  }
}

async function pttRun() {
  const IDLE_MS = Number(opt("idle", "15")) * 1000; // connected, no audio, before the first turn
  const WAIT_MS = Number(opt("wait", "7")) * 1000; // no audio after each turn, watching for late output
  const clip = (n: string) => path.join(ROOT, "samples", `${n}.mp3`);
  type Turn = { clip: string; lang: "zh" | "en"; tail: number; burst: boolean };
  const turns: Turn[] = [
    { clip: "zh-tw-1", lang: "zh", tail: 0, burst: false },
    { clip: "en-1", lang: "en", tail: 0, burst: false },
    { clip: "zh-tw-2", lang: "zh", tail: 3000, burst: false },
    { clip: "en-2", lang: "en", tail: 3000, burst: false },
    { clip: "zh-tw-1", lang: "zh", tail: 3000, burst: true },
    { clip: "en-1", lang: "en", tail: 3000, burst: true },
  ];
  const outDir = path.join(ROOT, "out", "ptt-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  mkdirSync(outDir, { recursive: true });

  T0 = performance.now();
  const en = new TranslateSession("en", path.join(outDir, "events-en.jsonl"));
  const zh = new TranslateSession("zh", path.join(outDir, "events-zh.jsonl"));
  await Promise.all([en.open(), zh.open()]);
  console.log(`Both sessions connected in ${Math.round(now())} ms. Idle for ${IDLE_MS / 1000} s with no audio...`);
  const idleFrom = now();
  await sleep(IDLE_MS);
  const idleRecs = [...en.recs, ...zh.recs].filter((r) => r.t >= idleFrom).length;
  console.log(`  events received while idle: ${idleRecs}; sockets open: ${en.ws.readyState === WebSocket.OPEN && zh.ws.readyState === WebSocket.OPEN}`);

  for (const [n, t] of turns.entries()) {
    const s = t.lang === "zh" ? en : zh; // Mandarin speaker -> "en" session, and vice versa
    const other = s === en ? zh : en;
    const pcm = decode(clip(t.clip));
    const span = speechSpan(pcm);
    const from = now();
    const speechStart = from + span.start, speechEnd = from + span.end;
    await streamTo(s, pcm, false);
    if (t.tail) await streamTo(s, silence(t.tail), t.burst);
    const stopped = now();
    await sleep(WAIT_MS);

    const mine = s.recs.filter((r) => r.t >= from);
    const voiced = mine.filter((r) => r.kind === "audio" && r.voiced! >= VOICED_CHUNK_MS);
    const late = voiced.filter((r) => r.t > stopped);
    const text = mine.filter((r) => r.kind === "out").map((r) => r.text).join("");
    const stray = other.recs.filter((r) => r.t >= from && r.kind !== "audio").length;
    const tailDesc = t.tail ? `${t.tail / 1000} s silence ${t.burst ? "sent instantly" : "in real time"}` : "no silence";
    console.log(`\nTurn ${n + 1}: ${t.clip} [${t.lang}] -> "${s.target}" session, stop = ${tailDesc}`);
    console.log(`  output: ${text || "(none)"}`);
    console.log(`  first audible translation ${voiced[0] ? Math.round(voiced[0].t - speechStart) + " ms after speech start" : "-"}`);
    console.log(`  last audible chunk ${voiced.at(-1) ? Math.round(voiced.at(-1)!.t - speechEnd) + " ms after speaker stopped" : "-"}; ` +
      `audible audio after "stop": ${late.reduce((a, r) => a + r.voiced!, 0)} ms; other session events: ${stray}`);
  }
  await Promise.all([en.close(), zh.close()]);
  writeFileSync(path.join(outDir, "out-en.wav"), wav(Buffer.concat(en.audio)));
  writeFileSync(path.join(outDir, "out-zh.wav"), wav(Buffer.concat(zh.audio)));
  const sentMin = (en.sentMs + zh.sentMs) / 60000;
  console.log(`\nAudio sent: ${(en.sentMs / 1000).toFixed(1)} s to "en", ${(zh.sentMs / 1000).toFixed(1)} s to "zh" -> ~$${(sentMin * PRICE_PER_MIN).toFixed(3)}`);
  console.log(`Total wall time ${(now() / 1000).toFixed(0)} s. Logs and WAVs: ${outDir}`);
}

async function main() {
  const dry = flag("dry"); // build scenarios and print the plan; no network, no key needed
  if (!KEY && !dry) {
    console.error("Set OPENAI_API_KEY (env var, or a spike/.env file with OPENAI_API_KEY=sk-...).");
    process.exit(1);
  }
  if (flag("probe")) return probe();
  if (flag("ptt")) return pttRun();

  const list = scenarios();
  const audioMin = list.reduce((a, s) => a + ms(s.pcm.length), 0) / 60000;
  const cost = audioMin * TARGETS.length * (PRICE_PER_MIN + (TRANSCRIBE ? TRANSCRIBE_PRICE_PER_MIN : 0));
  console.log(`Targets: ${TARGETS.join(", ")} | noise reduction: ${NOISE} | input transcription: ${TRANSCRIBE ? TRANSCRIBE_MODEL : "off"}`);
  console.log(`${list.length} scenario(s), ${audioMin.toFixed(2)} min of audio x ${TARGETS.length} sessions ~ $${cost.toFixed(3)} worst case`);
  if (dry) {
    for (const sc of list) {
      console.log(`  ${sc.name}: ${(ms(sc.pcm.length) / 1000).toFixed(1)} s`);
      for (const g of sc.segments) console.log(`    ${g.label} [${g.lang}] speech ${(g.start / 1000).toFixed(2)}s - ${(g.end / 1000).toFixed(2)}s`);
    }
    return;
  }

  const outDir = path.join(ROOT, "out", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  const all: Record<string, SegResult[]> = {};
  for (const sc of list) {
    try {
      all[sc.name] = await runScenario(sc, outDir);
    } catch (e: any) {
      console.error(`Scenario ${sc.name} failed: ${e.message}`);
    }
  }
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(all, null, 2));

  console.log("\n=== Same-language behaviour (speech already in the session's target language) ===");
  for (const [name, rs] of Object.entries(all))
    for (const r of rs.filter((x) => x.sameLanguage))
      console.log(`  ${name.padEnd(8)} ${r.segment.padEnd(12)} -> "${r.target}": ${r.verdict}  (voiced ${r.outputVoicedMs} ms, text "${r.outputTranscript.slice(0, 60)}")`);
  console.log(`\nWAVs, event logs and report.json: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
