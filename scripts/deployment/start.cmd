@echo off
rem Offline package launcher: uses the bundled Node runtime and reads deployment.env next to this file.
rem Console is switched to UTF-8 so the launcher's Chinese log and error messages render correctly.
chcp 65001 >nul
cd /d "%~dp0"
"%~dp0runtime\node\node.exe" "%~dp0frontend\scripts\start-deployment.mjs"
echo.
pause
