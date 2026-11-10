// Prices from the OpenAI pricing page (Nov 2026). You pay for audio SENT, per session.
export const TRANSLATE_USD_PER_MIN = 0.034; // gpt-realtime-translate
export const TRANSCRIBE_USD_PER_MIN = 0.017; // gpt-realtime-whisper ("show original text")

export const TRANSLATE_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
export const TRANSCRIBE_MODEL = 'gpt-realtime-whisper';

export const PREROLL_CHUNKS = 2; // 400 ms of mic audio from just before you tapped
export const STOP_SILENCE_CHUNKS = 15; // 3 s of silence after "stop", sent at once, flushes the sentence
export const KEEP_SILENT_CHUNKS = 1; // keep at most one silent chunk in a row (a natural pause)
export const SESSION_REFRESH_BEFORE_EXPIRY_S = 120; // sessions expire ~60 min after creation
