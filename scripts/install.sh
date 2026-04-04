#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:8b}"
OLLAMA_PID=""
declare -a MISSING_FORMULAE=()

log() {
  printf '[sonny-install] %s\n' "$1"
}

fail() {
  printf '[sonny-install] %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "${OLLAMA_PID}" ]; then
    kill "${OLLAMA_PID}" >/dev/null 2>&1 || true
    wait "${OLLAMA_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    fail 'install.sh currently supports macOS only because Sonny playback depends on afplay and Homebrew.'
  fi
}

require_brew() {
  if ! command -v brew >/dev/null 2>&1; then
    fail 'Homebrew is required. Install it from https://brew.sh and run this script again.'
  fi
}

queue_formula_if_missing() {
  local command_name="$1"
  local formula_name="$2"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    MISSING_FORMULAE+=("${formula_name}")
  fi
}

install_missing_formulae() {
  if [ "${#MISSING_FORMULAE[@]}" -eq 0 ]; then
    log 'All required Homebrew packages are already installed.'
    return
  fi

  log "Installing missing dependencies with Homebrew: ${MISSING_FORMULAE[*]}"
  brew install "${MISSING_FORMULAE[@]}"
}

install_node_dependencies() {
  log 'Installing project dependencies with pnpm.'
  (cd "${ROOT_DIR}" && pnpm install)
}

create_data_layout() {
  log 'Creating Sonny data directories and placeholder files.'

  mkdir -p "${ROOT_DIR}/data/memory"

  touch \
    "${ROOT_DIR}/data/memory/facts.md" \
    "${ROOT_DIR}/data/memory/goals.md" \
    "${ROOT_DIR}/data/memory/patterns.md" \
    "${ROOT_DIR}/data/memory/preferences.md"

  if [ ! -f "${ROOT_DIR}/data/monitors.json" ]; then
    cat <<'EOF' > "${ROOT_DIR}/data/monitors.json"
{
  "monitors": []
}
EOF
  fi

  if [ ! -f "${ROOT_DIR}/data/personality.json" ]; then
    cat <<'EOF' > "${ROOT_DIR}/data/personality.json"
{
  "name": "Sonny",
  "voice": "Local-first, concise, pragmatic, and mildly unimpressed by avoidable mistakes.",
  "verbosity": "Keep answers tight by default. Expand only when the user asks or the task genuinely needs it.",
  "assertiveness": "Make clear recommendations, challenge weak assumptions, and prefer action over ceremony.",
  "humor": "Dry, light, and sparing. Jokes should read like diagnostics, not a comedy routine.",
  "interruption_policy": "If the request is vague, pin down the missing constraint fast and keep moving. Do not derail a clear task with unnecessary questions."
}
EOF
  fi
}

copy_env_file() {
  if [ ! -f "${ROOT_DIR}/.env.example" ]; then
    log '.env.example does not exist yet. Skipping .env bootstrap.'
    return
  fi

  if [ -f "${ROOT_DIR}/.env" ]; then
    log '.env already exists. Leaving it unchanged.'
    return
  fi

  cp "${ROOT_DIR}/.env.example" "${ROOT_DIR}/.env"
  log 'Created .env from .env.example.'
}

ensure_ollama_ready() {
  if ollama list >/dev/null 2>&1; then
    return
  fi

  log 'Starting a temporary Ollama daemon so the default model can be pulled.'
  ollama serve >/tmp/sonny-ollama.log 2>&1 &
  OLLAMA_PID="$!"
  sleep 3

  if ! ollama list >/dev/null 2>&1; then
    fail 'Ollama did not become ready. Check /tmp/sonny-ollama.log and try again.'
  fi
}

pull_default_model() {
  ensure_ollama_ready
  log "Pulling default Ollama model: ${DEFAULT_OLLAMA_MODEL}"
  ollama pull "${DEFAULT_OLLAMA_MODEL}"
}

main() {
  require_macos
  require_brew

  queue_formula_if_missing node node
  queue_formula_if_missing pnpm pnpm
  queue_formula_if_missing ollama ollama
  queue_formula_if_missing sox sox

  install_missing_formulae
  install_node_dependencies
  create_data_layout
  copy_env_file
  pull_default_model

  log 'Install complete.'
}

main "$@"
