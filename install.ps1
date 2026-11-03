<#
.SYNOPSIS
    Install the Michi desktop app on Windows.

.DESCRIPTION
    Clones (or updates) the Michi repository, ensures Node.js 22+ is available,
    installs npm dependencies, builds the Electron app, and creates a Start Menu
    shortcut. Re-run to update an existing installation.

.EXAMPLE
    # One-liner from the web:
    irm https://raw.githubusercontent.com/michiworks/Michi/main/install.ps1 | iex

    # Or saved locally with options:
    .\install.ps1

    # Override defaults via environment variables before piping:
    $env:MICHI_INSTALL_DIR = "C:\Projects\Michi"; irm ... | iex
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Configuration — override via environment variables before running.
$Dir         = if ($env:MICHI_INSTALL_DIR) { $env:MICHI_INSTALL_DIR } else { Join-Path $env:USERPROFILE "Michi" }
$Repo        = if ($env:MICHI_REPO_URL)    { $env:MICHI_REPO_URL }    else { "https://github.com/michiworks/Michi.git" }
$NodeVersion = if ($env:MICHI_NODE_VERSION) { $env:MICHI_NODE_VERSION } else { "22.21.1" }

# ── Helpers ──────────────────────────────────────────────────────────────────

function Log($msg) { Write-Host "[michi] $msg" }
function Fail($msg) { Write-Host "[michi] error: $msg" -ForegroundColor Red; exit 1 }

# ── Require git ──────────────────────────────────────────────────────────────

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git is not installed. Install it from https://git-scm.com/download/win"
}

# ── Ensure Node.js 22+ ──────────────────────────────────────────────────────

function Get-NodeMajor {
    try {
        $v = & node --version 2>$null
        if ($v -match '^v(\d+)') { return [int]$Matches[1] }
    } catch {}
    return 0
}

function Ensure-Node {
    if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-NodeMajor) -ge 22) {
        Log "using Node $(& node --version)"
        return
    }

    $toolsDir = Join-Path $env:USERPROFILE ".michi" "tools"
    $nodeName = "node-v${NodeVersion}-win-x64"
    $nodeDir  = Join-Path $toolsDir $nodeName
    $nodeExe  = Join-Path $nodeDir "node.exe"

    if (-not (Test-Path $nodeExe)) {
        $url     = "https://nodejs.org/dist/v${NodeVersion}/${nodeName}.zip"
        $archive = Join-Path $toolsDir "${nodeName}.zip"

        Log "downloading Node $NodeVersion for Windows x64"
        New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
        Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
        Expand-Archive -Path $archive -DestinationPath $toolsDir -Force
        Remove-Item $archive -Force
    }

    # Prepend to PATH for the rest of this session
    $env:PATH = "$nodeDir;$env:PATH"

    if ((Get-NodeMajor) -lt 22) {
        Fail "Node 22+ is still unavailable after installing to $nodeDir"
    }

    Log "using Node $(& node --version) from $nodeDir"
}

# ── Prepare checkout ─────────────────────────────────────────────────────────

function Prepare-Checkout {
    if (Test-Path (Join-Path $Dir ".git")) {
        Log "updating $Dir"
        $dirty = & git -C $Dir status --porcelain
        if ($dirty) {
            Fail "$Dir has local changes. Commit, stash, or choose another -Dir."
        }
        & git -C $Dir fetch origin main
        & git -C $Dir checkout main
        & git -C $Dir pull --ff-only origin main
        return
    }

    if (Test-Path $Dir) {
        Fail "$Dir exists but is not a Git checkout. Choose another -Dir."
    }

    Log "cloning $Repo into $Dir"
    & git clone $Repo $Dir
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed" }
}

# ── Build tools check ────────────────────────────────────────────────────────

function Ensure-BuildTools {
    # node-pty needs C++ compilation. Check for either:
    #   1. Visual Studio Build Tools (via vswhere)
    #   2. windows-build-tools npm package (legacy)
    # node-pty ships prebuilds for common Electron versions, so compilation
    # may not be needed — we attempt the build and fall back on the prebuild.

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vsInstall) {
            Log "Visual Studio Build Tools found at $vsInstall"
            return
        }
    }

    # Check if the prebuild exists (it's bundled in newer node-pty releases)
    Log "Visual Studio Build Tools not detected — node-pty will rely on prebuilt binaries"
    Log "If the build fails, install Build Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/"
}

# ── Create Start Menu shortcut ───────────────────────────────────────────────

function Create-Shortcut {
    $exePath = Join-Path $Dir "dist-electron" "win-unpacked" "michi.exe"
    if (-not (Test-Path $exePath)) {
        # NSIS installer produces a different layout; check for the installed exe
        $nsisExe = Get-ChildItem -Path (Join-Path $Dir "dist-electron") -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($nsisExe) {
            Log "NSIS installer produced: $($nsisExe.FullName)"
            Log "Run the installer to complete setup, or use it as a portable exe."
            return
        }
        Log "warning: built exe not found — skipping shortcut creation"
        return
    }

    $startMenu = Join-Path $env:APPDATA "Microsoft" "Windows" "Start Menu" "Programs"
    $shortcut  = Join-Path $startMenu "Michi.lnk"

    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($shortcut)
    $sc.TargetPath       = $exePath
    $sc.WorkingDirectory = $Dir
    $sc.Description      = "Michi — branching AI workspace"

    $iconPath = Join-Path $Dir "assets" "icons" "icon.ico"
    if (Test-Path $iconPath) {
        $sc.IconLocation = $iconPath
    }

    $sc.Save()
    Log "Start Menu shortcut created: $shortcut"
}

# ── Main ─────────────────────────────────────────────────────────────────────

Ensure-Node
Prepare-Checkout

Push-Location $Dir
try {
    Log "installing npm dependencies"
    & npm.cmd ci --no-fund --no-audit --loglevel=error
    if ($LASTEXITCODE -ne 0) {
        Log "npm ci failed, falling back to npm install"
        & npm.cmd install --no-fund --no-audit --loglevel=error
        if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }
    }

    Ensure-BuildTools

    Log "building the desktop app (this may take a few minutes)"
    & npm.cmd run electron:build
    if ($LASTEXITCODE -ne 0) { Fail "electron:build failed" }

    Create-Shortcut
} finally {
    Pop-Location
}

Log ""
Log "done! Michi has been built successfully."
Log ""
Log "Output directory: $(Join-Path $Dir 'dist-electron')"
Log ""

# Check what was produced
$installerExe = Get-ChildItem -Path (Join-Path $Dir "dist-electron") -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$unpackedExe  = Join-Path $Dir "dist-electron" "win-unpacked" "michi.exe"

if ($installerExe) {
    Log "Installer: $($installerExe.FullName)"
    Log "  Run the installer, or copy the exe to share it."
}
if (Test-Path $unpackedExe) {
    Log "Portable: $unpackedExe"
    Log "  You can run this directly without installing."
}
