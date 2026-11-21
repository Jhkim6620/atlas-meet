#!/bin/sh
set -eu

: "${MEET_DOMAIN:?MEET_DOMAIN is required}"
: "${TURN_RELAY_IP:?TURN_RELAY_IP is required}"
: "${TURN_PUBLIC_IP:?TURN_PUBLIC_IP is required}"

# The shared signing key stays in a mode-0600 config on tmpfs, outside process arguments.
umask 077
config=$(mktemp /tmp/atlas-turn.XXXXXX)
secret=$(cat "${TURN_SHARED_SECRET_FILE:-/run/secrets/turn_shared_secret}")
if [ "${#secret}" -ne 64 ]; then
    echo "Expected a 32-byte hex TURN signing key." >&2
    exit 1
fi
case "$secret" in
    *[!0-9a-fA-F]*) echo "TURN signing key must be hexadecimal." >&2; exit 1 ;;
esac

cat > "$config" <<SETTINGS
use-auth-secret
static-auth-secret=$secret
fingerprint
no-cli
no-tls
no-dtls
no-tcp-relay
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
min-port=49160
max-port=49415
listening-port=3478
log-file=stdout
pidfile=/tmp/turnserver.pid
SETTINGS
unset secret

external=$TURN_PUBLIC_IP
if [ "$TURN_PUBLIC_IP" != "$TURN_RELAY_IP" ]; then
    external="$TURN_PUBLIC_IP/$TURN_RELAY_IP"
fi
exec turnserver -c "$config" --realm="$MEET_DOMAIN" \
    --listening-ip="$TURN_RELAY_IP" --relay-ip="$TURN_RELAY_IP" --external-ip="$external"
