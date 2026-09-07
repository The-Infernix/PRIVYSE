@echo off
REM ===========================================================================
REM SIH 26171 -- Ollama launcher tuned for a 4GB NVIDIA laptop GPU.
REM
REM Enables flash attention and quantizes the KV cache down to Q4_0. That
REM shrinks KV-cache RAM usage so more of the model's weights can fit onto the
REM GPU, which meaningfully cuts inference latency for qwen2.5vl:7b/3b.
REM
REM Ollama must be STOPPED before these env vars take effect. If a tray icon /
REM service is already running, quit it first, then run this script to start a
REM fresh, tuned instance.
REM ===========================================================================

set OLLAMA_FLASH_ATTENTION=1
set OLLAMA_KV_CACHE_QUANTITY=Q4_0
set OLLAMA_KEEP_ALIVE=-1
set OLLAMA_MAX_LOADED_MODELS=1

REM Optional: limit simultaneous parallel requests to avoid CPU/GPU thrash.
set OLLAMA_NUM_PARALLEL=1

REM Start Ollama in this console window. `ollama serve` keeps it in the
REM foreground; press Ctrl+C to stop. (Fallback app path is guessed below.)
where ollama >nul 2>nul
if %errorlevel%==0 (
  ollama serve %*
) else (
  echo ollama not found on PATH - start it from the installed location instead.
)