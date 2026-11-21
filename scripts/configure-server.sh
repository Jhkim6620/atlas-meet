#!/bin/sh
set -eu
umask 077
export LC_ALL=C

usage() {
  echo '사용법: sh scripts/configure-server.sh 팀도메인 공인IPv4 [서버인터페이스IPv4]'
  echo '예시: sh scripts/configure-server.sh meet.example.org 203.0.113.10 10.0.1.4'
}
fail() { echo "$*" >&2; exit 1; }
if [ "${1:-}" = '--help' ]; then usage; exit 0; fi
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then usage >&2; exit 2; fi

domain=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
public_ip=$2
relay_ip=${3:-$public_ip}
valid_domain() {
  printf '%s\n' "$1" | awk -F. '
    NR != 1 || NF < 2 || length($0) > 253 || $NF ~ /^[0-9]+$/ { bad=1 }
    { for (i=1; i<=NF; i++) if (length($i)>63 || $i !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) bad=1 }
    END { exit bad }'
}
valid_ipv4() {
  printf '%s\n' "$1" | awk -F. '
    NR != 1 || NF != 4 { bad=1 }
    { for (i=1; i<=NF; i++) if ($i !~ /^(0|[1-9][0-9]?[0-9]?)$/ || $i+0 > 255) bad=1 }
    END { exit bad }'
}
valid_domain "$domain" || fail 'HTTPS 주소에 사용할 도메인 이름을 입력하세요. 예: meet.example.org'
valid_ipv4 "$public_ip" || fail '공인 IPv4 주소 형식을 확인하세요.'
valid_ipv4 "$relay_ip" || fail '서버 인터페이스의 IPv4 주소 형식을 확인하세요.'

cd "$(dirname "$0")/.."
secret_dir=.atlas-secrets
[ ! -L "$secret_dir" ] || fail '키 디렉터리의 경로를 확인하세요.'
mkdir -p "$secret_dir"
chmod 0700 "$secret_dir"
stage=$(mktemp -d "$secret_dir/configure.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM

# Publish complete keys atomically. Re-running setup reuses the original keys.
ensure_key() {
  name=$1
  target="$secret_dir/$name"
  [ ! -L "$target" ] || fail "키 파일 경로를 확인하세요: $target"
  if [ ! -e "$target" ]; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$stage/$name"
    [ "$(wc -c < "$stage/$name" | tr -d ' ')" = 64 ] || fail '키를 생성하지 못했습니다.'
    printf '\n' >> "$stage/$name"
    chmod 0444 "$stage/$name"
    ln "$stage/$name" "$target" 2>/dev/null || [ -f "$target" ] || fail "키를 설치하지 못했습니다: $target"
  fi
  [ -f "$target" ] && [ -s "$target" ] || fail "키 파일을 확인하세요: $target"
  # Compose bind-mounts each file separately for its non-root service.
  chmod 0444 "$target"
}
ensure_key turn-shared-secret
ensure_key room-creation-key

if [ -e .env ] || [ -L .env ]; then
  [ -f .env ] && [ ! -L .env ] || fail '.env 파일 경로를 확인하세요.'
  awk '!/^[[:space:]]*(export[[:space:]]+)?(MEET_DOMAIN|TURN_PUBLIC_IP|TURN_RELAY_IP)[[:space:]]*=/' .env > "$stage/compose.env"
else
  : > "$stage/compose.env"
fi
{
  printf 'MEET_DOMAIN=%s\n' "$domain"
  printf 'TURN_PUBLIC_IP=%s\n' "$public_ip"
  printf 'TURN_RELAY_IP=%s\n' "$relay_ip"
} >> "$stage/compose.env"
mv -f "$stage/compose.env" .env

printf '팀 회의 주소: https://%s\n' "$domain"
echo '회의 개설 키는 .atlas-secrets/room-creation-key에 있습니다.'
echo '실행 명령: docker compose up -d --build --wait'
