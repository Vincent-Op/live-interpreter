"""Generate test clips with Microsoft Edge neural TTS (Taiwan Mandarin + US English).

TTS is clean studio audio, so it's the best case. For a realistic test, also record
real speech (a Taiwanese speaker, a noisy street) and pass it to the spike with --file.

Usage: spike/.venv/Scripts/python spike/make_samples.py
"""
import asyncio
from pathlib import Path

import edge_tts

OUT = Path(__file__).parent / "samples"

SAMPLES = {
    # Taiwan vocabulary on purpose: 捷運, 台北車站, 夜市, 你吃飽了沒
    "zh-tw-1": ("zh-TW-HsiaoYuNeural",
                "不好意思，請問一下，這附近有沒有捷運站？我想去台北車站，大概要走多久啊？"),
    "zh-tw-2": ("zh-TW-HsiaoChenNeural",
                "你吃飽了沒？我們等一下去夜市吃東西好不好？我知道一家很好吃的蚵仔煎。"),
    "en-1": ("en-US-AndrewNeural",
             "Excuse me, could you tell me how to get to the nearest MRT station? "
             "I'd also like to find a good night market around here."),
    "en-2": ("en-US-GuyNeural",
             "Thanks so much. How much is this one, and do you take credit cards?"),
}


async def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, (voice, text) in SAMPLES.items():
        path = OUT / f"{name}.mp3"
        await edge_tts.Communicate(text, voice).save(str(path))
        print(f"wrote {path.name}  ({voice})  {text}")


asyncio.run(main())
