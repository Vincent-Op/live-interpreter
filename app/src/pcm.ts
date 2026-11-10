// Base64 PCM16 helpers. Pure TS (no React Native imports) so the Node test harness can use it too.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;

export const RATE = 24000;
export const BYTES_PER_MS = (RATE * 2) / 1000;

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

export function base64ToBytes(b64: string): Uint8Array {
  let len = b64.length;
  while (len > 0 && b64[len - 1] === '=') len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const n =
      (LOOKUP[b64.charCodeAt(i)] << 18) |
      (LOOKUP[b64.charCodeAt(i + 1)] << 12) |
      ((i + 2 < len ? LOOKUP[b64.charCodeAt(i + 2)] : 0) << 6) |
      (i + 3 < len ? LOOKUP[b64.charCodeAt(i + 3)] : 0);
    out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Milliseconds of audio in a base64 PCM16 chunk. */
export function chunkMs(b64: string): number {
  return base64ToBytes(b64).length / BYTES_PER_MS;
}

/**
 * True if the chunk contains speech. The translation stream is continuous and includes a lot of
 * silence (it runs ~2x longer than the input), so silent chunks must be skipped or delay builds up.
 */
export function voicedMs(b64: string, threshold = 300): number {
  const bytes = base64ToBytes(b64);
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const frame = 480; // 20 ms
  let voiced = 0;
  for (let off = 0; off + frame <= samples.length; off += frame) {
    let sum = 0;
    for (let i = off; i < off + frame; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / frame) > threshold) voiced += 20;
  }
  return voiced;
}

/** 200 ms of digital silence, sent after "stop" so the translator finishes the sentence. */
export const SILENT_CHUNK_200MS = bytesToBase64(new Uint8Array(200 * BYTES_PER_MS));
