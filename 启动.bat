@echo off
chcp 65001 >nul
title Xiaona QQ Bot Launcher

rem ============================================================
rem  Auto-elevate to Administrator.
rem  The WebUI listens on port 80 by default, and binding ports
rem  below 1024 on Windows requires Administrator (else EACCES).
rem
rem  IMPORTANT: keep this file ASCII-only and CRLF.
rem  A .bat containing non-ASCII (UTF-8) text together with
rem  "chcp 65001" makes cmd.exe lose its read position and abort
rem  mid-script -- that is exactly why elevation never ran before.
rem
rem  Passing the "elevated" argument means we are already elevated;
rem  it also prevents an endless re-launch loop.
rem ============================================================
if "%~1"=="elevated" goto elevated

fltmc >nul 2>&1
if not errorlevel 1 goto elevated

echo [launcher] Requesting Administrator rights (WebUI listens on port 80)...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'elevated' -WorkingDirectory '%~dp0' -Verb RunAs"
if not errorlevel 1 exit /b
echo [launcher] Elevation not granted, starting without admin; WEBUI_PORT < 1024 will fail.

:elevated
cd /d "%~dp0"
node "%~dp0start.js"
pause
