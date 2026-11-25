# Transcreve um áudio (ogg/opus do WhatsApp, mp3, wav...) para texto em português.
# Uso: python transcribe.py <arquivo> [modelo] [dica de vocabulário, ex.: nomes dos projetos]
import sys

import av
import numpy as np
from faster_whisper import WhisperModel


# Decodifica para mono 16 kHz aqui mesmo: o decode_audio do faster-whisper quebra com PyAV >= 15.
def load_audio(path):
    chunks = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(path) as container:
        for frame in container.decode(audio=0):
            chunks.extend(f.to_ndarray() for f in resampler.resample(frame))
        chunks.extend(f.to_ndarray() for f in resampler.resample(None))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks, axis=1).flatten().astype(np.float32) / 32768.0


sys.stdout.reconfigure(encoding="utf-8")
model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "small", device="cpu", compute_type="int8")
hint = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
segments, _ = model.transcribe(load_audio(sys.argv[1]), language="pt", vad_filter=True, initial_prompt=hint)
print(" ".join(s.text.strip() for s in segments).strip())
