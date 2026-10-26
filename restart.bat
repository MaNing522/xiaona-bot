@echo off
chcp 65001 >nul
title Xiaona QQ Bot Restart

rem ============================================================
rem  Xiaona QQ Bot: restart in background (no autostart)
rem
rem  1) stop the running launcher tree (start.js + SnowLuma + bot)
rem  2) remove the old logon task "XiaonaBot" if present
rem  3) start it again WITHOUT a console window
rem
rem  Must run elevated: the WebUI binds port 80, and the running
rem  bot is elevated too, so stopping it also needs admin.
rem
rem  IMPORTANT: keep this file ASCII-only and CRLF, same reason as
rem  ??.bat (non-ASCII + chcp 65001 makes cmd.exe abort mid-script).
rem ============================================================
if "%~1"=="elevated" goto elevated

fltmc >nul 2>&1
if not errorlevel 1 goto elevated

echo [restart] Requesting Administrator rights...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'elevated' -WorkingDirectory '%~dp0' -Verb RunAs"
if not errorlevel 1 exit /b
echo [restart] Elevation not granted, aborting.
pause
exit /b 1

:elevated
cd /d "%~dp0"

echo [restart] Stopping the current Xiaona (start.js process tree)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -match 'start\.js' -and $_.CommandLine -match 'QQBot' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }"

rem Also stop stray SnowLuma instances (manually started, or left over from an earlier run).
rem SnowLuma must bind the OneBot WS port (3001); if it is still held, the fresh instance
rem cannot bind and the bot keeps failing with ECONNREFUSED 127.0.0.1:3001.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { taskkill /PID $_.OwningProcess /T /F | Out-Null } }"

rem Give Windows a moment to release ports 80 / 3001
ping -n 5 127.0.0.1 >nul

echo [restart] Removing the old logon task (autostart disabled)...
schtasks /delete /tn "XiaonaBot" /f >nul 2>&1

echo [restart] Starting Xiaona in background (no console window)...
wscript.exe "%~dp0background.vbs"

echo [restart] Done. Check the web panel / logs for status.
timeout /t 3 >nul
exit /b 0
