@echo off
rem Launch pi-config-gui straight from a source clone (Windows).
rem Builds on first run; subsequent runs rebuild only if dist is missing.
rem Any arguments are passed through to the CLI.
rem   Example:  launch.bat --agent-dir C:\Users\me\.pi\agent --port 8710
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 20 or newer is required but was not found on your PATH.
    echo Install it from https://nodejs.org and try again.
    exit /b 1
)

if not exist node_modules (
    echo First run: installing dependencies...
    call npm install
    if errorlevel 1 exit /b 1
)

if not exist dist\cli.js (
    echo Building...
    call npm run build
    if errorlevel 1 exit /b 1
)

node dist\cli.js %*
exit /b %errorlevel%
