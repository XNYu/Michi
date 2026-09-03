@echo off
setlocal
set "INSTALL_DIR=%~dp0.."
cd /d "%INSTALL_DIR%"

if /I "%~1"=="--help" goto :help
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--version" goto :version
if /I "%~1"=="-v" goto :version
if /I "%~1"=="update" goto :update

set "EXE=%INSTALL_DIR%\dist-electron\win-unpacked\michi.exe"
if exist "%EXE%" (
  start "" "%EXE%"
  exit /b 0
)

echo App not built yet. Run: npm run electron:build
exit /b 1

:help
echo Usage: michi [--help] [--version] [update]
echo.
echo Commands:
echo   update    Pull latest code and reinstall dependencies
echo   ^(none^)    Launch the Michi desktop app
exit /b 0

:version
node -e "process.stdout.write(require('./package.json').version + '\n')"
exit /b 0

:update
echo Updating Michi...
git fetch origin --quiet
git pull --ff-only origin main
if exist package-lock.json (
  call npm ci --no-fund --no-audit --loglevel=error
) else (
  call npm install --no-fund --no-audit --loglevel=error
)
call npm run electron:build
exit /b %ERRORLEVEL%
