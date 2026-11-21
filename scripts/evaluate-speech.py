"""Compare Atlas's Korean ASR models against fixed samples of spontaneous or read speech."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
DATA = "https://huggingface.co/datasets/yfyeung/ksponspeech-eval/resolve/222d27fb5cabf7ba18d5ac4db996784a827b2811/"
SAMPLES = [*range(8), 137, 493, 876, 1101]
FLEURS_ROWS = ("https://datasets-server.huggingface.co/rows"
               "?dataset=google%2Ffleurs&config=ko_kr&split=test&offset=0&length=12")
TRANSCRIBE = """
import { readFile } from 'node:fs/promises';
import { prepareTranscription, transcribeWav } from './transcribe.mjs';
const transcribe = process.argv[2] === 'openai' ? prepareTranscription('openai') : transcribeWav;
console.log(JSON.stringify(await transcribe(await readFile(process.argv[1]))));
"""


def fetch(url):
    with urllib.request.urlopen(url, timeout=45) as response:
        return response.read()


def write_wav(audio, path):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1",
                    "-ar", "16000", "-c:a", "pcm_s16le", str(path)], input=audio, check=True)


def samples(directory):
    for split in ("eval_clean", "eval_other"):
        lines = fetch(DATA + split + ".trn").decode().splitlines()
        for index in SAMPLES:
            filename, reference = lines[index].split(" :: ", 1)
            name = Path(filename).stem
            wav = directory / (name + ".wav")
            write_wav(fetch(DATA + f"{split}/{name}.flac"), wav)
            with wave.open(str(wav)) as recording:
                if recording.getnframes() > 25 * 16000:
                    continue
            reference = re.sub(r"\(([^()]*)\)/\(([^()]*)\)", r"\1", reference)
            yield wav, re.sub(r"\b[bonlu]/", "", reference)


def fleurs_samples(directory):
    rows = json.loads(fetch(FLEURS_ROWS))["rows"]
    if [item["row_idx"] for item in rows] != list(range(12)):
        raise ValueError("Expected Korean FLEURS test rows 0 through 11 in order.")
    for item in rows:
        row = item["row"]
        source = next((entry for entry in row["audio"] if entry["type"] == "audio/wav"), None)
        if source is None:
            raise ValueError(f"Missing FLEURS audio at test row {item['row_idx']}.")
        wav = directory / f"fleurs-ko-test-{item['row_idx']:03d}.wav"
        write_wav(fetch(source["src"]), wav)
        yield wav, row["transcription"]


def normalized(text):
    return "".join(letter for letter in text if letter.isalnum())


def errors(reference, hypothesis):
    previous = list(range(len(hypothesis) + 1))
    for i, wanted in enumerate(reference, 1):
        row = [i]
        for j, heard in enumerate(hypothesis, 1):
            row.append(min(previous[j] + 1, row[-1] + 1, previous[j - 1] + (wanted != heard)))
        previous = row
    return previous[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="*", type=Path, help="local whisper.cpp model files")
    parser.add_argument("--corpus", choices=["ksponspeech", "fleurs"], default="ksponspeech",
                        help="fixed Korean corpus to score (default: ksponspeech)")
    parser.add_argument("--openai", action="store_true",
                        help="also send these public evaluation clips to the configured, billable OpenAI API")
    parser.add_argument("--qwen", action="store_true", help="also evaluate the installed local Qwen3-ASR model")
    args = parser.parse_args()
    engines = [(p.name, "local", dict(os.environ, ATLAS_STT_PROVIDER="local", ATLAS_LOCAL_STT_ENGINE="whisper",
                                      ATLAS_WHISPER_MODEL=str(p.resolve(strict=True))))
               for p in args.models]
    probe = "import {transcriptionStatus} from './transcribe.mjs'; console.log(JSON.stringify(transcriptionStatus()))"
    for enabled, provider, settings in [
        (args.qwen, "local", {"ATLAS_LOCAL_STT_ENGINE": "qwen"}),
        (args.openai, "openai", {}),
    ]:
        if enabled:
            env = dict(os.environ, ATLAS_STT_PROVIDER=provider, **settings)
            status = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", probe],
                                                         cwd=ROOT, env=env, text=True))
            if not status["available"]:
                parser.error(status["detail"])
            engines.append((status["model"], provider, env))
    if not engines:
        parser.error("specify a local Whisper model path, --qwen, or --openai")
    with tempfile.TemporaryDirectory() as workspace:
        load_samples = fleurs_samples if args.corpus == "fleurs" else samples
        clips = list(load_samples(Path(workspace)))
        for name, provider, environment in engines:
            edits = characters = 0
            for wav, reference in clips:
                output = subprocess.check_output(["node", "--input-type=module", "-e", TRANSCRIBE, str(wav), provider],
                                                 cwd=ROOT, env=environment, text=True)
                expected = normalized(reference)
                edits += errors(expected, normalized(json.loads(output)))
                characters += len(expected)
            print(f"{name}: {len(clips)} clips, {edits}/{characters} ({edits/characters:.1%} CER)")


if __name__ == "__main__":
    main()
