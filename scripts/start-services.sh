#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${TMPDIR:-/tmp}/sonny-services"
LOG_DIR="${RUNTIME_ROOT}/logs"
PID_DIR="${RUNTIME_ROOT}/pids"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "${PROJECT_ROOT}/.env"
  set +a
fi

if [[ -x "${PROJECT_ROOT}/.venv/bin/python" ]]; then
  PYTHON_BIN="${PROJECT_ROOT}/.venv/bin/python"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

normalize_base_url() {
  printf '%s\n' "${1%/}"
}

extract_port_from_url() {
  local url="$1"
  local authority="${url#*://}"

  authority="${authority%%/*}"

  if [[ "${authority}" == *:* ]]; then
    printf '%s\n' "${authority##*:}"
    return
  fi

  printf '80\n'
}

is_port_in_use() {
  local port="$1"

  lsof -tiTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
}

is_pid_running() {
  local pid="$1"

  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

STT_BASE_URL="$(normalize_base_url "${FASTER_WHISPER_URL:-http://127.0.0.1:8000}")"
TTS_BASE_URL="$(normalize_base_url "${CHATTERBOX_URL:-http://127.0.0.1:8001}")"
STT_PORT="$(extract_port_from_url "${STT_BASE_URL}")"
TTS_PORT="$(extract_port_from_url "${TTS_BASE_URL}")"

services=(
  "whisper:${PROJECT_ROOT}/scripts/whisper-server.py:${STT_PORT}"
  "qwen3-tts:${PROJECT_ROOT}/scripts/qwen3-tts-server.py:${TTS_PORT}"
  "wake-word:${PROJECT_ROOT}/scripts/wake-word-server.py:"
)

missing_scripts=()

for service in "${services[@]}"; do
  IFS=':' read -r name script_path port <<<"${service}"

  if [[ ! -f "${script_path}" ]]; then
    missing_scripts+=("${name}:${script_path}")
  fi
done

if (( ${#missing_scripts[@]} > 0 )); then
  printf 'Missing service scripts:\n' >&2

  for missing in "${missing_scripts[@]}"; do
    printf '  %s\n' "${missing}" >&2
  done

  exit 1
fi

for service in "${services[@]}"; do
  IFS=':' read -r name script_path port <<<"${service}"
  pid_file="${PID_DIR}/${name}.pid"
  log_file="${LOG_DIR}/${name}.log"

  if [[ -f "${pid_file}" ]]; then
    existing_pid="$(<"${pid_file}")"

    if is_pid_running "${existing_pid}"; then
      printf '%s already running (pid %s)\n' "${name}" "${existing_pid}"
      continue
    fi

    rm -f "${pid_file}"
  fi

  if [[ -n "${port}" ]] && is_port_in_use "${port}"; then
    printf '%s skipped because port %s is already in use\n' "${name}" "${port}"
    continue
  fi

  nohup "${PYTHON_BIN}" "${script_path}" >"${log_file}" 2>&1 < /dev/null &
  pid=$!
  printf '%s' "${pid}" >"${pid_file}"
  printf 'Started %s (pid %s) log=%s\n' "${name}" "${pid}" "${log_file}"
done

printf 'Service startup complete.\n'
