@echo off
chcp 65001 >nul
title FunASR SenseVoice Server
cd /d "%~dp0"

rem ============================================================
rem  Local FunASR (SenseVoice) ASR server for the QQ bot.
rem  It serves the OpenAI-compatible endpoint used by asr.js:
rem      http://127.0.0.1:8899/v1/audio/transcriptions
rem
rem  Usage:  double-click this file, or run with a device arg:
rem      startASR.bat cuda    (NVIDIA GPU, much faster)
rem
rem  IMPORTANT: keep this file ASCII-only and CRLF. A .bat with
rem  non-ASCII (UTF-8) text plus "chcp 65001" makes cmd.exe lose
rem  its read position and abort mid-script.
rem ============================================================

set PORT=8899
set DEVICE=cpu
if not "%~1"=="" set DEVICE=%~1

where python >nul 2>&1
if errorlevel 1 (
  echo [ASR] Python not found in PATH. Please install Python 3.8+ first.
  echo [ASR] https://www.python.org/downloads/
  pause
  exit /b 1
)

echo [ASR] Checking dependencies: funasr / fastapi / uvicorn / python-multipart ...
python -c "import funasr, fastapi, uvicorn, multipart" >nul 2>&1
if errorlevel 1 (
  echo [ASR] Installing dependencies, this may take a few minutes ...
  python -m pip install -U funasr fastapi uvicorn python-multipart
  if errorlevel 1 (
    echo [ASR] pip install failed. Check your network or use a pip mirror, e.g.
    echo [ASR]   python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple funasr fastapi uvicorn python-multipart
    pause
    exit /b 1
  )
)

where funasr-server >nul 2>&1
if errorlevel 1 (
  echo [ASR] "funasr-server" not found. Try: python -m pip install -U funasr
  pause
  exit /b 1
)

echo [ASR] Starting FunASR server: port=%PORT% device=%DEVICE% model=sensevoice
echo [ASR] First run will download the SenseVoice model, please be patient ...
echo [ASR] Endpoint: http://127.0.0.1:%PORT%/v1/audio/transcriptions
echo.
funasr-server --host 127.0.0.1 --port %PORT% --model sensevoice --device %DEVICE%

echo.
echo [ASR] Server stopped.
pause
