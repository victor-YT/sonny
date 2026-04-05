#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${TMPDIR:-/tmp}/sonny-services"
LOG_DIR="${RUNTIME_ROOT}/logs"
PID_DIR="${RUNTIME_ROOT}/pids"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

if [[ -x "${PROJECT_ROOT}/.venv/bin/python" ]]; then
  PYTHON_BIN="${PROJECT_ROOT}/.venv/bin/python"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

services=(
  "whisper:${PROJECT_ROOT}/scripts/whisper-server.py"
  "qwen3-tts:${PROJECT_ROOT}/scripts/qwen3-tts-server.py"
  "wake-word:${PROJECT_ROOT}/scripts/wake-word-server.py"
)

missing_scripts=()

for service in "${services[@]}"; do
  name="${service%%:*}"
  script_path="${service#*:}"

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

child_pids=()

cleanup() {
  printf '\nStopping services...\n'

  for pid in "${child_pids[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done

  for pid_file in "${PID_DIR}"/*.pid; do
    [[ -f "${pid_file}" ]] && rm -f "${pid_file}"
  done

  wait 2>/dev/null || true
  printf 'All services stopped.\n'
}

trap cleanup EXIT INT TERM

for service in "${services[@]}"; do
  name="${service%%:*}"
  script_path="${service#*:}"
  pid_file="${PID_DIR}/${name}.pid"
  log_file="${LOG_DIR}/${name}.log"

  if [[ -f "${pid_file}" ]]; then
    existing_pid="$(<"${pid_file}")"

    if kill -0 "${existing_pid}" 2>/dev/null; then
      printf '%s already running (pid %s)\n' "${name}" "${existing_pid}"
      continue
    fi

    rm -f "${pid_file}"
  fi

  "${PYTHON_BIN}" "${script_path}" >"${log_file}" 2>&1 &
  pid=$!
  child_pids+=("${pid}")
  printf '%s' "${pid}" >"${pid_file}"
  printf 'Started %s (pid %s) log=%s\n' "${name}" "${pid}" "${log_file}"
done

printf 'All services running. Press Ctrl+C to stop.\n'
wait
