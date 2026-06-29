@echo off
REM ============================================================
REM Zentect dev launcher (cmd.exe) - launches electron-vite dev
REM with UTF-8 code page so Chinese log lines are readable.
REM
REM NOTE: Keep this file entirely ASCII to avoid cmd.exe
REM parsing it with the system default ANSI code page.
REM ============================================================

REM --- Switch console code page to UTF-8 ---
chcp 65001 >nul

REM --- Force libuv/Node to write stdout as UTF-8 on Windows ---
set NODE_FORCE_UTF8_STDOUT=1
set PYTHONIOENCODING=utf-8
set ELECTRON_ENABLE_LOGGING=1

REM --- Change to project root and start dev server ---
cd /d "%~dp0.."
node "node_modules\electron-vite\bin\electron-vite.js" dev
exit /b %ERRORLEVEL%
