@echo off
chcp 65001 >nul
title 小钠 QQ 机器人启动器

rem ============================================================
rem  自动请求管理员权限：
rem  WebUI 默认监听 80 端口（HTTP 标准端口），Windows 上绑定
rem  1024 以下的端口需要管理员权限，否则会报 EACCES 启动失败。
rem  用 fltmc 判断当前是否已有管理员权限；没有就用 PowerShell
rem  的 Start-Process -Verb RunAs 弹 UAC，以管理员身份重新拉起本脚本。
rem  （已提升的实例会走 :elevated，不会再次弹 UAC。）
rem ============================================================
fltmc >nul 2>&1
if %errorlevel%==0 goto elevated

echo [启动] 正在请求管理员权限（WebUI 默认监听 80 端口，需要管理员）...
echo        若不需要管理员，可在 .env 里把 WEBUI_PORT 改成大于 1024 的端口。
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
if errorlevel 1 (
  echo [启动] 未获取到管理员权限（可能被取消），仍以普通权限启动；WebUI 端口若小于 1024 会失败。
  goto elevated
)
rem 已成功拉起管理员实例，本进程退出
exit /b

:elevated
cd /d "%~dp0"
node "%~dp0start.js"
pause
