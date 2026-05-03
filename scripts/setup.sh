#!/usr/bin/env bash
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
MODELS_DIR="${MODELS_DIR:-$HOME/.everything/models}"
mkdir -p "$MODELS_DIR"

# Whisper model (base.en = 140MB, good balance)
WHISPER_FILE="${WHISPER_FILE:-ggml-base.en.bin}"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_FILE"

# LLM model — pick E4B (4.5B effective) or E2B (2.3B effective, faster)
# Override with MODEL=2 or MODEL=4, or choose interactively
LLM_SIZE="${MODEL:-}"
if [ -z "$LLM_SIZE" ]; then
  echo ""
  echo "  Choose a model:"
  echo "    1) Gemma 4 E2B (2.3B effective, fast — best for laptops)"
  echo "    2) Gemma 4 E4B (4.5B effective, smarter — default)"
  echo ""
  read -p "  Enter 1 or 2 [2]: " choice
  case "${choice:-2}" in
    1) LLM_SIZE="2" ;;
    *) LLM_SIZE="4" ;;
  esac
fi

if [ "$LLM_SIZE" = "2" ]; then
  LLM_REPO="${LLM_REPO:-ggml-org/gemma-4-E2B-it-GGUF}"
  LLM_FILE="${LLM_FILE:-gemma-4-E2B-it-Q4_K_M.gguf}"
  LLM_LABEL="Gemma 4 E2B (2.3B)"
else
  LLM_REPO="${LLM_REPO:-ggml-org/gemma-4-E4B-it-GGUF}"
  LLM_FILE="${LLM_FILE:-gemma-4-E4B-it-Q4_K_M.gguf}"
  LLM_LABEL="Gemma 4 E4B (4.5B)"
fi
LLM_URL="https://huggingface.co/$LLM_REPO/resolve/main/$LLM_FILE"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

step()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }

# ── 1. Check / install llama.cpp ─────────────────────────────────────
step "Checking for llama-server..."

if command -v llama-server &>/dev/null; then
  ok "llama-server found: $(which llama-server)"
elif command -v brew &>/dev/null; then
  step "Installing llama.cpp via Homebrew..."
  brew install llama.cpp
  ok "llama.cpp installed"
else
  err "Homebrew not found. Install it first: https://brew.sh"
  echo "  Then run: brew install llama.cpp"
  exit 1
fi

# Check for whisper-server (comes with llama.cpp homebrew)
if ! command -v whisper-server &>/dev/null; then
  echo ""
  step "whisper-server not found (may need separate install)"

  if command -v brew &>/dev/null; then
    step "Trying: brew install whisper-cpp..."
    brew install whisper-cpp 2>/dev/null || {
      # whisper-cpp formula might not exist; build from source
      step "whisper-cpp brew unavailable — building from source..."
      WHISPER_DIR="$HOME/.everything/whisper.cpp"
      if [ ! -d "$WHISPER_DIR" ]; then
        git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
      fi
      cd "$WHISPER_DIR"
      make -j whisper-server
      ok "whisper-server built at $WHISPER_DIR/whisper-server"
      # Symlink into PATH
      mkdir -p "$HOME/.local/bin"
      ln -sf "$WHISPER_DIR/whisper-server" "$HOME/.local/bin/whisper-server"
      echo "  Added to ~/.local/bin — make sure it's in your PATH:"
      echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
      echo "  (add this to ~/.zshrc if you haven't)"
      cd - > /dev/null
    }
  else
    step "Building whisper.cpp from source..."
    WHISPER_DIR="$HOME/.everything/whisper.cpp"
    if [ ! -d "$WHISPER_DIR" ]; then
      git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
    fi
    cd "$WHISPER_DIR"
    make -j whisper-server
    mkdir -p "$HOME/.local/bin"
    ln -sf "$WHISPER_DIR/whisper-server" "$HOME/.local/bin/whisper-server"
    echo "  Added to ~/.local/bin — ensure it's in your PATH"
    cd - > /dev/null
  fi
fi

# ── 2. Download models ───────────────────────────────────────────────
echo ""
download_model() {
  local url="$1" dest="$2" label="$3" magic="$4"

  if [ -f "$dest" ]; then
    # Verify the file isn't corrupt (check magic bytes)
    if [ -n "$magic" ]; then
      local file_magic=$(xxd -l 4 -p "$dest" 2>/dev/null || echo "")
      if [ "$file_magic" = "$magic" ]; then
        local size=$(du -h "$dest" | cut -f1)
        ok "$label already exists ($size, verified)"
        return 0
      else
        err "$label exists but is corrupt (bad magic bytes) — re-downloading"
        rm -f "$dest"
      fi
    else
      local size=$(du -h "$dest" | cut -f1)
      ok "$label already exists ($size)"
      return 0
    fi
  fi

  step "Downloading $label..."
  echo "  from: $url"
  echo "  to:   $dest"

  # Try huggingface-cli first (more reliable, verifies integrity)
  if command -v huggingface-cli &>/dev/null; then
    step "Using huggingface-cli..."
    local repo=$(echo "$url" | sed -E 's|https://huggingface.co/([^/]+/[^/]+)/.*|\1|')
    local file=$(basename "$dest")
    if huggingface-cli download "$repo" "$file" --local-dir "$(dirname "$dest")" --local-dir-use-symlinks False 2>/dev/null; then
      local size=$(du -h "$dest" | cut -f1)
      ok "$label downloaded ($size)"
      return 0
    fi
    err "huggingface-cli failed, trying curl..."
  fi

  # Fallback to curl
  if curl -fL --progress-bar -o "$dest.tmp" "$url" 2>&1; then
    # Verify magic bytes if provided
    if [ -n "$magic" ]; then
      local file_magic=$(xxd -l 4 -p "$dest.tmp" 2>/dev/null || echo "")
      if [ "$file_magic" != "$magic" ]; then
        err "Downloaded file has wrong format (expected magic: $magic, got: $file_magic)"
        err "The model repo or filename may be incorrect. Try:"
        err "  huggingface-cli download $LLM_REPO --local-dir $MODELS_DIR"
        rm -f "$dest.tmp"
        return 1
      fi
    fi
    mv "$dest.tmp" "$dest"
    local size=$(du -h "$dest" | cut -f1)
    ok "$label downloaded ($size)"
  else
    err "Failed to download $label"
    err "Try manually: curl -L -o $dest '$url'"
    rm -f "$dest.tmp"
    return 1
  fi
}

# Download whisper model (no magic check needed for whisper)
download_model "$WHISPER_URL" "$MODELS_DIR/$WHISPER_FILE" "Whisper model" ""

# Download LLM model (GGUF magic bytes = 0x47475546 = "GGUF")
download_model "$LLM_URL" "$MODELS_DIR/$LLM_FILE" "$LLM_LABEL" "47475546"

# ── 3. Create convenience scripts ─────────────────────────────────────
step "Writing serve script..."

cat > scripts/serve.sh << 'SERVE_SCRIPT'
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
SERVE_SCRIPT

chmod +x scripts/serve.sh
ok "scripts/serve.sh created"

# ── Done ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo "  Models stored in: $MODELS_DIR"
echo ""
  echo "  Quick start:"
  echo "    Terminal 1:  npm run serve          (starts LLM + whisper servers)"
  echo "    Terminal 2:  npm start              (starts the diary app)"
  echo ""
  echo "  Switch model later:"
  echo "    MODEL=2 npm run setup               (use E2B instead of E4B)"
  echo "    MODEL=4 npm run setup               (switch back to E4B)"
  echo ""
  echo "  GGUF repos available at: https://huggingface.co/models?search=gemma-4-"
  echo ""
  echo "  Open: http://localhost:3456"
