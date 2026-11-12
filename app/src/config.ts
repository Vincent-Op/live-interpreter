// Prices from the OpenAI pricing page (Nov 2026). You pay for audio SENT, per session.
export const TRANSLATE_USD_PER_MIN = 0.034; // gpt-realtime-translate
export const TRANSCRIBE_USD_PER_MIN = 0.017; // gpt-realtime-whisper ("show original text")

export const TRANSLATE_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
export const TRANSCRIBE_MODEL = 'gpt-realtime-whisper';

export const STOP_SILENCE_CHUNKS = 15; // 3 s of silence after "stop", sent at once, flushes the sentence
export const KEEP_SILENT_CHUNKS = 1; // keep at most one silent 400 ms chunk in a row (a natural pause)
export const VOICED_THRESHOLD = 150; // RMS (of 32767) for a 20 ms frame to count as sound
export const VOICED_MIN_MS = 20; // a chunk with at least this much sound is played
export const ME_DONE_AFTER_MS = 2500; // no Mandarin audio for this long after ME stops -> back to AirPods
export const NO_RESULT_AFTER_MS = 7000; // no translation this long after a turn ends -> "didn't catch that"
export const SESSION_REFRESH_BEFORE_EXPIRY_S = 120; // sessions expire ~60 min after creation
export const IDLE_DISCONNECT_MS = 5 * 60_000; // close idle translator sockets (next tap reconnects in ~1 s)
export const IDLE_STOP_MS = 20 * 60_000; // stop the mic entirely after this long without a tap
