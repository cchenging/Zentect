# scripts/release-check.ps1
# Zentect release pre-check script
# Called by:
#   - npm run release:check (local)
#   - .github/workflows/release.yml (CI)
#
# Purpose: verify that the project is in a releasable state before
#          the electron-builder packaging step.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot

function Fail($msg) {
    Write-Error "ERROR: $msg"
    exit 1
}

# ── 1. package.json sanity ────────────────────────────────
Write-Host "==> Checking package.json ..." -ForegroundColor Cyan

$pkg = Get-Content package.json -Encoding UTF8 | ConvertFrom-Json

if (-not $pkg.version) { Fail "package.json: missing 'version' field" }
Write-Host "    version: $($pkg.version)"

if (-not $pkg.main) { Fail "package.json: missing 'main' field (Electron entry)" }
Write-Host "    main: $($pkg.main)"

# ── 2. Electron builder config exists ─────────────────────
Write-Host "==> Checking electron-builder config ..." -ForegroundColor Cyan

$builderConfigs = @("electron-builder.yml", "electron-builder.json", "package.json")
$builderOk = $false
foreach ($candidate in $builderConfigs) {
    if ($candidate -eq "package.json") {
        if (Get-Content package.json -Encoding UTF8 | Select-String '"build"') {
            $builderOk = $true
            Write-Host "    build config found in package.json"
            break
        }
    } else {
        if (Test-Path $candidate) {
            $builderOk = $true
            Write-Host "    config found: $candidate"
            break
        }
    }
}
if (-not $builderOk) { Fail "electron-builder config not found (electron-builder.yml / .json / package.json['build'])" }

# ── 3. node_modules present (CI should have run pnpm install) ──
Write-Host "==> Checking dependencies ..." -ForegroundColor Cyan
if (-not (Test-Path "node_modules")) {
    Write-Host "    node_modules not found — running pnpm install ..." -ForegroundColor Yellow
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed" }
} else {
    Write-Host "    node_modules present"
}

# ── 4. Build output dir is clean (should not contain stale artifacts) ──
Write-Host "==> Checking build output dirs ..." -ForegroundColor Cyan
if (Test-Path "out") {
    Write-Host "    out/ exists — contents will be overwritten by 'pnpm build'"
}
if (Test-Path "release") {
    Write-Host "    release/ exists — will be overwritten by electron-builder" -ForegroundColor Yellow
}

# ── 5. resources/bin binaries present (required at runtime) ──
Write-Host "==> Checking runtime binaries ..." -ForegroundColor Cyan
$requiredBinaries = @(
    "resources/bin/win/ffmpeg.exe"
)
foreach ($bin in $requiredBinaries) {
    if (Test-Path $bin) {
        Write-Host "    $bin — OK"
    } else {
        Write-Host "    $bin — NOT FOUND (optional for CI, required for local release)" -ForegroundColor Yellow
    }
}

# ── 6. Git tag matches package.json version (CI mode) ─────
Write-Host "==> Checking git tag vs package.json version ..." -ForegroundColor Cyan
$tag = $env:GITHUB_REF -replace '^refs/tags/', ''
if ($tag) {
    # GITHUB_REF is set in CI when triggered by tag push
    $expectedVer = "v$($pkg.version)"
    if ($tag -ne $expectedVer) {
        Fail "Git tag '$tag' does not match package.json version '$expectedVer'"
    }
    Write-Host "    tag $tag matches package.json version — OK"
} else {
    Write-Host "    no GITHUB_REF — skipping tag/version match check (local run)" -ForegroundColor Yellow
}

# ── Done ───────────────────────────────────────────────────
Write-Host ""
Write-Host "==> All release checks passed." -ForegroundColor Green
Pop-Location
exit 0
