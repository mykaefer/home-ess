"""Lokale Piper-Synthese: UTF-8 auf stdin, WAV auf stdout, keine Audiodateien."""

import io
import json
import os
import sys
import wave
from pathlib import Path

MAX_AUDIO_BYTES = 16 * 1024 * 1024 - 44


def main():
    # Bereits vor dem Import sperren, damit ONNX auch keine Telemetrie-Kennung
    # im Arbeitsverzeichnis anlegt.
    os.environ["ORT_DISABLE_TELEMETRY"] = "1"
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    from piper import PiperVoice
    from piper.config import PiperConfig, SynthesisConfig

    model = Path(sys.argv[1])
    volume_percent = int(sys.argv[2])
    if not 10 <= volume_percent <= 100:
        raise ValueError("invalid_volume")
    text = sys.stdin.buffer.read(4097).decode("utf-8")
    if not text.strip() or len(text) > 650:
        raise ValueError("invalid_text")
    with Path(str(model) + ".json").open(encoding="utf-8") as config_file:
        config = PiperConfig.from_dict(json.load(config_file))
    # Ausschließlich das installierte deutsche Modell; keine Ressourcen zur
    # Laufzeit herunterladen. Andere Phonemizer könnten Downloads auslösen.
    if config.espeak_voice != "de" or config.phoneme_type.value != "espeak":
        raise ValueError("invalid_voice")

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    voice = PiperVoice(config=config, session=onnxruntime.InferenceSession(
        str(model), sess_options=options, providers=["CPUExecutionProvider"]
    ))
    output = io.BytesIO()
    written = 0
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(config.sample_rate)
        # Der gespeicherte Spitzenpegel gilt unverändert für die ganze Ansage.
        for chunk in voice.synthesize(text, SynthesisConfig(volume=volume_percent / 100, normalize_audio=True)):
            if chunk.sample_width != 2 or chunk.sample_channels != 1 or chunk.sample_rate != config.sample_rate:
                raise ValueError("invalid_audio")
            data = chunk.audio_int16_bytes
            written += len(data)
            if written > MAX_AUDIO_BYTES:
                raise ValueError("audio_too_large")
            wav.writeframesraw(data)
    if not written:
        raise ValueError("empty_audio")
    sys.stdout.buffer.write(output.getvalue())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Keine Eingabetexte, Dateiinhalte oder Tracebacks im Dienstprotokoll.
        sys.stderr.write("piper_synthesis_failed\n")
        sys.exit(1)
