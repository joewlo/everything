# Everything - Windows setup script
# Run: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
# Or right-click → Run with PowerShell

param(
  [string]$ModelsDir = "$env:USERPROFILE\.everything\models",
  [string]$BinDir = "$env:USERPROFILE\.everything\bin",
  [string]$LLMRepo = "",
  [string]$LLMFile = "",
  [string]$WhisperFile = "ggml-base.en.bin",
  [string]$Model = ""
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Everything - Windows Setup" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Download llama.cpp server ──────────────────────────────────────
Write-Host "→ Checking for llama-server..." -ForegroundColor Cyan

$llamaExe = "$BinDir\llama-server.exe"
$llamaDownloaded = Test-Path $llamaExe

if (-not $llamaDownloaded) {
  Write-Host "  Downloading llama.cpp Windows binary..." -ForegroundColor Gray

  # Fetch latest release info
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest" -ErrorAction Stop
    $asset = $release.assets | Where-Object {
      $_.name -match "win-x64" -and $_.name -notmatch "cuda" -and $_.name -endswith ".zip"
    } | Select-Object -First 1

    if ($asset) {
      Write-Host "  Found: $($asset.name)" -ForegroundColor Gray
      $tmpZip = "$env:TEMP\llama-cpp-win.zip"
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpZip
      Expand-Archive -Path $tmpZip -DestinationPath "$env:TEMP\llama-cpp-extract" -Force

      $serverExe = Get-ChildItem -Path "$env:TEMP\llama-cpp-extract" -Recurse -Filter "llama-server.exe" | Select-Object -First 1
      if ($serverExe) {
        Copy-Item $serverExe.FullName $llamaExe
        Write-Host "  ✓ llama-server.exe installed" -ForegroundColor Green
      } else {
        Write-Host "  ✗ Could not find llama-server.exe in the release package" -ForegroundColor Red
      }

      Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
      Remove-Item "$env:TEMP\llama-cpp-extract" -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      throw "No matching Windows binary found in release"
    }
  } catch {
    Write-Host "  ✗ Failed: $_" -ForegroundColor Red
    Write-Host "  Manual install: https://github.com/ggerganov/llama.cpp/releases/latest" -ForegroundColor Yellow
    Write-Host "  Download the win-x64 zip, extract llama-server.exe to: $BinDir" -ForegroundColor Yellow
  }
} else {
  Write-Host "  ✓ llama-server.exe already installed" -ForegroundColor Green
}

# ── 2. Download whisper.cpp server ────────────────────────────────────
Write-Host ""
Write-Host "→ Checking for whisper-server..." -ForegroundColor Cyan

$whisperExe = "$BinDir\whisper-server.exe"
if (-not (Test-Path $whisperExe)) {
  Write-Host "  Downloading whisper.cpp Windows binary..." -ForegroundColor Gray

  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest" -ErrorAction Stop
    $asset = $release.assets | Where-Object {
      $_.name -match "win.*64" -and $_.name -endswith ".zip"
    } | Select-Object -First 1

    if ($asset) {
      Write-Host "  Found: $($asset.name)" -ForegroundColor Gray
      $tmpZip = "$env:TEMP\whisper-cpp-win.zip"
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpZip
      Expand-Archive -Path $tmpZip -DestinationPath "$env:TEMP\whisper-cpp-extract" -Force

      $serverExe = Get-ChildItem -Path "$env:TEMP\whisper-cpp-extract" -Recurse -Filter "whisper-server.exe" | Select-Object -First 1
      if ($serverExe) {
        Copy-Item $serverExe.FullName $whisperExe
        Write-Host "  ✓ whisper-server.exe installed" -ForegroundColor Green
      } else {
        # whisper releases may include just whisper-cli.exe; server might be included or need separate build
        $cliExe = Get-ChildItem -Path "$env:TEMP\whisper-cpp-extract" -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
        if ($cliExe) {
          Write-Host "  ✗ whisper-server.exe not in release (only whisper-cli.exe found)" -ForegroundColor Yellow
          Write-Host "  whisper.cpp server may need to be built from source for Windows" -ForegroundColor Yellow
          Write-Host "  See: https://github.com/ggerganov/whisper.cpp" -ForegroundColor Yellow
        }
      }

      Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
      Remove-Item "$env:TEMP\whisper-cpp-extract" -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      throw "No matching Windows binary found in release"
    }
  } catch {
    Write-Host "  ✗ Failed: $_" -ForegroundColor Red
    Write-Host "  Manual install: https://github.com/ggerganov/whisper.cpp/releases/latest" -ForegroundColor Yellow
  }
} else {
  Write-Host "  ✓ whisper-server.exe already installed" -ForegroundColor Green
}

# ── 3. Choose model ───────────────────────────────────────────────────
Write-Host ""

if (-not $Model) {
  Write-Host "  Choose a model:" -ForegroundColor White
  Write-Host "    1) Gemma 4 E2B (2.3B effective, fast - best for laptops)" -ForegroundColor Gray
  Write-Host "    2) Gemma 4 E4B (4.5B effective, smarter - default)" -ForegroundColor Gray
  Write-Host ""
  $choice = Read-Host "  Enter 1 or 2 [2]"
  if ($choice -eq "1") { $Model = "2" } else { $Model = "4" }
}

if ($Model -eq "2") {
  if (-not $LLMRepo) { $LLMRepo = "ggml-org/gemma-4-E2B-it-GGUF" }
  if (-not $LLMFile) { $LLMFile = "gemma-4-E2B-it-Q4_K_M.gguf" }
  $LLMLabel = "Gemma 4 E2B (2.3B)"
} else {
  if (-not $LLMRepo) { $LLMRepo = "ggml-org/gemma-4-E4B-it-GGUF" }
  if (-not $LLMFile) { $LLMFile = "gemma-4-E4B-it-Q4_K_M.gguf" }
  $LLMLabel = "Gemma 4 E4B (4.5B)"
}

# ── 4. Download models ────────────────────────────────────────────────
Write-Host ""

function Download-Model {
  param([string]$Url, [string]$Dest, [string]$Label, [string]$Magic)

  if (Test-Path $Dest) {
    $size = "{0:N0}" -f ((Get-Item $Dest).Length / 1MB)
    Write-Host "  ✓ $Label already exists ($size MB)" -ForegroundColor Green
    return
  }

  Write-Host "→ Downloading $Label..." -ForegroundColor Cyan
  Write-Host "  from: $Url" -ForegroundColor Gray
  Write-Host "  to:   $Dest" -ForegroundColor Gray

  try {
    $tmpFile = "$Dest.tmp"
    Invoke-WebRequest -Uri $Url -OutFile $tmpFile -ErrorAction Stop

    # Verify GGUF magic bytes if needed
    if ($Magic) {
      $bytes = [System.IO.File]::ReadAllBytes($tmpFile)[0..3]
      $hex = ($bytes | ForEach-Object { $_.ToString("X2") }) -join ""
      if ($hex -ne $Magic) {
        throw "Invalid file format (expected magic $Magic, got $hex). The URL may be wrong."
      }
    }

    Move-Item $tmpFile $Dest -Force
    $size = "{0:N0}" -f ((Get-Item $Dest).Length / 1MB)
    Write-Host "  ✓ $Label downloaded ($size MB)" -ForegroundColor Green
  } catch {
    Write-Host "  ✗ Failed to download: $_" -ForegroundColor Red
    Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
  }
}

# Whisper model
$whisperUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WhisperFile"
Download-Model -Url $whisperUrl -Dest "$ModelsDir\$WhisperFile" -Label "Whisper model" -Magic ""

# LLM model
$llmUrl = "https://huggingface.co/$LLMRepo/resolve/main/$LLMFile"
Download-Model -Url $llmUrl -Dest "$ModelsDir\$LLMFile" -Label "$LLMLabel ($LLMRepo)" -Magic "47475546"

# ── 4. Create serve script ────────────────────────────────────────────
Write-Host ""
Write-Host "→ Writing serve.ps1..." -ForegroundColor Cyan

$serveScript = @'
# Everything - Start servers (Windows)
param(
  [string]$ModelsDir = "$env:USERPROFILE\.everything\models",
  [string]$BinDir = "$env:USERPROFILE\.everything\bin",
  [int]$LLMPort = 8080,
  [int]$WhisperPort = 8081,
  [string]$LLMFile = "gemma-4-E4B-it-Q4_K_M.gguf",
  [string]$WhisperFile = "ggml-base.en.bin"
)

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Starting Everything servers..." -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Start LLM server
$llmPath = "$BinDir\llama-server.exe"
if (Test-Path $llmPath) {
  if (Test-Path "$ModelsDir\$LLMFile") {
    Write-Host "→ LLM server on port $LLMPort" -ForegroundColor Green
    Write-Host "  Model: $LLMFile" -ForegroundColor Gray
    Start-Process -FilePath $llmPath -ArgumentList @(
      "--port", $LLMPort,
      "--model", "$ModelsDir\$LLMFile",
      "--ctx-size", "8192",
      "--n-gpu-layers", "99",
      "--host", "127.0.0.1"
    ) -NoNewWindow
    Write-Host "  Started" -ForegroundColor Green
  } else {
    Write-Host "✗ LLM model not found: $ModelsDir\$LLMFile" -ForegroundColor Red
    Write-Host "  Run: npm run setup" -ForegroundColor Yellow
  }
} else {
  Write-Host "✗ llama-server.exe not found: $llmPath" -ForegroundColor Red
  Write-Host "  Run: npm run setup" -ForegroundColor Yellow
}

Write-Host ""

# Start Whisper server
$whisperPath = "$BinDir\whisper-server.exe"
if (Test-Path $whisperPath) {
  if (Test-Path "$ModelsDir\$WhisperFile") {
    Write-Host "→ Whisper server on port $WhisperPort" -ForegroundColor Green
    Write-Host "  Model: $WhisperFile" -ForegroundColor Gray
    Start-Process -FilePath $whisperPath -ArgumentList @(
      "--port", $WhisperPort,
      "--model", "$ModelsDir\$WhisperFile",
      "--host", "127.0.0.1"
    ) -NoNewWindow
    Write-Host "  Started" -ForegroundColor Green
  } else {
    Write-Host "✗ Whisper model not found: $ModelsDir\$WhisperFile" -ForegroundColor Red
    Write-Host "  Run: npm run setup" -ForegroundColor Yellow
  }
} else {
  Write-Host "✗ whisper-server.exe not found: $whisperPath" -ForegroundColor Red
  Write-Host "  whisper.cpp may need to be built from source on Windows" -ForegroundColor Yellow
  Write-Host "  See: https://github.com/ggerganov/whisper.cpp" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "───────────────────────────────────────" -ForegroundColor Gray
Write-Host "  Servers started. Keep this window open." -ForegroundColor Gray
Write-Host "  Then start the app with: npm start" -ForegroundColor Gray
Write-Host "  Open: http://localhost:3456" -ForegroundColor Gray
Write-Host "───────────────────────────────────────" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop servers..." -ForegroundColor DarkYellow
try { while ($true) { Start-Sleep 1 } } catch { }
'@

$serveScript | Out-File -FilePath "$PSScriptRoot\serve.ps1" -Encoding UTF8
Write-Host "  ✓ scripts/serve.ps1 created" -ForegroundColor Green

# ── 5. Add bin dir to PATH hint ──────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Binaries: $BinDir" -ForegroundColor Gray
Write-Host "  Models:   $ModelsDir" -ForegroundColor Gray
Write-Host ""
Write-Host "  Add to your PATH (recommended):" -ForegroundColor Yellow
Write-Host "    [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$BinDir', 'User')" -ForegroundColor Gray
Write-Host ""
Write-Host "  Quick start:" -ForegroundColor White
Write-Host "    Terminal 1:  npm run serve:win      (starts LLM + whisper servers)" -ForegroundColor Gray
Write-Host "    Terminal 2:  npm start              (starts the diary app)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Open: http://localhost:3456" -ForegroundColor White
