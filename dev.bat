@echo off
cd /d "%~dp0"
echo ========================================
echo   Zentect Dev Server
echo ========================================
echo Working dir: %cd%
echo.
call npm run dev
echo.
echo ========================================
echo Dev server stopped. Exit code: %errorlevel%
echo ========================================
pause