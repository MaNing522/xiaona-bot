@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================
rem  push.bat - push the current branch to GitHub using the token
rem  stored in .env (which is git-ignored and never uploaded).
rem
rem  Usage:
rem    push.bat                 push current branch to its upstream
rem    push.bat origin main     push main to origin/main
rem    push.bat -u origin main  first-time push with upstream setup
rem
rem  The token is read from .env only. It is passed to git through a
rem  temporary HTTP header, so it is NOT written into .git/config and
rem  NOT shown in git output. Change the token by editing .env only.
rem ============================================================

if not exist ".env" (
  echo [ERROR] .env not found in %CD%
  exit /b 1
)

set "GH_TOKEN="
set "GH_REPO="
rem Read .env with findstr instead of: for /f ... in (".env")
rem cmd's for /f reads NOTHING from an LF-only file (the default line ending
rem of most editors), which shows up as a bogus "GITHUB_TOKEN is empty".
rem findstr matches both LF and CRLF files. /b anchors to the line start so a
rem commented-out variable with the same name is not picked up.
rem NOTE: keep this file ASCII-only. Chinese comments get mangled under the
rem OEM codepage and break the rem lines.
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "GITHUB_TOKEN= GITHUB_REPO=" ".env"`) do (
  if /i "%%a"=="GITHUB_TOKEN" set "GH_TOKEN=%%b"
  if /i "%%a"=="GITHUB_REPO" set "GH_REPO=%%b"
)

if "!GH_TOKEN!"=="" (
  echo [ERROR] GITHUB_TOKEN is empty in .env
  exit /b 1
)
if "!GH_REPO!"=="" (
  echo [ERROR] GITHUB_REPO is empty in .env
  exit /b 1
)

for /f "tokens=1 delims=/" %%o in ("!GH_REPO!") do set "GH_OWNER=%%o"

rem keep the remote URL clean (no embedded credentials)
git remote set-url origin "https://github.com/!GH_REPO!.git"

rem build the Basic auth header in a child process so the token stays
rem out of the command line, out of .git/config and out of the output
set "XN_USER=!GH_OWNER!"
set "XN_TOKEN=!GH_TOKEN!"
set "AUTHHDR="
for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "$u=$env:XN_USER; $t=$env:XN_TOKEN; $b=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($u+':'+$t)); Write-Output ('Authorization: Basic '+$b)"`) do set "AUTHHDR=%%h"

if "!AUTHHDR!"=="" (
  echo [ERROR] failed to build the auth header
  exit /b 1
)

set "XN_TOKEN="
git -c credential.helper= -c "http.https://github.com/.extraheader=!AUTHHDR!" push %*
set "RC=%ERRORLEVEL%"
set "AUTHHDR="

exit /b %RC%