#!/bin/sh
# Installs the pinned local Qwen runtime for Apple Silicon.
set -eu
if [ "$(uname -s)-$(uname -m)" != Darwin-arm64 ]; then
  echo '이 모델 설치 스크립트는 Apple Silicon Mac에서 실행해 주세요.' >&2
  exit 1
fi
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
speech="$project/.speech"
target="$speech/qwen3"
model=qwen3-asr-1.7b-q4_k.gguf
revision=674df5d44b50a63e7102a18895ed20e3f91de301
model_sha=ec197cef7ccc589fdcae1becc3f4a3de119d0a41e790b898b519b1a048dad8d4
cli_sha=89cdb449b94e062065b842a2bfad65c3598665f627d99b2feeebee31e0564007
lib_sha=4e8fb55c1db2cf13ac5445dcd3e406112a8e920232a49378a63b53da07237d17
archive_sha=7b04a0ad344293f360636985e26a02efb8ef7f84fa2def991eaa3f4237f105dc

matches() {
  [ -f "$1" ] && [ "$(shasum -a 256 "$1" | cut -d ' ' -f 1)" = "$2" ]
}

# Silero checks each clip before loading the recognizer.
if [ ! -x "$speech/vad-speech-segments" ] || [ ! -f "$speech/ggml-silero-v5.1.2.bin" ]; then
  sh "$project/scripts/setup-speech.sh"
fi
mkdir -p "$target"
stage=$(mktemp -d "$speech/setup-qwen.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
if ! matches "$target/crispasr" "$cli_sha" || ! matches "$target/libc2pa_c.dylib" "$lib_sha"; then
  curl -fsSL --retry 3 'https://github.com/CrispStrobe/CrispASR/releases/download/v0.8.54/crispasr-macos-arm64.tar.gz' -o "$stage/cli.tgz"
  matches "$stage/cli.tgz" "$archive_sha" || { echo 'CrispASR 체크섬 오류' >&2; exit 1; }
  tar -xzf "$stage/cli.tgz" -C "$stage"
  cp "$stage/crispasr-macos-arm64/LICENSE" "$stage/crispasr-macos-arm64/THIRD_PARTY_NOTICES.txt" "$target/"
  mv "$stage/crispasr-macos-arm64/libc2pa_c.dylib" "$target/"
  mv "$stage/crispasr-macos-arm64/crispasr" "$target/"
fi
if ! matches "$target/$model" "$model_sha"; then
  curl -fsSL --retry 3 "https://huggingface.co/cstr/qwen3-asr-1.7b-GGUF/resolve/$revision/$model" -o "$stage/$model"
  matches "$stage/$model" "$model_sha" || { echo 'Qwen 모델 체크섬 오류' >&2; exit 1; }
  mv "$stage/$model" "$target/$model"
fi
chmod +x "$target/crispasr"
echo 'Qwen 한국어 전사 엔진 준비 완료'
