# Zentect Dev Launcher
$ErrorActionPreference = "SilentlyContinue"
Set-Location "F:\Tools\Zentect"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Zentect Dev Environment Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "node_modules")) {
    Write-Host "[1/3] Installing dependencies..." -ForegroundColor Yellow
    npm install
} else {
    Write-Host "[1/3] Dependencies OK" -ForegroundColor Green
}

Write-Host "[2/3] Quick type check..." -ForegroundColor Yellow
$tscResult = & npx tsc --noEmit -p tsconfig.web.json 2>&1 | Select-String "error" | Measure-Object
if ($tscResult.Count -gt 0) {
    Write-Host "     [WARN] $($tscResult.Count) TypeScript errors (non-blocking)" -ForegroundColor DarkYellow
} else {
    Write-Host "     TypeScript OK" -ForegroundColor Green
}

Write-Host "[3/3] Starting dev server..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$env:ELECTRON_ENABLE_LOGGING = 1
npm run dev