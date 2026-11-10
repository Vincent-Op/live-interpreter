# Phase 0 spike

Two parallel `gpt-realtime-translate` sessions (targets `en` and `zh`) fed the same audio in real time.

```
cd spike
npm install
echo OPENAI_API_KEY=sk-... > .env       # gitignored
npm run probe                           # which language codes are accepted
npm run spike                           # zh clip, en clip, and a mixed 4-turn conversation (~$0.13)
npm run spike -- --file my.m4a --lang zh   # your own recording
```

Options: `--only mixed`, `--noise far_field|near_field|off`, `--no-transcribe`, `--tail 6` (s of trailing silence), `--gap 3`, `--dry` (no network).

Output lands in `spike/out/<timestamp>/<scenario>/`: `input.wav`, `out-en.wav`, `out-zh.wav`, `events-*.jsonl` (every server event, audio payloads replaced by byte counts), and `report.json`.

Test clips come from `make_samples.py` (Microsoft Edge neural TTS, zh-TW and en-US voices). TTS is the best case; real street recordings matter more.
