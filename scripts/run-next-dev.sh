#!/usr/bin/env bash
set -euo pipefail

app_port="${APP_PORT:-3000}"
dev_pid=""

export FSAMP_DEMO_USERNAME="${FSAMP_DEMO_USERNAME:-fsamp}"
if [[ -z "${FSAMP_DEMO_PASSWORD:-}" ]]; then
    export FSAMP_DEMO_PASSWORD
    FSAMP_DEMO_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')"
fi

kill_tree() {
    local pid="$1"
    local child

    while read -r child; do
        [[ -z "$child" ]] && continue
        kill_tree "$child"
    done < <(pgrep -P "$pid" 2>/dev/null || true)

    kill "$pid" 2>/dev/null || true
}

cleanup() {
    if [[ -n "$dev_pid" ]] && kill -0 "$dev_pid" 2>/dev/null; then
        kill_tree "$dev_pid"
        wait "$dev_pid" 2>/dev/null || true
    fi
}

busy_pids="$(lsof -tiTCP:"$app_port" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$busy_pids" ]]; then
    echo "Port $app_port is already in use by: $busy_pids"
    echo "Run 'make stop' first."
    exit 1
fi

trap cleanup INT TERM EXIT

echo "Demo URL: http://127.0.0.1:${app_port}"
echo "Demo login: ${FSAMP_DEMO_USERNAME} / ${FSAMP_DEMO_PASSWORD}"

npm run dev -- --port "$app_port" &
dev_pid="$!"
wait "$dev_pid"
