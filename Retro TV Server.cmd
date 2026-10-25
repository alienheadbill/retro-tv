@echo off
rem Double-click to share your drives without the TV: opens the Library window only.
cd /d "%~dp0"
if exist node_modules\electron\dist\electron.exe goto run
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo Retro TV needs Node.js, which isn't installed yet.
  echo Install the "LTS" version from nodejs.org, then double-click this file again.
  echo.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
echo First start: downloading what Retro TV needs. This takes a few minutes...
call npm install
if not exist node_modules\electron\dist\electron.exe (
  echo.
  echo The download didn't finish. Check the internet connection and try again.
  pause
  exit /b 1
)
:run
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --server
