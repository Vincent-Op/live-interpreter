/**
 * Runs the APP's interpreter code (app/src/interpreter.ts) in Node against the real API.
 * A fake mic streams test clips in real time; a script taps "Them" and "Me" like a user would.
 *
 *   npm run interp            (~$0.02)
 */
import WebSocket from "ws";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AudioPort, Interpreter, OutputTarget } from "../../app/src/interpreter";
import { toTaiwanese } from "../../app/src/chinese";
import type { SocketLike } from "../../app/src/translator";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [path.join(ROOT, ".env")]) if (existsSync(f)) process.loadEnvFile(f);
const KEY = process.env.OPENAI_API_KEY ?? "";
const BPMS = 48;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let T0 = performance.now();
const now = () => Math.round(performance.now() - T0);

function decode(file: string): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", "24000", "-"], { maxBuffer: 1 << 28 });
  return r.stdout;
}
function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

class FakeAudio implements AudioPort {
  chunkListeners = new Set<(e: { data: string; durationMs: number }) => void>();
  played: Record<OutputTarget, { t: number; pcm: Buffer }[]> = { headphones: [], speaker: [] };
  async requestPermission() { return true; }
  async start() {}
  async stop() {}
  async setVolume() {}
  async playAudio(b64: string, target: OutputTarget) {
    this.played[target].push({ t: now(), pcm: Buffer.from(b64, "base64") });
  }
  addListener(event: string, l: any) {
    if (event === "onAudioChunk") this.chunkListeners.add(l);
    return { remove: () => this.chunkListeners.delete(l) };
  }
  mic(pcm: Buffer) {
    const b64 = pcm.toString("base64");
    this.chunkListeners.forEach((l) => l({ data: b64, durationMs: 200 }));
  }
}

async function main() {
  if (!KEY) throw new Error("No OPENAI_API_KEY in spike/.env");
  const audio = new FakeAudio();
  const interp = new Interpreter(
    audio,
    (url, key) => new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } }) as unknown as SocketLike,
    { apiKey: KEY, headphonesVolume: 1, speakerVolume: 1, listenOnly: false, showOriginal: true, noiseReduction: true },
  );
  let lastErr: string | null = null;
  let lastSess = "";
  let lastSent = -1;
  interp.subscribe((s) => {
    const sess = JSON.stringify(s.sessions) + " turn=" + s.turn;
    if (sess !== lastSess) console.log(`  [${now()} ms] sessions ${sess}`);
    lastSess = sess;
    const sent = Math.floor(s.sentSeconds);
    if (sent !== lastSent) { lastSent = sent; if (sent % 2 === 0) console.log(`  [${now()} ms] sent ${s.sentSeconds.toFixed(1)} s`); }
    if (s.error && s.error !== lastErr) console.log(`  [${now()} ms] ERROR: ${s.error}`);
    lastErr = s.error;
  });

  // Mic feed: 1 s silence, Mandarin clip, 2 s silence, English clip, 6 s silence.
  const zh = decode(path.join(ROOT, "samples", "zh-tw-1.mp3"));
  const en = decode(path.join(ROOT, "samples", "en-1.mp3"));
  const gap = (ms: number) => Buffer.alloc(ms * BPMS);
  const parts = [gap(1000), zh, gap(2000), en, gap(6000)];
  const feed = Buffer.concat(parts);
  const zhStart = 1000, zhEnd = zhStart + zh.length / BPMS;
  const enStart = zhEnd + 2000, enEnd = enStart + en.length / BPMS;

  // Taps: Them just after they start talking (preroll covers it), stop shortly after they finish.
  const taps: [number, "them" | "me", string][] = [
    [zhStart + 300, "them", "tap THEM (start)"],
    [zhEnd + 400, "them", "tap THEM (stop)"],
    [enStart + 200, "me", "tap ME (start)"],
    [enEnd + 400, "me", "tap ME (stop)"],
  ];

  T0 = performance.now();
  console.log("Connecting both translators...");
  await interp.start();
  console.log(`  started in ${now()} ms, status=${interp.state.status}`);
  if (interp.state.status !== "on") return;

  T0 = performance.now();
  const chunk = 200 * BPMS;
  let tap = 0;
  const DROP = process.argv.includes("--drop");
  let dropped = false;
  for (let i = 0, off = 0; off < feed.length; i++, off += chunk) {
    const wait = (i + 1) * 200 - now();
    if (wait > 0) await sleep(wait);
    audio.mic(feed.subarray(off, off + chunk));
    if (DROP && !dropped && now() >= zhStart + 4000) {
      dropped = true;
      console.log(`  [${now()} ms] SIMULATING A DROPPED CONNECTION (them)`);
      ((interp as any).sessions.them.ws as WebSocket).terminate();
    }
    while (tap < taps.length && now() >= taps[tap][0]) {
      console.log(`  [${now()} ms] ${taps[tap][2]}`);
      await interp.toggle(taps[tap][1]);
      tap++;
    }
  }
  await interp.stop();

  console.log("\nTranscript:");
  for (const e of interp.state.entries) {
    const orig = e.who === "them" ? toTaiwanese(e.original) : e.original;
    const tr = e.who === "me" ? toTaiwanese(e.translation) : e.translation;
    console.log(`  ${e.who.toUpperCase()}: ${orig.trim() || "(no original)"}\n     -> ${tr.trim() || "(no translation)"}`);
  }
  const outDir = path.join(ROOT, "out", "interp-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  mkdirSync(outDir, { recursive: true });
  for (const target of ["headphones", "speaker"] as OutputTarget[]) {
    const p = audio.played[target];
    const ms = p.reduce((a, x) => a + x.pcm.length / BPMS, 0);
    const end = target === "headphones" ? zhEnd : enEnd;
    const first = p[0] ? p[0].t - (target === "headphones" ? zhStart : enStart) : null;
    const last = p.at(-1) ? p.at(-1)!.t - end : null;
    console.log(`\n${target}: ${p.length} chunks, ${(ms / 1000).toFixed(1)} s played; first ${first} ms after speech start, last chunk ${last} ms after speech end`);
    writeFileSync(path.join(outDir, `${target}.wav`), wav(Buffer.concat(p.map((x) => x.pcm))));
  }
  console.log(`\nSent ${interp.state.sentSeconds.toFixed(1)} s of audio, cost ~$${interp.state.costUsd.toFixed(4)}. WAVs: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
