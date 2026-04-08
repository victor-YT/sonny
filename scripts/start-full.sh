#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${TMPDIR:-/tmp}/sonny-services"
LOG_DIR="${RUNTIME_ROOT}/logs"

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
  local log_file="${LOG_DIR}/${name}.log"
  local deadline=$((SECONDS + timeout_seconds))
  local last_error="health check did not return success"

  until true; do
    local http_status
    local curl_output

    curl_output="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "${url}" 2>&1)" || true
    http_status="${curl_output##*$'\n'}"

    if [[ "${http_status}" =~ ^2[0-9][0-9]$ ]]; then
      printf '%s healthy: %s\n' "${name}" "${url}"
      return
    fi

    if [[ "${http_status}" =~ ^[0-9]{3}$ ]] && [[ "${http_status}" != "000" ]]; then
      last_error="HTTP ${http_status} from ${url}"
    else
      last_error="${curl_output:-unable to connect to ${url}}"
    fi

    if (( SECONDS >= deadline )); then
      printf '%s failed health check after %ss: %s\n' "${name}" "${timeout_seconds}" "${url}" >&2
      printf 'Reason: %s\n' "${last_error}" >&2

      if [[ -f "${log_file}" ]]; then
        printf 'Last 10 log lines from %s:\n' "${log_file}" >&2
        tail -n 10 "${log_file}" >&2 || true
      else
        printf 'No log file found for %s at %s\n' "${name}" "${log_file}" >&2
      fi

      exit 1
    fi

    sleep 1
  done
}

STT_HEALTH_URL="$(normalize_base_url "${FASTER_WHISPER_URL:-http://127.0.0.1:8000}")/health"
TTS_HEALTH_URL="$(normalize_base_url "${CHATTERBOX_URL:-http://127.0.0.1:8001}")/health"
VAD_HEALTH_URL="$(normalize_base_url "${VAD_URL:-http://127.0.0.1:8003}")/health"
STARTUP_TIMEOUT_SECONDS="$(( (${SONNY_SERVICE_STARTUP_TIMEOUT_MS:-30000} + 999) / 1000 ))"

bash "${PROJECT_ROOT}/scripts/start-services.sh"
wait_for_health "whisper" "${STT_HEALTH_URL}" "${STARTUP_TIMEOUT_SECONDS}"
wait_for_health "qwen3-tts" "${TTS_HEALTH_URL}" "${STARTUP_TIMEOUT_SECONDS}"
wait_for_health "vad" "${VAD_HEALTH_URL}" "${STARTUP_TIMEOUT_SECONDS}"

cd "${PROJECT_ROOT}"
exec pnpm start:electron
