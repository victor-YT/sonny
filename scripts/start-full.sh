#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "${PROJECT_ROOT}/.env"
  set +a
fi

normalize_base_url() {
  printf '%s\n' "${1%/}"
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local timeout_seconds="$3"
  local deadline=$((SECONDS + timeout_seconds))

  until curl -fsS --max-time 2 "${url}" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      printf '%s failed health check: %s\n' "${name}" "${url}" >&2
      exit 1
    fi

    sleep 1
  done

  printf '%s healthy: %s\n' "${name}" "${url}"
}

STT_HEALTH_URL="$(normalize_base_url "${FASTER_WHISPER_URL:-http://127.0.0.1:8000}")/health"
TTS_HEALTH_URL="$(normalize_base_url "${CHATTERBOX_URL:-http://127.0.0.1:8001}")/health"
STARTUP_TIMEOUT_SECONDS="$(( (${SONNY_SERVICE_STARTUP_TIMEOUT_MS:-120000} + 999) / 1000 ))"

bash "${PROJECT_ROOT}/scripts/start-services.sh"
wait_for_health "whisper" "${STT_HEALTH_URL}" "${STARTUP_TIMEOUT_SECONDS}"
wait_for_health "qwen3-tts" "${TTS_HEALTH_URL}" "${STARTUP_TIMEOUT_SECONDS}"

cd "${PROJECT_ROOT}"
exec pnpm start
