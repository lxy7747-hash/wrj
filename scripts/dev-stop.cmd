@echo off
setlocal
chcp 65001 >nul
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
if not exist "%ROOT%\runtime\node.exe" (
  echo Bundled Node.js was not found. Extract this update into the Windows deployment folder first.
  pause
  exit /b 1
)
"%ROOT%\runtime\node.exe" --env-file="%ROOT%\app\.env.server" "%~dp0deploy-background.mjs" stop
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
endlocal & exit /b %EXIT_CODE%
