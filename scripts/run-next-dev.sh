#!/usr/bin/env bash
set -euo pipefail

app_port="${APP_PORT:-3000}"
dev_pid=""

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

npm run dev &
dev_pid="$!"
wait "$dev_pid"
