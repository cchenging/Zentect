# Zentect Dev Launcher
Set-Location $PSScriptRoot
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

Write-Host "[2/3] Type check (node + web)..." -ForegroundColor Yellow
$nodeErrors = & npx tsc --noEmit -p tsconfig.node.json 2>&1 | Select-String "error" | Measure-Object
$webErrors = & npx tsc --noEmit -p tsconfig.web.json 2>&1 | Select-String "error" | Measure-Object
$total = $nodeErrors.Count + $webErrors.Count
if ($total -gt 0) {
    Write-Host "     [WARN] $total TypeScript errors (dev can still start)" -ForegroundColor DarkYellow
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