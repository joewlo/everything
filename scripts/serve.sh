#!/usr/bin/env bash
# Start llama.cpp & whisper.cpp servers
# Customize with env vars: LLM_PORT WHISPER_PORT LLM_FILE WHISPER_FILE MODELS_DIR

set -euo pipefail

MODELS_DIR="${MODELS_DIR:-$HOME/.everything/models}"
LLM_PORT="${LLM_PORT:-8080}"
WHISPER_PORT="${WHISPER_PORT:-8081}"
LLM_FILE="${LLM_FILE:-gemma-4-E4B-it-Q4_K_M.gguf}"
WHISPER_FILE="${WHISPER_FILE:-ggml-base.en.bin}"

cleanup() {
  echo ""
  echo "Shutting down servers..."
  kill $LLM_PID 2>/dev/null || true
  kill $W_PID 2>/dev/null || true
  wait
}
trap cleanup EXIT INT TERM

echo "═══════════════════════════════════════"
echo "  Starting Everything servers..."
echo "═══════════════════════════════════════"
echo ""

# Start LLM server
if [ -f "$MODELS_DIR/$LLM_FILE" ]; then
  echo "→ LLM server on port $LLM_PORT"
  echo "  Model: $LLM_FILE"
  llama-server \
    --port "$LLM_PORT" \
    --model "$MODELS_DIR/$LLM_FILE" \
    --ctx-size 8192 \
    --n-gpu-layers 99 \
    --host 127.0.0.1 &
  LLM_PID=$!
  echo "  PID: $LLM_PID"
else
  echo "✗ LLM model not found: $MODELS_DIR/$LLM_FILE"
  echo "  Run: npm run setup"
  LLM_PID=""
fi

echo ""

# Start whisper server
if [ -f "$MODELS_DIR/$WHISPER_FILE" ]; then
  echo "→ Whisper server on port $WHISPER_PORT"
  echo "  Model: $WHISPER_FILE"

  if command -v whisper-server &>/dev/null; then
    whisper-server \
      --port "$WHISPER_PORT" \
      --model "$MODELS_DIR/$WHISPER_FILE" \
      --host 127.0.0.1 &
    W_PID=$!
    echo "  PID: $W_PID"
  else
    echo "  ✗ whisper-server not found in PATH"
    echo "    Run: npm run setup"
    W_PID=""
  fi
else
  echo "✗ Whisper model not found: $MODELS_DIR/$WHISPER_FILE"
  echo "  Run: npm run setup"
  W_PID=""
fi

echo ""
echo "───────────────────────────────────────"
echo "  Servers running. Press Ctrl+C to stop."
echo "  Then start the app with: npm start"
echo "───────────────────────────────────────"
echo ""

wait
