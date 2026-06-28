@echo off
cd /d "%~dp0"
echo Starting Zentect Dev...
set ELECTRON_ENABLE_LOGGING=1
npm run dev
pause