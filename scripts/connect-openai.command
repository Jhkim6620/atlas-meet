#!/bin/bash
# The API key is entered in a local terminal; curl receives its header on stdin.
set -eu
set +x
umask 077
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
project=$(cd -- "$script_dir/.." && pwd)
if [ "${1:-}" = "--compose" ]; then
  destination="$project/.atlas-secrets"
  mode=0444
elif [ "$#" -eq 0 ] && [ "$(uname -s)" = Darwin ]; then
  destination="$HOME/Library/Application Support/Atlas Meet/secrets"
  mode=0600
else
  echo '이 Mac에서는 인수 없이 실행하세요. Linux에서는 --compose를 사용하세요.' >&2
  exit 2
fi
if command -v node >/dev/null 2>&1; then
  parser=node
elif command -v python3 >/dev/null 2>&1; then
  parser=python3
else
  echo '연결 시험 결과를 확인하려면 Node.js 또는 Python 3을 설치해 주세요.' >&2
  exit 1
fi
echo 'OpenAI 전사 연결'
echo '키를 입력하면 합성 한국어 음성 약 4초로 gpt-transcribe를 한 번 시험합니다.'
echo '테스트와 이후 회의 전사는 OpenAI API 계정에 과금됩니다.'
printf '서버용 OpenAI API 키 (입력 내용은 표시되지 않습니다): ' >/dev/tty
IFS= read -rs key </dev/tty
printf '\n' >/dev/tty
case "$key" in ''|*[!A-Za-z0-9_.-]*) echo 'API 키 형식을 확인하세요.' >&2; exit 2;; esac
[ ! -L "$destination" ] || { echo '키 디렉터리 경로를 확인하세요.' >&2; exit 1; }
mkdir -p "$destination"
chmod 0700 "$destination"
stage=$(mktemp -d "$destination/connect.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' INT HUP TERM
if ! status=$(printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -q --config - \
    --silent --show-error --proto '=https' --connect-timeout 10 --max-time 90 \
    --output "$stage/result" --write-out '%{http_code}' \
    --form "file=@$script_dir/stt-check-ko.wav;type=audio/wav" --form-string 'model=gpt-transcribe' \
    --form-string 'languages[]=ko' --form-string 'response_format=json' \
    https://api.openai.com/v1/audio/transcriptions); then
  echo 'OpenAI API에 연결하지 못했습니다. 네트워크를 확인하세요.' >&2; exit 1
fi
case "$status" in
  200) ;;
  401|403) echo "키 또는 모델 사용 권한을 확인하세요 (HTTP $status)." >&2; exit 1;;
  429) echo 'API 계정의 크레딧과 사용량 한도를 확인하세요 (HTTP 429).' >&2; exit 1;;
  *) echo "시험 전사에 실패했습니다 (HTTP $status). 키 설정은 이전 상태입니다." >&2; exit 1;;
esac
if [ "$parser" = node ]; then
  transcript=$(node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); if (typeof r.text === "string") process.stdout.write(r.text.trim())' < "$stage/result") || exit 1
else
  transcript=$(python3 -c 'import json, sys; s = json.load(sys.stdin).get("text"); print(s.strip() if isinstance(s, str) else "")' < "$stage/result") || exit 1
fi
if [ -z "$transcript" ]; then
  echo '응답에 전사 텍스트가 없습니다. 키 설정은 이전 상태입니다.' >&2; exit 1
fi
printf '%s\n' "$key" > "$stage/key"
unset key
chmod "$mode" "$stage/key"
mv -f "$stage/key" "$destination/openai-api-key"
echo '시험 음성 원문  이번 주에는 검색 정확도와 응답 속도를 함께 점검합니다.'
printf 'OpenAI 전사     %s\n' "$transcript"
if [ "${1:-}" = "--compose" ]; then
  echo '적용: docker compose -f compose.yaml -f compose.openai.yaml up -d --build --wait'
else
  echo '회의실을 새로고침해 내 발언 전사의 OpenAI 표시를 확인하세요.'
fi
