#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_NAME="${SHERPA_ONNX_MODEL_NAME:-sherpa-onnx-streaming-paraformer-bilingual-zh-en}"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2"
MODEL_ROOT="${SHERPA_ONNX_MODEL_ROOT:-${PROJECT_ROOT}/models}"
ARCHIVE_PATH="${MODEL_ROOT}/${MODEL_NAME}.tar.bz2"

mkdir -p "${MODEL_ROOT}"

if [[ -d "${MODEL_ROOT}/${MODEL_NAME}" ]]; then
  printf 'Model already exists: %s\n' "${MODEL_ROOT}/${MODEL_NAME}"
  exit 0
fi

printf 'Downloading %s\n' "${MODEL_URL}"
curl -L "${MODEL_URL}" -o "${ARCHIVE_PATH}"

printf 'Extracting %s\n' "${ARCHIVE_PATH}"
tar -xjf "${ARCHIVE_PATH}" -C "${MODEL_ROOT}"

printf 'Model ready: %s\n' "${MODEL_ROOT}/${MODEL_NAME}"
printf 'Use:\n'
printf '  SHERPA_ONNX_MODEL_DIR=%s/%s\n' "${MODEL_ROOT}" "${MODEL_NAME}"
printf '  SHERPA_ONNX_ENCODER=encoder.int8.onnx\n'
printf '  SHERPA_ONNX_DECODER=decoder.int8.onnx\n'
printf '  SHERPA_ONNX_TOKENS=tokens.txt\n'
