#!/bin/sh
# Build the local Korean transcription engine with CMake and a C/C++ toolchain.
set -eu

project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install="$project/.speech"
mkdir -p "$install"
stage=$(mktemp -d "$install/setup.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM

check_sha() {
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$1" | cut -d ' ' -f 1)
  else
    actual=$(sha256sum "$1" | cut -d ' ' -f 1)
  fi
  test "$actual" = "$2"
}

source_rev=4979e04f5dcaccb36057e059bbaed8a2f5288315
source_sha=ec8e33f4c838ed459ad0a23da255c0262f150a6f54839a17e504ddf1495305d5
model_rev=c4f74b15c9d4e7889871c5450327b5fd1f13f059
model_sha=fa112c2285b8b61525cf87b1693bfab5fc21ff511287e2b586974a7b58ca9d7f

metal=OFF
if [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ]; then metal=ON; fi
build_id="$source_rev-metal-$metal"

if [ ! -x "$install/whisper-cli" ] || [ ! -x "$install/vad-speech-segments" ] || [ "$(cat "$install/version" 2>/dev/null || true)" != "$build_id" ]; then
  echo "whisper.cpp v1.8.2 빌드 중"
  mkdir "$stage/src"
  curl --fail --location --retry 3 --silent --show-error "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/$source_rev" -o "$stage/engine.tar.gz"
  check_sha "$stage/engine.tar.gz" "$source_sha" || { echo "엔진 소스 체크섬 오류" >&2; exit 1; }
  tar -xzf "$stage/engine.tar.gz" -C "$stage/src" --strip-components=1
  cmake -S "$stage/src" -B "$stage/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_METAL="$metal" -DGGML_METAL_EMBED_LIBRARY="$metal" -DGGML_OPENMP=OFF
  cmake --build "$stage/build" --config Release --target whisper-cli vad-speech-segments --parallel 3
  cp "$stage/src/LICENSE" "$install/whisper.cpp-LICENSE"
  mv "$stage/build/bin/whisper-cli" "$install/whisper-cli"
  mv "$stage/build/bin/vad-speech-segments" "$install/vad-speech-segments"
  echo "$build_id" > "$install/version"
  rm -rf "$stage/build" "$stage/src" "$stage/engine.tar.gz"
fi
if [ ! -f "$install/ggml-whisper-large-v3-turbo-korean-q5_0.bin" ] || ! check_sha "$install/ggml-whisper-large-v3-turbo-korean-q5_0.bin" "$model_sha"; then
  echo "한국어 미세조정 Whisper large-v3-turbo 모델 다운로드 중 (약 574 MB)"
  curl --fail --location --retry 3 --silent --show-error "https://huggingface.co/JoaoZaokk/whisper-large-v3-turbo-korean-ggml/resolve/$model_rev/ggml-whisper-large-v3-turbo-korean-q5_0.bin" -o "$stage/model.bin"
  check_sha "$stage/model.bin" "$model_sha" || { echo "음성 인식 모델 체크섬 오류" >&2; exit 1; }
  mv "$stage/model.bin" "$install/ggml-whisper-large-v3-turbo-korean-q5_0.bin"
fi
vad_file=ggml-silero-v5.1.2.bin
vad_sha=29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf
if [ ! -f "$install/$vad_file" ] || ! check_sha "$install/$vad_file" "$vad_sha"; then
  curl --fail --location --retry 3 --silent --show-error "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/$vad_file" -o "$stage/vad.bin"
  check_sha "$stage/vad.bin" "$vad_sha" || { echo "발화 감지 모델 체크섬 오류" >&2; exit 1; }
  mv "$stage/vad.bin" "$install/$vad_file"
fi
echo "로컬 전사 엔진 준비 완료"
