@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
set "PYTHON_BIN=python"

if exist "%ROOT_DIR%\.venv\Scripts\python.exe" (
  set "PYTHON_BIN=%ROOT_DIR%\.venv\Scripts\python.exe"
)

start "Sonny faster-whisper" cmd /k ""%PYTHON_BIN%" "%SCRIPT_DIR%whisper-server.py""
start "Sonny TTS" cmd /k ""%PYTHON_BIN%" "%SCRIPT_DIR%qwen3-tts-server.py""
start "Sonny wake-word" cmd /k ""%PYTHON_BIN%" "%SCRIPT_DIR%wake-word-server.py""
