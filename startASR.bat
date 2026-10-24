@echo off
chcp 65001 >nul
title FunASR SenseVoice Server
cd /d "%~dp0"

rem ============================================================
rem  Local FunASR (SenseVoice) ASR server for the QQ bot.
rem  It serves the OpenAI-compatible endpoint used by asr.js:
rem      http://127.0.0.1:8899/v1/audio/transcriptions
rem
rem  It runs from the project-local venv "asr-venv", so the bot does
rem  not depend on the global Python. The launcher (start.js) starts
rem  this server automatically in the background; run this file only
rem  when you want to watch its logs in a console.
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

set "PYEXE=%~dp0asr-venv\Scripts\python.exe"
set "FSERVER=%~dp0asr-venv\Scripts\funasr-server.exe"

if not exist "%PYEXE%" (
  echo [ASR] venv not found: asr-venv
  echo [ASR] Create it once with the commands below, then retry:
  echo [ASR]   python -m venv asr-venv
  echo [ASR]   asr-venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  echo [ASR]   asr-venv\Scripts\python.exe -m pip install funasr fastapi uvicorn python-multipart -i https://pypi.tuna.tsinghua.edu.cn/simple
  pause
  exit /b 1
)

"%PYEXE%" -c "import funasr, fastapi, uvicorn, multipart" >nul 2>&1
if errorlevel 1 (
  echo [ASR] Installing dependencies, this may take a few minutes ...
  "%PYEXE%" -m pip install funasr fastapi uvicorn python-multipart -i https://pypi.tuna.tsinghua.edu.cn/simple
  if errorlevel 1 (
    echo [ASR] pip install failed. Check your network or try another mirror.
    pause
    exit /b 1
  )
)

if not exist "%FSERVER%" (
  echo [ASR] funasr-server not found in asr-venv. Reinstall funasr:
  echo [ASR]   asr-venv\Scripts\python.exe -m pip install -U funasr
  pause
  exit /b 1
)

echo [ASR] Starting FunASR server: port=%PORT% device=%DEVICE% model=sensevoice
echo [ASR] First run will download the SenseVoice model, please be patient ...
echo [ASR] Endpoint: http://127.0.0.1:%PORT%/v1/audio/transcriptions
echo.
"%FSERVER%" --host 127.0.0.1 --port %PORT% --model sensevoice --device %DEVICE%

echo.
echo [ASR] Server stopped.
pause
