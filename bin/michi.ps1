<#
.SYNOPSIS
    Launch or update the Michi desktop app on Windows.

.DESCRIPTION
    Equivalent of bin/michi for Windows. Builds the app on first run,
    then launches the Electron exe directly.

.PARAMETER Command
    update — pull latest code, rebuild, and relaunch.
    (none) — launch the app.

.EXAMPLE
    .\michi.ps1           # launch
    .\michi.ps1 update    # pull + rebuild + launch
    .\michi.ps1 --version # print version
#>
[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [string]$Command
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$INSTALL_DIR = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Log($msg) { Write-Host "[michi] $msg" }
function Fail($msg) { Write-Host "[michi] error: $msg" -ForegroundColor Red; exit 1 }

function Get-NodeMajor {
    try {
        $v = & node --version 2>$null
        if ($v -match '^v(\d+)') { return [int]$Matches[1] }
    } catch {}
    return 0
}

function Configure-BuildNode {
    # Check session Node first
    if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-NodeMajor) -ge 22) {
        return
    }

    # Try the locally installed Node from install.ps1
    $localNode = Get-ChildItem -Path (Join-Path $env:USERPROFILE ".michi" "tools") -Filter "node-*-win-x64" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($localNode) {
        $env:PATH = "$($localNode.FullName);$env:PATH"
        if ((Get-NodeMajor) -ge 22) { return }
    }

    Fail "Could not find Node.js 22+. Install it from https://nodejs.org/ or re-run install.ps1."
}

switch ($Command) {
    "--help" {
        Get-Help $MyInvocation.MyCommand.Path -Detailed
        exit 0
    }
    "-h" {
        Get-Help $MyInvocation.MyCommand.Path -Detailed
        exit 0
    }
    "--version" {
        $pkg = Get-Content (Join-Path $INSTALL_DIR "package.json") | ConvertFrom-Json
        Write-Host $pkg.version
        exit 0
    }
    "-v" {
        $pkg = Get-Content (Join-Path $INSTALL_DIR "package.json") | ConvertFrom-Json
        Write-Host $pkg.version
        exit 0
    }
    "update" {
        Log "Updating Michi..."
        Configure-BuildNode

        Push-Location $INSTALL_DIR
        try {
            # Find the upstream branch
            $remote = $null
            foreach ($cand in @("origin/main", "origin/master")) {
                $check = & git rev-parse --verify "refs/remotes/$cand" 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $remote = $cand
                    break
                }
            }
            if (-not $remote) { Fail "No supported release branch found." }

            $remoteName = $remote.Split("/")[0]
            & git fetch $remoteName --quiet

            # Safety: refuse if dirty
            $dirty = & git status --porcelain --untracked-files=no
            if ($dirty) {
                Fail "Uncommitted changes — commit or stash them first."
            }

            & git reset --hard $remote --quiet
            & npm.cmd ci --no-fund --no-audit --loglevel=error
            if ($LASTEXITCODE -ne 0) {
                & npm.cmd install --no-fund --no-audit --loglevel=error
            }
            & npm.cmd run electron:build
            if ($LASTEXITCODE -ne 0) { Fail "electron:build failed" }

            $hash = & git log -1 --format="%h %s"
            Log "Updated to $hash"
        } finally {
            Pop-Location
        }
        exit 0
    }
}

# Default: launch the app
$exePath = Join-Path $INSTALL_DIR "dist-electron" "win-unpacked" "michi.exe"

if (-not (Test-Path $exePath)) {
    Log "App not built yet — building..."
    Configure-BuildNode

    Push-Location $INSTALL_DIR
    try {
        & npm.cmd run electron:build
        if ($LASTEXITCODE -ne 0) { Fail "electron:build failed" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $exePath)) {
    Fail "Built exe not found at $exePath. Check the build output for errors."
}

Log "Launching Michi..."
Start-Process $exePath
